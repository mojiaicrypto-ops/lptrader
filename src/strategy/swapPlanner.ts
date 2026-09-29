/**
 * §39-§41 swap planning and gates.
 *
 * This module is deliberately PURE: it turns a quote + config into an approve/reject verdict and
 * the exact RAW amounts that may be signed. It never touches an RPC, never encodes calldata and
 * never sends anything — the executors own those, and they must consult `planSwap` first.
 *
 * Two gates exist because the Pancake SmartRouter can only enforce ONE of them (research §4.2):
 *
 *   - slippage       → expressible on-chain (`amountOutMinimum`/`amountInMaximum`, and the
 *                      position's `amount0Min`/`amount1Min`). Passing it in is necessary but NOT
 *                      sufficient, because it is measured against the QUOTED price.
 *   - price impact   → NOT expressible. The SDK takes no such parameter, so if we do not compute
 *                      it here and refuse, a thinly-traded pool can move the market against us
 *                      inside the allowed slippage. Baseline §40 makes this a hard gate.
 *
 * All amounts in this file are RAW token units (§primitives UNITAGREEMENT).
 */
import type { PoolPriceView, SwapQuote } from '../types/adapters.ts';
import type { PositionPlan } from './positionPlanner.ts';
import type { IsoTimestamp, PriceUsd, Ratio, UsdAmount, Address } from '../types/primitives.ts';
import { applyFloorRatio, toFloat } from '../util/decimal.ts';

/** §40 defaults; always overridden by `StrategyConfig.swap`. */
export interface SwapLimits {
  /** §40 `max_slippage` (0.003). */
  readonly maxSlippage: Ratio;
  /** §40 `max_price_impact` (0.005). */
  readonly maxPriceImpact: Ratio;
  /** §41 `quote_ttl_seconds` (30) — the quote must still be fresh at decision time. */
  readonly quoteTtlSeconds: number;
  /**
   * §40 second tier: a price impact above this marks the POOL as a liquidity risk rather than
   * merely skipping this build.
   */
  readonly liquidityRiskPriceImpact: Ratio;
}

/** Outcome of the swap gate. `ok === false` ⇒ nothing may be signed (fail closed, §96). */
export interface SwapGateResult {
  readonly ok: boolean;
  /** Machine-readable reason codes, e.g. `quote_expired`, `price_impact_exceeded`. */
  readonly reasons: readonly string[];
  /** True when §40's second tier was crossed: the caller should flag the pool itself. */
  readonly poolLiquidityRisk: boolean;
  readonly priceImpact: Ratio;
  readonly slippageTolerance: Ratio;
}

/**
 * Evaluate a quote against the §40/§41 gates.
 *
 * `now` is injected so the decision is reproducible in tests and in replay (§77 DecisionLog).
 * An expired quote is a hard failure: §41 requires re-quoting rather than signing a stale price.
 */
export function evaluateSwapQuote(
  quote: SwapQuote,
  limits: SwapLimits,
  now: IsoTimestamp,
): SwapGateResult {
  const reasons: string[] = [];

  if (now >= quote.expiresAt) {
    reasons.push(
      `quote_expired: quotedAt=${quote.quotedAt} expiresAt=${quote.expiresAt} now=${now} ` +
        `(ttl=${limits.quoteTtlSeconds}s) — re-quote before signing (§41)`,
    );
  }

  if (!Number.isFinite(quote.priceImpact) || quote.priceImpact < 0) {
    reasons.push(`price_impact_unusable: ${String(quote.priceImpact)}`);
  } else if (quote.priceImpact > limits.maxPriceImpact) {
    reasons.push(
      `price_impact_exceeded: impact=${quote.priceImpact} > max=${limits.maxPriceImpact} (§40)`,
    );
  }

  if (!Number.isFinite(quote.slippageTolerance) || quote.slippageTolerance < 0) {
    reasons.push(`slippage_unusable: ${String(quote.slippageTolerance)}`);
  } else if (quote.slippageTolerance > limits.maxSlippage) {
    reasons.push(
      `slippage_exceeded: slippage=${quote.slippageTolerance} > max=${limits.maxSlippage} (§40)`,
    );
  }

  // A non-positive output can never be a valid swap (and would encode amountOutMinimum=0).
  if (quote.amountOutRaw <= 0n) {
    reasons.push(`amount_out_non_positive: ${quote.amountOutRaw.toString()}`);
  }

  // §40 second tier — reported even when the first gate already failed, so the pool gets flagged.
  const poolLiquidityRisk =
    Number.isFinite(quote.priceImpact) && quote.priceImpact > limits.liquidityRiskPriceImpact;

  return {
    ok: reasons.length === 0,
    reasons,
    poolLiquidityRisk,
    priceImpact: quote.priceImpact,
    slippageTolerance: quote.slippageTolerance,
  };
}

/**
 * The exact RAW amounts to sign for a build.
 *
 * §38: the swap amount comes from the concentrated-liquidity optimal ratio, never from a fixed
 * 50/50 split. `planPosition` already solved for the ratio; this function only turns it into
 * signable numbers and asserts the invariant that the swap covers precisely the deficit.
 */
export interface SwapIntent {
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  /** RAW amount to sell. */
  readonly amountInRaw: bigint;
  /** §40 `amountOutMinimum` derived from the quote and the configured tolerance. */
  readonly amountOutMinimumRaw: bigint;
  /** True when the plan needs no swap (the wallet already holds the right ratio). */
  readonly noSwapNeeded: boolean;
}

/** §37's three placements: inside the range, or pinned to one bound after a price move. */
export const RANGE_POSITIONS = {
  IN_RANGE: 'in-range',
  ABOVE_RANGE: 'above-range',
  BELOW_RANGE: 'below-range',
} as const;
export type RangePosition = (typeof RANGE_POSITIONS)[keyof typeof RANGE_POSITIONS];

/**
 * Classify where the current price sits relative to the planned range.
 *
 * The three cases behave differently at mint time (§37): in-range needs both tokens and therefore
 * a swap; above-range means the position is entirely token1; below-range entirely token0. Getting
 * this wrong is how a bot signs a swap it cannot use.
 */
export function classifyRange(position: Pick<PositionPlan, 'lowerPrice' | 'upperPrice'>, currentPrice: PriceUsd): RangePosition {
  if (currentPrice >= position.upperPrice) return RANGE_POSITIONS.ABOVE_RANGE;
  if (currentPrice <= position.lowerPrice) return RANGE_POSITIONS.BELOW_RANGE;
  return RANGE_POSITIONS.IN_RANGE;
}

/**
 * Derive the signable swap intent from a plan + a fresh quote.
 *
 * `amountOutMinimumRaw` is recomputed from the tolerance rather than trusting the quote's own
 * `amountOutMinimumRaw`, so a quote produced by a different caller cannot widen our bound.
 */
export function planSwapIntent(
  plan: PositionPlan,
  quote: SwapQuote,
  slippageTolerance: Ratio,
): SwapIntent {
  if (plan.swapNeeded === null) {
    return {
      tokenIn: quote.tokenIn,
      tokenOut: quote.tokenOut,
      amountInRaw: 0n,
      amountOutMinimumRaw: 0n,
      noSwapNeeded: true,
    };
  }

  const { tokenIn, tokenOut, amountIn } = plan.swapNeeded;

  if (quote.tokenIn.toLowerCase() !== tokenIn.toLowerCase()) {
    throw new Error(
      `swap intent mismatch: quote sells ${quote.tokenIn} but the plan requires selling ${tokenIn}`,
    );
  }
  if (quote.tokenOut.toLowerCase() !== tokenOut.toLowerCase()) {
    throw new Error(
      `swap intent mismatch: quote buys ${quote.tokenOut} but the plan requires buying ${tokenOut}`,
    );
  }

  const amountOutMinimumRaw = applyFloorRatio(quote.amountOutRaw, 1 - slippageTolerance);

  return {
    tokenIn,
    tokenOut,
    amountInRaw: amountIn,
    amountOutMinimumRaw,
    noSwapNeeded: false,
  };
}

/**
 * `floor(amount * (1 - tolerance))` in integer maths — BigInt so a 1-wei rounding choice is
 * explicit rather than a float artefact. The floor direction is the safe one for a minimum.
 */
/**
 * §40 price impact, computed locally. The SDK does not expose it as a usable bound (research
 * §4.2), so the executor must compute it from the quote and the pool mid price and refuse when
 * it exceeds the limit. `poolMidPrice` is `token1` per `token0` from `slot0()`.
 *
 * For a sell of `tokenIn` for `tokenOut` we compare the executed rate against the pool mid rate.
 * When the pool's token ordering is reversed relative to the trade we invert the mid price —
 * silently using the wrong orientation would understate impact by orders of magnitude on a
 * price that is far from 1.
 */
export function computePriceImpact(params: {
  readonly pool: Pick<PoolPriceView, 'priceToken1PerToken0' | 'poolId'>;
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly amountInRaw: bigint;
  readonly amountOutRaw: bigint;
  readonly tokenInDecimals: number;
  readonly tokenOutDecimals: number;
  readonly poolToken0: Address;
}): Ratio {
  if (params.amountInRaw <= 0n || params.amountOutRaw <= 0n) {
    throw new Error('computePriceImpact requires positive amounts');
  }

  // Orientation: is the trade selling pool token0, or token1?
  const sellingToken0 = params.poolToken0.toLowerCase() === params.tokenIn.toLowerCase();

  const mid = params.pool.priceToken1PerToken0; // token1 per token0
  if (!Number.isFinite(mid) || mid <= 0) {
    throw new Error(`unusable pool mid price for ${params.pool.poolId}: ${String(mid)}`);
  }

  const amountInFloat = toFloat(params.amountInRaw, params.tokenInDecimals);
  const amountOutFloat = toFloat(params.amountOutRaw, params.tokenOutDecimals);

  // Executed rate expressed the same way as `mid` (token1 per token0).
  const executed = sellingToken0 ? amountOutFloat / amountInFloat : amountInFloat / amountOutFloat;

  return Math.abs(executed - mid) / mid;
}

/** §18 `FeeAPR7D = fees7d / avgTvl7d * 365/7`. Returns `null` when the input cannot support it. */
export function computeFeeAprFromTotals(fees7d: UsdAmount, avgTvl7d: UsdAmount): Ratio | null {
  if (!Number.isFinite(fees7d) || !Number.isFinite(avgTvl7d)) return null;
  if (avgTvl7d <= 0) return null;
  return (fees7d / avgTvl7d) * (365 / 7);
}
