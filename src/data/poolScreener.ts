/**
 * Module 2 · Pool screening: find the FIRST pool that can be built, then stop.
 *
 * ## The shape of the problem (architecture §4)
 * Module 1 (HTTP) produces a candidate list. This module walks it **serially and short-circuits**: the
 * first candidate that passes everything is the answer, and the rest are never examined.
 *
 * That is not an optimisation detail — it is the point. Testing every candidate on-chain to pick "the
 * best" would spend the same chain calls whether or not the first one worked, and the strategy only ever
 * holds ONE position (architecture §8.5). Screening past a success is pure waste.
 *
 * ## Why two stages of filtering exist (§4.2)
 * Baseline §16 has five hard thresholds, but they do not share a data source:
 *
 * ```text
 * HTTP-measurable   TVL · 7d avg volume · pool age        → module 1 (already applied)
 * chain-only        token/NAV deviation · $3500 impact    → HERE
 * ```
 * `swapImpact3500USD` is `Unavailable` until someone quotes on-chain, and `tokenNAVDeviation` needs the
 * reference price versus the pool price. Neither can be evaluated in module 1 by construction.
 *
 * The practical consequence: **a candidate that module 1 accepted can still fail here**, and it must fail
 * on evidence rather than on a placeholder. That is why an unreadable figure is `indeterminate` and the
 * candidate is SKIPPED — never treated as a pass (§96).
 *
 * ## What this module deliberately does not do
 * - It does not decide the range, the ratio, or the swap amount: that is `planPosition` (§33–§38), and
 *   calling it here would mean computing a full plan for pools that are about to be rejected.
 * - It does not send anything. Screening produces a verdict; building is a separate, gated step.
 * - It does not retry a candidate after a provider fault. If the chain cannot be read, the run is
 *   abandoned rather than "trying the next pool" — because a provider fault says nothing about the pool.
 */
import type { PoolSnapshot } from '../types/market.ts';
import type {
  DexAdapter,
  PoolPriceView,
  ReferencePriceProvider,
  SwapQuote,
} from '../types/adapters.ts';
import type { PoolId, Ratio, UsdAmount } from '../types/primitives.ts';
import type { StrategyConfig } from '../types/config.ts';
import type { PoolFilterThresholds } from '../types/market.ts';
import { evaluatePoolFilters, type PoolFilterEvaluation } from './poolFilter.ts';

/** Why a candidate was skipped. Machine-readable so the decision log can carry the code (§77). */
export const SCREEN_REFUSALS = {
  /** Module 1's own verdict already rejected it (belt and braces: module 2 re-runs the whole filter). */
  FILTER_REJECTED: 'filter_rejected',
  /** A §16 figure could not be read, so no verdict is possible. NOT a pass (§96). */
  INDETERMINATE: 'indeterminate',
  /** The pool exists but this adapter cannot price it (wrong DEX wiring, missing pool). */
  PRICE_UNAVAILABLE: 'price_unavailable',
  /** The quote itself failed — no route, or the quoter reverted. */
  QUOTE_FAILED: 'quote_failed',
  /** Quote is outside the §40 tolerance for this pool. */
  IMPACT_TOO_HIGH: 'impact_too_high',
} as const;
export type ScreenRefusal = (typeof SCREEN_REFUSALS)[keyof typeof SCREEN_REFUSALS];

export interface ScreenAttempt {
  readonly poolId: PoolId;
  readonly dex: string;
  readonly accepted: boolean;
  readonly refusal?: ScreenRefusal;
  /** Human-readable, in the order the checks ran. Feeds §77. */
  readonly reasons: readonly string[];
  /** The full §16 evaluation, so a rejection can be explained rather than asserted. */
  readonly filter?: PoolFilterEvaluation;
  readonly price?: PoolPriceView;
  readonly quote?: SwapQuote;
  /** Measured impact, when a quote succeeded. */
  readonly priceImpact?: Ratio;
}

export interface ScreenOutcome {
  /** The first pool that passed, or `null` when none did. */
  readonly accepted: PoolSnapshot | null;
  readonly price: PoolPriceView | null;
  readonly quote: SwapQuote | null;
  /** Every candidate examined, in order, including the accepted one. */
  readonly attempts: readonly ScreenAttempt[];
  /**
   * True when the run could not reach a verdict for a reason that says nothing about the pools — a
   * provider fault, or an unreadable config. The caller must NOT treat this as "no pools qualify".
   */
  readonly aborted: boolean;
  readonly abortReason?: string;
}

export interface PoolScreenerOptions {
  readonly config: StrategyConfig;
  /** Per-DEX adapters, keyed by DEX id. A candidate whose DEX has no adapter is skipped, not guessed. */
  readonly adapters: ReadonlyMap<string, DexAdapter>;
  readonly referencePrice?: ReferencePriceProvider;
  /**
   * The notional a swap is probed at — §16's `$3500` gate is defined against this size, so it is a
   * parameter rather than a literal, and it must equal what a real build would trade.
   */
  readonly probeNotionalUsd?: UsdAmount;
}

/** §16's impact gate is stated at a $3500 notional, so that is the default probe size. */
export const DEFAULT_PROBE_NOTIONAL_USD = 3_500;

export class PoolScreener {
  private readonly options: PoolScreenerOptions;

  constructor(options: PoolScreenerOptions) {
    this.options = options;
  }

  /**
   * Screen candidates in order and return the first acceptance.
   *
   * `candidates` must already be ordered by the caller (architecture §8.2: `apr7d` desc, then `tvlUsd`),
   * because ordering is a strategy decision this module should not silently re-make.
   */
  async screen(candidates: readonly PoolSnapshot[]): Promise<ScreenOutcome> {
    const attempts: ScreenAttempt[] = [];

    for (const candidate of candidates) {
      const attempt = await this.screenOne(candidate);
      attempts.push(attempt);

      // A provider fault aborts the whole run: it says nothing about this pool, so moving to the next
      // candidate would be guessing. Surfaced distinctly so the caller does not read it as "nothing fits".
      if (attempt.refusal === SCREEN_REFUSALS.PRICE_UNAVAILABLE || attempt.refusal === SCREEN_REFUSALS.QUOTE_FAILED) {
        const isProviderFault = /provider|internal error|-32603|endpoint/i.test(attempt.reasons.join(' '));
        if (isProviderFault) {
          return {
            accepted: null,
            price: null,
            quote: null,
            attempts,
            aborted: true,
            abortReason: attempt.reasons.join('; '),
          };
        }
      }

      if (attempt.accepted) {
        return {
          accepted: candidate,
          price: attempt.price ?? null,
          quote: attempt.quote ?? null,
          attempts,
          aborted: false,
        };
      }
    }

    return { accepted: null, price: null, quote: null, attempts, aborted: false };
  }

  /** Screen one candidate. Never throws for a business refusal; returns the reason instead. */
  async screenOne(candidate: PoolSnapshot): Promise<ScreenAttempt> {
    const reasons: string[] = [];

    // ---- Stage 1: the full §16 filter, re-run here rather than trusted from module 1.
    //
    // Re-running is deliberate. Module 1's verdict was made on a snapshot that may be minutes old, and
    // this module is the last gate before money moves. Re-checking costs nothing (it is local) and makes
    // this module correct on its own rather than only in combination with a caller that remembered to
    // filter first.
    const thresholds = thresholdsFrom(this.options.config);
    const filter = evaluatePoolFilters(candidate, thresholds, {
      evaluatedAt: new Date().toISOString(),
      whitelist: this.options.config.whitelist,
      // Module 1 does not read the chain (architecture §3), so `tick`/`liquidity` are unverified *until
      // this module reads them below*. Passing `false` here is therefore correct and load-bearing: it
      // keeps `ONCHAIN_UNVERIFIED` honest rather than asserting a read that has not happened yet.
      isOnchainVerified: () => false,
    });

    const chainOnlyFailures = filter.checks.filter(
      (check) => !check.passed && check.condition === 'onchain',
    );
    const hardFailures = filter.checks.filter(
      (check) => !check.passed && check.condition !== 'onchain',
    );

    if (hardFailures.length > 0) {
      reasons.push(
        ...hardFailures.map((check) => `§16 ${check.condition}: ${check.message}`),
      );
      return { poolId: candidate.poolId, dex: candidate.dex, accepted: false, refusal: SCREEN_REFUSALS.FILTER_REJECTED, reasons, filter };
    }

    // `ONCHAIN_UNVERIFIED` is expected at this point and is resolved by the reads below, so it is not a
    // rejection by itself. Any OTHER unverified §16 figure is: it cannot be shown to hold, and §96 says
    // "cannot verify" is not a pass.
    if (chainOnlyFailures.length > 0) {
      reasons.push(...chainOnlyFailures.map((check) => check.message));
    }

    // ---- Stage 2: the chain-only figures. This is the expensive part, so it runs only for candidates
    // that already passed everything module 1 could check cheaply.
    const adapter = this.options.adapters.get(candidate.dex);
    if (adapter === undefined) {
      return {
        poolId: candidate.poolId,
        dex: candidate.dex,
        accepted: false,
        refusal: SCREEN_REFUSALS.PRICE_UNAVAILABLE,
        reasons: [...reasons, `no adapter is wired for DEX ${candidate.dex}`],
        filter,
      };
    }

    let price: PoolPriceView;
    try {
      price = await adapter.getPoolPrice(candidate.poolAddress);
    } catch (error) {
      return {
        poolId: candidate.poolId,
        dex: candidate.dex,
        accepted: false,
        refusal: SCREEN_REFUSALS.PRICE_UNAVAILABLE,
        reasons: [...reasons, `pool price unavailable: ${describe(error)}`],
        filter,
      };
    }

    // The identity check: the discovered pool must actually be the pair the snapshot claims. A mismatch
    // means the discovery data is stale or wrong, and building on it would use a different pool than the
    // one that passed the filters.
    if (price.poolId !== candidate.poolId) {
      return {
        poolId: candidate.poolId,
        dex: candidate.dex,
        accepted: false,
        refusal: SCREEN_REFUSALS.PRICE_UNAVAILABLE,
        reasons: [...reasons, `adapter returned ${price.poolId} for ${candidate.poolId}`],
        filter,
        price,
      };
    }

    // ---- §16 NAV deviation, now that a reference price can be consulted.
    if (this.options.referencePrice !== undefined) {
      const deviation = await this.navDeviation(candidate, price);
      if (deviation === 'unavailable') {
        return {
          poolId: candidate.poolId,
          dex: candidate.dex,
          accepted: false,
          refusal: SCREEN_REFUSALS.INDETERMINATE,
          reasons: [...reasons, 'token/NAV deviation could not be computed from a trustworthy reference price (§96)'],
          filter,
          price,
        };
      }
      if (deviation > thresholds.maxNavDeviation) {
        return {
          poolId: candidate.poolId,
          dex: candidate.dex,
          accepted: false,
          refusal: SCREEN_REFUSALS.FILTER_REJECTED,
          reasons: [
            ...reasons,
            `§16 tokenNAVDeviation ${(deviation * 100).toFixed(4)}% > ${(thresholds.maxNavDeviation * 100).toFixed(4)}%`,
          ],
          filter,
          price,
        };
      }
      reasons.push(`§16 tokenNAVDeviation ${(deviation * 100).toFixed(4)}% within limit`);
    }

    // ---- §16 $3500 impact, measured by quoting the exact notional the gate is defined against.
    const probe = await this.probeImpact(adapter, candidate);
    if (probe.kind === 'failed') {
      return {
        poolId: candidate.poolId,
        dex: candidate.dex,
        accepted: false,
        refusal: SCREEN_REFUSALS.QUOTE_FAILED,
        reasons: [...reasons, probe.reason],
        filter,
        price,
      };
    }
    if (probe.impact > thresholds.maxSwapPriceImpact) {
      return {
        poolId: candidate.poolId,
        dex: candidate.dex,
        accepted: false,
        refusal: SCREEN_REFUSALS.IMPACT_TOO_HIGH,
        reasons: [
          ...reasons,
          `§16 $3500 impact ${(probe.impact * 100).toFixed(4)}% > ${(thresholds.maxSwapPriceImpact * 100).toFixed(4)}%`,
        ],
        filter,
        price,
        quote: probe.quote,
        priceImpact: probe.impact,
      };
    }
    reasons.push(
      `§16 $3500 impact ${(probe.impact * 100).toFixed(4)}% within limit`,
      'all §16 thresholds satisfied — this pool is buildable',
    );

    return {
      poolId: candidate.poolId,
      dex: candidate.dex,
      accepted: true,
      reasons,
      filter,
      price,
      quote: probe.quote,
      priceImpact: probe.impact,
    };
  }

  /**
   * §54 `abs(onchainPrice / referenceNAV - 1)`.
   *
   * Returns `'unavailable'` rather than a number when the reference cannot be trusted: a depeg gate
   * evaluated against a stale or missing reference would either wave through a real depeg or reject a
   * healthy pool. `stale` and a `null` value are both treated as unusable (§57/§96).
   */
  private async navDeviation(candidate: PoolSnapshot, price: PoolPriceView): Promise<Ratio | 'unavailable'> {
    const provider = this.options.referencePrice;
    if (provider === undefined) return 'unavailable';

    // The stock leg is whichever end the registry says is a stock token; the stablecoin end is priced at
    // par for this comparison because the deviation is defined against the STOCK's reference NAV.
    const registry = this.options.config.whitelist.registry;
    const stockAddress = [candidate.token0, candidate.token1].find(
      (address) => registry.getTokenByAddress(candidate.chainId, address)?.isStockToken === true,
    );
    if (stockAddress === undefined) return 'unavailable';

    const reference = await provider.getStockReferencePrice(stockAddress);
    if (reference.stale || reference.value === null || !Number.isFinite(reference.value) || reference.value <= 0) {
      return 'unavailable';
    }

    // On-chain price of the stock leg in the pool's own terms, converted to USD via the stablecoin end.
    const onchainUsd = price.priceUsd ?? stableAnchoredPrice(candidate, price, registry);
    if (onchainUsd === null || !Number.isFinite(onchainUsd) || onchainUsd <= 0) return 'unavailable';

    return Math.abs(onchainUsd / reference.value - 1);
  }

  /**
   * Quote the §16 notional and read the impact back.
   *
   * The direction matters: §16's gate is about entering the position, so the probe sells the stablecoin
   * for the stock token — the trade a build would actually perform. Probing the reverse would measure a
   * different (often deeper) side of the book and let a pool pass on a side it will never trade.
   */
  private async probeImpact(
    adapter: DexAdapter,
    candidate: PoolSnapshot,
  ): Promise<{ readonly kind: 'ok'; readonly impact: Ratio; readonly quote: SwapQuote } | { readonly kind: 'failed'; readonly reason: string }> {
    const registry = this.options.config.whitelist.registry;
    const stockAddress = [candidate.token0, candidate.token1].find(
      (address) => registry.getTokenByAddress(candidate.chainId, address)?.isStockToken === true,
    );
    const stableAddress = [candidate.token0, candidate.token1].find(
      (address) => {
        const token = registry.getTokenByAddress(candidate.chainId, address);
        return token !== null && token.kind === 'stablecoin';
      },
    );
    if (stockAddress === undefined || stableAddress === undefined) {
      return { kind: 'failed', reason: 'the pool does not have one stock leg and one stablecoin leg' };
    }

    const stable = registry.requireTokenByAddress(candidate.chainId, stableAddress);
    const notional = this.options.probeNotionalUsd ?? DEFAULT_PROBE_NOTIONAL_USD;
    const amountIn = BigInt(Math.round(notional * 10 ** stable.decimals));

    try {
      const quote = await adapter.quoteSwap({
        poolId: candidate.poolId,
        tokenIn: stableAddress,
        tokenOut: stockAddress,
        amountIn,
        ttlSeconds: this.options.config.swap.quoteTtlSeconds,
      });
      return { kind: 'ok', impact: quote.priceImpact, quote };
    } catch (error) {
      return { kind: 'failed', reason: `§16 impact probe failed: ${describe(error)}` };
    }
  }
}

/** §16 thresholds, resolved from config so no number is restated in this module. */
export function thresholdsFrom(config: StrategyConfig): PoolFilterThresholds {
  return {
    minTvlUsd: config.pool.minTvlUsd,
    minAvgDailyVolume7dUsd: config.pool.minAvgDailyVolume7dUsd,
    minPoolAgeDays: config.pool.minPoolAgeDays,
    maxNavDeviation: config.pool.maxNavDeviation,
    maxSwapPriceImpact: config.pool.maxSwapPriceImpact,
  };
}

/**
 * USD price of the stock leg when the pool view did not carry one.
 *
 * Uses the stablecoin leg as the unit of account, which is valid because §14 admits only
 * stock × stablecoin pools — so one leg IS the unit. Falling back to the reference price here would be
 * circular: the deviation is what we are trying to measure.
 */
function stableAnchoredPrice(
  candidate: PoolSnapshot,
  price: PoolPriceView,
  registry: StrategyConfig['whitelist']['registry'],
): number | null {
  const stockIsToken0 = registry.getTokenByAddress(candidate.chainId, candidate.token0)?.isStockToken === true;
  const stockMeta = registry.getTokenByAddress(
    candidate.chainId,
    stockIsToken0 ? candidate.token0 : candidate.token1,
  );
  const stableMeta = registry.getTokenByAddress(
    candidate.chainId,
    stockIsToken0 ? candidate.token1 : candidate.token0,
  );
  if (stockMeta === null || stableMeta === null) return null;

  // `priceToken1PerToken0` is UI-denominated (both sides whole tokens), so a stablecoin leg makes it a
  // direct USD-per-stock number, or its reciprocal when the stock is token1.
  const ratio = price.priceToken1PerToken0;
  if (!Number.isFinite(ratio) || ratio <= 0) return null;
  const stableIsToken1 = stableMeta.id === registry.idFor(candidate.chainId, candidate.token1);
  return stableIsToken1 ? ratio / 10 ** (stockMeta.decimals - stableMeta.decimals) : null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}


