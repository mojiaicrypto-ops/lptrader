/**
 * §45 build orchestration: from "no position" to a signed-ready build request.
 *
 * ## Why this module exists
 *
 * `PoolScreener` could pick a pool, `planPosition` could compute the range and ratio, `evaluateSwapQuote`
 * could judge the quote, and `PositionExecutor` could build — and none of them called each other. The dry
 * run script assembled them by hand, which proved they *could* be connected but never that the runtime
 * connected them. In production the build path had zero call sites: the bot could screen, monitor and
 * exit, but it could not open a position.
 *
 * This is the missing link. It owns the ORDER, which is the part that was nobody's job:
 *
 * ```text
 * 1. screen        §16 hard filters + on-chain verification, first pool that passes, then STOP
 * 2. plan          §33–§38 range, tick alignment, optimal ratio, swap deficit
 * 3. quote         QuoterV2 for exactly the deficit the plan requires
 * 4. gates         §40 impact/slippage, §41 TTL, §3 allocation, §34 tick alignment
 * 5. hand off      a fully-formed BuildPositionInput for the executor (which asks for approval)
 * ```
 *
 * ## The ordering rule
 *
 * Cheap, local and non-bypassable checks come first; anything involving a human comes last. An operator
 * must never be asked to approve something the guard would have rejected anyway — that trains them to
 * approve without reading, which is worse than having no gate.
 *
 * ## Failure semantics
 *
 * Two refusals that look similar and are not:
 *   - `NO_QUALIFIED_POOL` — the screener reached a verdict: nothing passed. Normal, not an error.
 *   - `SCREEN_ABORTED` — the screener could NOT reach a verdict (provider fault, unreadable config).
 *     Reporting this as "no pool qualifies" would be a lie, and the operator would go looking for a pool
 *     problem that does not exist. It is surfaced separately and always.
 */
import type { PoolSnapshot } from '../types/market.ts';
import type { PoolPriceView, SwapQuote, TxGuardChecks } from '../types/adapters.ts';
import type { Address, IsoTimestamp, PoolId, Ratio, Tick, UsdAmount } from '../types/primitives.ts';
import type { StrategyConfig } from '../types/config.ts';
import type { TokenMeta } from '../types/token.ts';
import type { PositionPlan } from './positionPlanner.ts';
import type { BuildPositionInput } from '../execution/positionExecutor.ts';
import type { AllocationLimits } from './allocation.ts';
import { planPosition } from './positionPlanner.ts';
import { checkBuildAllocation } from './allocation.ts';
import { evaluateSwapQuote, planSwapIntent, swapLimitsForPool, computePriceImpact } from './swapPlanner.ts';
import { PoolScreener, type ScreenOutcome } from '../data/poolScreener.ts';

/** Every way a build can refuse before a transaction is constructed. */
export const BUILD_REFUSALS = {
  /** The screener reached a verdict and nothing passed. Not an error. */
  NO_QUALIFIED_POOL: 'NO_QUALIFIED_POOL',
  /** The screener could not reach a verdict. NOT the same as "nothing passed". */
  SCREEN_ABORTED: 'SCREEN_ABORTED',
  /** §3: the LP budget would breach the allocation bands. */
  ALLOCATION_REFUSED: 'ALLOCATION_REFUSED',
  /** The plan could not be computed (bad pool state, unsupported fee tier, …). */
  PLAN_FAILED: 'PLAN_FAILED',
  /** The venue could not quote the required swap. */
  QUOTE_FAILED: 'QUOTE_FAILED',
  /** §40/§41: the quote violates impact, slippage or TTL. */
  GATE_REFUSED: 'GATE_REFUSED',
  /** The pool's tokens are not resolvable to metadata, so the plan cannot be denominated. */
  TOKEN_METADATA_MISSING: 'TOKEN_METADATA_MISSING',
} as const;
export type BuildRefusalReason = (typeof BUILD_REFUSALS)[keyof typeof BUILD_REFUSALS];

export interface BuildRequest {
  /** Ready for `PositionExecutor.buildPosition`. */
  readonly input: BuildPositionInput;
  /** What was decided, for the operator-facing summary and §77. */
  readonly plan: PositionPlan;
  readonly quote: SwapQuote;
  readonly pool: PoolSnapshot;
  readonly price: PoolPriceView;
  /** Independent recomputation of the quote's impact, for the summary (§40 must not trust one source). */
  readonly recomputedImpact: Ratio;
  /** The pool that was chosen, and every candidate examined on the way. */
  readonly outcome: ScreenOutcome;
}

export interface BuildRefusal {
  readonly ok: false;
  readonly reason: BuildRefusalReason;
  readonly message: string;
  /** Present when the screener ran, so the operator can see WHICH pools failed and why. */
  readonly outcome?: ScreenOutcome;
}

export interface BuildReady {
  readonly ok: true;
  readonly request: BuildRequest;
}

export type BuildDecision = BuildReady | BuildRefusal;

/** What the orchestrator needs. Injected so this module owns no clients and stays testable. */
export interface BuildOrchestratorDeps {
  readonly config: StrategyConfig;
  readonly screener: PoolScreener;
  /** Token metadata by lowercased address. The whitelist registry answers this. */
  readonly tokenMeta: (address: Address) => TokenMeta | null;
  /** §40 per-swap limits and quote used the same way a live build would. */
  readonly quoteSwap: (request: {
    readonly poolId: PoolId;
    readonly tokenIn: Address;
    readonly tokenOut: Address;
    readonly amountIn: bigint;
    readonly ttlSeconds: number;
  }) => Promise<SwapQuote>;
  /** §95 pre-flight guard. The executor re-checks independently; this only avoids asking a human too early. */
  readonly guard: () => TxGuardChecks;
  readonly walletAddress: Address;
  /** Injected so a decision is reproducible in tests and replay (§77). */
  readonly now: () => IsoTimestamp;
}

/**
 * Turn a candidate list into a build request, or refuse with a reason.
 *
 * Does NOT ask for approval and does NOT send anything: the executor owns both, so there is exactly one
 * place where a transaction can come into being.
 */
export class BuildOrchestrator {
  private readonly deps: BuildOrchestratorDeps;

  constructor(deps: BuildOrchestratorDeps) {
    this.deps = deps;
  }

  /**
   * `navUsd` is the NAV the build is sized against — NOT a budget. The LP amount is derived from it via
   * `max_lp_ratio`, and the allocation check is then performed on the RESULTING state. Passing a budget
   * here instead would apply the ratio twice and refuse every build as a 100% allocation.
   */
  async prepare(candidates: readonly PoolSnapshot[], navUsd: UsdAmount): Promise<BuildDecision> {
    const { config } = this.deps;

    // ---- 1. Screen -------------------------------------------------------------------------------
    // The screener is the ONLY place allowed to read the chain, so it also answers §16's on-chain gates
    // (impact at the probe notional, tick alignment). It stops at the first pool that passes.
    const outcome = await this.deps.screener.screen(candidates);

    if (outcome.aborted) {
      // Distinguishing this from "nothing passed" is the whole point of the flag: the pools were never
      // judged, so their quality is unknown and the operator has a DATA problem, not a pool problem.
      return {
        ok: false,
        reason: BUILD_REFUSALS.SCREEN_ABORTED,
        message:
          `pool screening could not reach a verdict: ${outcome.abortReason ?? 'unknown provider fault'}. ` +
          'No pool was judged, so this says nothing about whether any would qualify.',
        outcome,
      };
    }

    const pool = outcome.accepted;
    const price = outcome.price;
    if (pool === null || price === null) {
      return {
        ok: false,
        reason: BUILD_REFUSALS.NO_QUALIFIED_POOL,
        message: this.noPoolMessage(outcome),
        outcome,
      };
    }

    // ---- 2. Plan ---------------------------------------------------------------------------------
    const token0 = this.deps.tokenMeta(pool.token0);
    const token1 = this.deps.tokenMeta(pool.token1);
    if (token0 === null || token1 === null) {
      return {
        ok: false,
        reason: BUILD_REFUSALS.TOKEN_METADATA_MISSING,
        message:
          `pool ${pool.poolId} uses tokens that are not in the whitelist registry ` +
          `(${pool.token0} / ${pool.token1}), so the position cannot be denominated or sized`,
        outcome,
      };
    }

    // §3: the LP amount is the budget derived from NAV, and the check is on the RESULTING allocation so
    // two individually-compliant builds cannot combine into an over-allocation.
    const lpCapital = navUsd * config.capital.maxLpRatio;
    const allocation = checkBuildAllocation({
      navUsd,
      currentLpValueUsd: 0,
      requestedUsd: lpCapital,
      limits: {
        maxLpRatio: config.capital.maxLpRatio,
        reserveRatio: config.capital.reserveRatio,
      } satisfies AllocationLimits,
    });
    if (!allocation.ok) {
      return {
        ok: false,
        reason: BUILD_REFUSALS.ALLOCATION_REFUSED,
        message: `§3 allocation refused: ${allocation.reason ?? 'outside the configured bands'}`,
        outcome,
      };
    }

    let plan: PositionPlan;
    try {
      plan = planPosition({
        pool: price,
        token0,
        token1,
        capitalUsd: lpCapital,
        lowerRatio: config.range.lowerRatio,
        upperRatio: config.range.upperRatio,
        referencePriceUsd: pool.stockReferencePrice.value,
      });
    } catch (error) {
      return {
        ok: false,
        reason: BUILD_REFUSALS.PLAN_FAILED,
        message: `§33–§38 plan failed: ${error instanceof Error ? error.message : String(error)}`,
        outcome,
      };
    }

    // ---- 3. Quote --------------------------------------------------------------------------------
    // The screener already quoted at the §16 probe notional to judge the pool. THIS quote is for the
    // amount the plan actually needs, so it is a second, differently-sized call — reusing the probe quote
    // here would apply a $3500 impact figure to a different trade size.
    // §38: when the plan needs no swap, the wallet already holds the right ratio. There is no swap to
    // quote, so the intent is a no-op and the mint takes the planned amounts directly.
    let buildQuote: SwapQuote;
    if (plan.swapNeeded === null) {
      buildQuote = this.noSwapQuote(pool);
    } else {
      try {
        buildQuote = await this.deps.quoteSwap({
          poolId: pool.poolId,
          tokenIn: plan.swapNeeded.tokenIn,
          tokenOut: plan.swapNeeded.tokenOut,
          amountIn: plan.swapNeeded.amountIn,
          ttlSeconds: config.swap.quoteTtlSeconds,
        });
      } catch (error) {
        return {
          ok: false,
          reason: BUILD_REFUSALS.QUOTE_FAILED,
          message: `could not quote the plan's swap: ${error instanceof Error ? error.message : String(error)}`,
          outcome,
        };
      }
    }

    // ---- 4. Gates --------------------------------------------------------------------------------
    const limits = swapLimitsForPool(pool.poolId, config);
    const now = this.deps.now();
    // §41 TTL is meaningless for a no-op quote, and evaluating it would refuse every build that needs no
    // swap — which is the common case when the wallet already holds the optimal ratio.
    const noSwap = plan.swapNeeded === null;
    const gate = noSwap ? { ok: true, reasons: [] as readonly string[] } : evaluateSwapQuote(buildQuote, limits, now);
    if (!gate.ok) {
      return {
        ok: false,
        reason: BUILD_REFUSALS.GATE_REFUSED,
        message: `§40/§41 gate refused: ${gate.reasons.join('; ')}`,
        outcome,
      };
    }

    // Independent recomputation. §40 must not rest on a single implementation: an inverted orientation or
    // a decimals mistake changes the impact by orders of magnitude, so a disagreement is a real defect
    // and must be surfaced rather than assumed away.
    const recomputedImpact = computePriceImpact({
      pool: price,
      tokenIn: buildQuote.tokenIn,
      tokenOut: buildQuote.tokenOut,
      amountInRaw: buildQuote.amountInRaw,
      amountOutRaw: buildQuote.amountOutRaw,
      tokenInDecimals: token0.address === buildQuote.tokenIn ? token0.decimals : token1.decimals,
      tokenOutDecimals: token0.address === buildQuote.tokenOut ? token0.decimals : token1.decimals,
      poolToken0: pool.token0,
    });

    const intent = planSwapIntent(plan, buildQuote, buildQuote.slippageTolerance);

    // ---- 5. Hand off -----------------------------------------------------------------------------
    return {
      ok: true,
      request: {
        input: {
          pool,
          capitalUsd: lpCapital,
          navUsd,
          currentLpValueUsd: 0,
          allocationLimits: {
            maxLpRatio: config.capital.maxLpRatio,
            reserveRatio: config.capital.reserveRatio,
          },
          walletAddress: this.deps.walletAddress,
          plan,
          quote: buildQuote,
          tickRange: {
            lowerTick: plan.lowerTick,
            upperTick: plan.upperTick,
            tickSpacing: price.tickSpacing,
          },
          // §40: the minimums come from the signed intent, so what the executor enforces is what the gate
          // approved — not a separately derived number that could drift from it.
          amount0MinRaw: this.minimumFor(token0.address, buildQuote, intent),
          amount1MinRaw: this.minimumFor(token1.address, buildQuote, intent),
          guard: this.deps.guard(),
          limits,
          deadline: { kind: 'previous-blockhash', blockhash: '0x' },
          idempotencyKey: `build:${pool.poolId}:${now}`,
          now,
        },
        plan,
        quote: buildQuote,
        pool,
        price,
        recomputedImpact,
        outcome,
      },
    };
  }

  /**
   * The quote for a plan that needs no swap (§38).
   *
   * A zero-valued quote rather than a fabricated market price: `planSwapIntent` already answers
   * `noSwapNeeded: true` for this case, so nothing downstream reads these numbers as a trade. Inventing a
   * plausible price here would be worse than an explicit zero, because a zero cannot be mistaken for a
   * real quote.
   */
  private noSwapQuote(pool: PoolSnapshot): SwapQuote {
    const at = this.deps.now();
    return {
      poolId: pool.poolId,
      tokenIn: pool.token0,
      tokenOut: pool.token1,
      amountInRaw: 0n,
      amountOutRaw: 0n,
      amountOutMinimumRaw: 0n,
      amountInUsd: 0,
      priceImpact: 0,
      slippageTolerance: 0,
      quotedAt: at,
      // Expires immediately, and that is correct: `planSwapIntent` returns `noSwapNeeded: true` for this
      // case, so nothing consumes it as a live trade. A future expiry would invite a caller to treat a
      // zero quote as a real one.
      expiresAt: at,
      route: [`${pool.poolId} (no swap required)`],
    };
  }

  /**
   * §40 minimum amount for one leg.
   *
   * The leg that is BOUGHT gets the quote's slippage floor; the leg that is not swapped is supplied from
   * the wallet at exactly the planned amount, so its minimum is the plan's own figure. Using the swap
   * minimum for both would under-protect the unswapped leg; using the plan for both would ignore slippage.
   */
  private minimumFor(leg: Address, quote: SwapQuote, intent: ReturnType<typeof planSwapIntent>): bigint {
    if (quote.tokenOut.toLowerCase() !== leg.toLowerCase()) return 0n;
    return intent.noSwapNeeded === true ? 0n : intent.amountOutMinimumRaw;
  }

  /** Operator-facing explanation of a screening failure, naming each candidate and its first reason. */
  private noPoolMessage(outcome: ScreenOutcome): string {
    if (outcome.attempts.length === 0) {
      return 'no candidate pools were available to screen (the scan found none, or all were filtered out)';
    }
    const lines = outcome.attempts
      .slice(0, 5)
      .map((attempt) => `  ${attempt.poolId}: ${attempt.refusal ?? 'refused'} — ${attempt.reasons[0] ?? ''}`);
    const more = outcome.attempts.length > 5 ? `\n  … and ${outcome.attempts.length - 5} more` : '';
    return `no pool passed the hard filters. ${outcome.attempts.length} examined:\n${lines.join('\n')}${more}`;
  }
}

/** Tick type is re-exported so callers composing a plan never import from two places. */
export type { Tick };
