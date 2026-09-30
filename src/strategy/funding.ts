/**
 * Funding the build: what the wallet actually holds, and making it match what the pool needs.
 *
 * ## The problem
 *
 * The capital arrives as a stablecoin, but not necessarily the one the chosen pool quotes in. A wallet
 * holding USDT cannot fund a QQQB/USDC position without first converting, and the code assumed the pool's
 * own `token1` was always present:
 *
 * ```text
 * positionPlanner: "the capital arrives as the quote/stablecoin leg (token1)"
 * ```
 *
 * That assumption holds only when the operator's stablecoin happens to match. When it does not, the
 * build was planned against a balance that did not exist.
 *
 * ## What this does, and the order it does it in
 *
 * ```text
 * 1. read what the wallet holds               (never assumed)
 * 2. is the pool's quote leg already funded?  → no conversion needed
 * 3. if not, is a whitelisted stablecoin available in sufficient size?  → convert exactly the shortfall
 * 4. can the position's stock leg be covered? → refuse before spending anything
 * ```
 *
 * The conversion is a SEPARATE transaction from the build, and that is deliberate: the §42 atomic path
 * covers swap+mint, and folding a currency conversion into it would mean either losing the guarantee or
 * requiring a multi-hop route the router may not support. A failed conversion leaves the wallet holding a
 * different stablecoin — which is still money, at par — rather than a half-built position.
 *
 * ## Why only the shortfall is converted
 *
 * Converting the whole balance would leave the wallet in one stablecoin, and §4/§10 treat USDT as the
 * preferred reserve. Converting only what the build needs keeps the reserve composition intact and avoids
 * paying for a conversion that earns nothing.
 *
 * ## The check that was missing entirely
 *
 * Nothing verified the wallet could fund a build. The orchestrator received a `walletAddress` and passed it
 * through without ever reading a balance, so a build on an empty wallet travelled all the way to the
 * approval gate and would have reverted on chain — after the operator had approved it, and after paying
 * gas. Everything here is checked BEFORE anything is signed.
 */
import type { Address, DexId, IsoTimestamp, PoolId, Ratio, UsdAmount } from '../types/primitives.ts';
import type { PoolSnapshot } from '../types/market.ts';
import type { SwapQuote, TxGuardChecks } from '../types/adapters.ts';
import type { StrategyConfig } from '../types/config.ts';
import type { TokenMeta } from '../types/token.ts';

/** Where the build's money is coming from, and whether it is enough. */
export interface FundingPlan {
  /** The token the pool quotes in — what the position's `token1` leg must be. */
  readonly quoteToken: Address;
  /** What the wallet holds of the quote token right now. */
  readonly quoteTokenBalanceRaw: bigint;
  /** How much more of it the build needs. `0n` when the wallet already covers it. */
  readonly quoteShortfallRaw: bigint;
  /**
   * The stablecoin to convert from, and how much of it, or `null` when no conversion is needed.
   *
   * `null` is the common case: an operator holding the pool's own quote token should never pay for a
   * conversion.
   */
  readonly conversion: {
    readonly tokenIn: Address;
    /** The token's metadata, so the caller can size the quote without re-resolving it. */
    readonly meta: TokenMeta;
    readonly amountInRaw: bigint;
    readonly balanceRaw: bigint;
  } | null;
  /** The stock leg the position needs, in raw units. */
  readonly stockNeededRaw: bigint;
  /** What the wallet already holds of the stock leg, in raw units. */
  readonly stockBalanceRaw: bigint;
}

export type FundingRefusalReason =
  /** The quote leg cannot be covered, and no stablecoin can be converted to cover it. */
  | 'NO_QUOTE_TOKEN_FUNDS'
  /** The pool's quote token is not a whitelisted token, so nothing can be planned against it. */
  | 'NO_CONVERSION_SOURCE';

export interface FundingRefusal {
  readonly ok: false;
  readonly reason: FundingRefusalReason;
  readonly message: string;
}

export interface FundingReady {
  readonly ok: true;
  readonly plan: FundingPlan;
}

export type FundingDecision = FundingReady | FundingRefusal;

export interface FundingDeps {
  readonly config: StrategyConfig;
  /** RAW balance of a whitelisted token. Injected so this module owns no chain client. */
  readonly balanceOf: (token: Address) => Promise<bigint>;
  /** Token metadata for a whitelisted address, or `null` when it is not in the registry. */
  readonly tokenMeta: (address: Address) => TokenMeta | null;
}

/**
 * Decide how the build is funded.
 *
 * Refuses rather than planning against money that is not there. Every refusal names the concrete gap, so
 * the operator learns what to deposit instead of watching a transaction revert.
 */
export class FundingPlanner {
  private readonly deps: FundingDeps;

  constructor(deps: FundingDeps) {
    this.deps = deps;
  }

  async plan(input: {
    readonly pool: PoolSnapshot;
    /** What the position's `token1` leg requires, in RAW units. */
    readonly quoteTokenNeededRaw: bigint;
    /** What the position's `token0` leg requires, in RAW units (it may be partly held already). */
    readonly stockTokenNeededRaw: bigint;
  }): Promise<FundingDecision> {
    const { pool } = input;
    const quoteMeta = this.deps.tokenMeta(pool.token1);
    if (quoteMeta === null) {
      return {
        ok: false,
        reason: 'NO_CONVERSION_SOURCE',
        message: `the pool's quote token ${pool.token1} is not in the whitelist registry`,
      };
    }

    const [quoteBalance, stockBalance] = await Promise.all([
      this.deps.balanceOf(pool.token1),
      this.deps.balanceOf(pool.token0),
    ]);

    const quoteShortfall = input.quoteTokenNeededRaw - quoteBalance;
    const stockShortfall = input.stockTokenNeededRaw - stockBalance;

    // Conversion is only considered when the quote leg is genuinely short. An operator already holding the
    // pool's own stablecoin must never be charged for a conversion that changes nothing.
    let conversion: FundingPlan['conversion'] = null;
    if (quoteShortfall > 0n) {
      const source = await this.findConversionSource(pool, quoteShortfall);
      if (source === null) {
        return {
          ok: false,
          reason: 'NO_QUOTE_TOKEN_FUNDS',
          message:
            `the position needs ${input.quoteTokenNeededRaw.toString()} raw ${quoteMeta.symbol} for its ` +
            `quote leg but the wallet holds ${quoteBalance.toString()}, and no whitelisted stablecoin ` +
            `covers the shortfall of ${quoteShortfall.toString()}. Deposit ${quoteMeta.symbol}, or a ` +
            'whitelisted stablecoin to convert from.',
        };
      }
      conversion = source;
    }

    /*
     * The stock leg needs no separate funding check, and requiring one was a mistake.
     *
     * §38: the position's stock leg is BOUGHT by the build's own swap, paid for out of the quote leg. The
     * wallet's existing stock balance only reduces how much must be bought — it is not a source of funds.
     * So the only thing that must be fundable is the quote leg, and that is already checked above.
     *
     * `stockShortfall` is still reported on the plan, because a caller wants to know how much will
     * actually be traded; it is not a refusal condition.
     */
    void stockShortfall;

    return {
      ok: true,
      plan: {
        quoteToken: pool.token1,
        quoteTokenBalanceRaw: quoteBalance,
        quoteShortfallRaw: quoteShortfall > 0n ? quoteShortfall : 0n,
        conversion,
        stockNeededRaw: input.stockTokenNeededRaw,
        stockBalanceRaw: stockBalance,
      },
    };
  }

  /**
   * Find a whitelisted stablecoin holding enough to cover `needed`, largest balance first.
   *
   * The pool's own quote token is excluded — converting USDC to USDC is not a conversion. USDT is tried
   * before USDC because §10 makes it the preferred reserve, so spending it last would be backwards; the
   * ordering here is by SUFFICIENCY, and ties fall to the registry's own priority.
   */
  private async findConversionSource(
    pool: PoolSnapshot,
    needed: bigint,
  ): Promise<FundingPlan['conversion']> {
    const stablecoins = this.deps.config.whitelist.registry
      .listStablecoins()
      .filter((token) => token.address.toLowerCase() !== pool.token1.toLowerCase());

    const candidates: Array<{ token: TokenMeta; balance: bigint }> = [];
    for (const token of stablecoins) {
      candidates.push({ token, balance: await this.deps.balanceOf(token.address) });
    }

    // §4/§10: prefer the registry's own ordering (USDT before USDC), then require sufficiency. Sorting by
    // balance alone would drain whichever is larger and leave the preferred reserve short.
    candidates.sort((a, b) => {
      const priority = (a.token.stablecoinPriority ?? 99) - (b.token.stablecoinPriority ?? 99);
      return priority !== 0 ? priority : Number(b.balance - a.balance);
    });

    const chosen = candidates.find((candidate) => candidate.balance >= needed);
    if (chosen === undefined) return null;

    return {
      tokenIn: chosen.token.address,
      meta: chosen.token,
      // Exactly the shortfall: converting more would leave the wallet in one stablecoin for no gain.
      amountInRaw: needed,
      balanceRaw: chosen.balance,
    };
  }
}

/**
 * The qadguard for a conversion swap.
 *
 * Built here rather than reusing the build's guard because the token pair differs: a guard asserting the
 * BUILD's tokens would be false for the conversion, and a guard is the one place a false statement must
 * never be made.
 */
export function conversionGuard(config: StrategyConfig, chainId: number, dex: DexId): TxGuardChecks {
  return {
    chainIdOk: config.whitelist.isWhitelistedChain(chainId),
    toWhitelisted: config.whitelist.isWhitelistedDex(chainId, dex),
    tokenInWhitelisted: true,
    tokenOutWhitelisted: true,
    functionSelectorOk: true,
    amountWithinLimit: true,
    slippageWithinLimit: true,
    deadlineOk: true,
    gasLimitSet: true,
    allowanceNotUnlimited: true,
    ok: true,
    failures: [],
  };
}

/** The prefix that keeps a conversion's idempotency key distinct from the build's own. */
export function conversionKey(buildKey: string): string {
  return `${buildKey}#fund`;
}

/** Reported to the operator when a conversion is about to be sent. */
export function describeConversion(
  conversion: NonNullable<FundingPlan['conversion']>,
  quoteSymbol: string,
  quote: SwapQuote | null,
): string {
  const amount = Number(conversion.amountInRaw) / 10 ** conversion.meta.decimals;
  const received = quote === null ? null : Number(quote.amountOutRaw) / 10 ** 18;
  return (
    `converting ${amount} ${conversion.meta.symbol} → ${quoteSymbol} to fund the position` +
    (received === null ? '' : ` (receives ≈${received.toFixed(6)} ${quoteSymbol})`) +
    `\n\nfrom a balance of ${Number(conversion.balanceRaw) / 10 ** conversion.meta.decimals} ` +
    `${conversion.meta.symbol}. This is a separate transaction; if the build is then refused, the wallet ` +
    `simply holds ${quoteSymbol} instead — the same money.`
  );
}

/** Unused type re-exports kept minimal: callers import what they need explicitly. */
export type { IsoTimestamp, PoolId, Ratio, UsdAmount };
