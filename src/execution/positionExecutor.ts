/**
 * §39-§43 build / exit orchestration.
 *
 * This is the only component that decides whether a transaction may be sent, and it gates on four
 * independent conditions. All four must pass, in this order:
 *
 *   1. **§95 transaction guard** — `TxGuardChecks.ok`. The adapter refuses anyway, but the executor
 *      must not even attempt to encode a transaction it already knows is invalid.
 *   2. **§44/§58/§60/§66 write gate** — `checkWriteAllowed(state, action)`. A read-only state sends
 *      nothing; a `NO_NEW_CAPITAL` state may still exit and collect, but must not commit new capital.
 *   3. **§40/§41 swap gate** — `evaluateSwapQuote`. Impact and quote freshness are checked BEFORE
 *      encoding, because the on-chain slippage bound is measured against the quoted price and
 *      therefore cannot protect against a stale or illiquid quote (research §4.2).
 *   4. **Approval gate** (user decision D2) — `BUILD_POSITION` and `SWITCH_POOL` are released only by
 *      a persisted, human-approved request. If the channel is unavailable the action does not run;
 *      there is no "degrade to automatic" path.
 *
 * Everything that mutates is idempotent (§97) through `TxStore`: the intent is persisted before the
 * send, keyed on a caller-supplied `idempotencyKey`, and a second execution of the same key is
 * refused rather than re-sent. A §43 partial (swap landed, add-liquidity did not) parks the bot in
 * `PARTIAL_POSITION` and is never auto-completed.
 */
import type {
  AddLiquidityRequest,
  CollectFeesRequest,
  DexAdapter,
  RemoveLiquidityRequest,
  SwapExecutionRequest,
  SwapQuote,
  TxGuardChecks,
} from '../types/adapters.ts';
import type { PoolSnapshot } from '../types/market.ts';
import type { BotState } from '../types/state.ts';
import type { Address, Hash, IsoTimestamp, PoolId, Tick, UsdAmount } from '../types/primitives.ts';
import type { ApprovalGate, GateOutcome } from './approvalGate.ts';
import type { TxStore } from '../store/txStore.ts';
import type { StateMachine } from '../strategy/stateMachine.ts';
import { APPROVAL_KINDS } from '../types/notifier.ts';
import { SWAP_PURPOSES, type LpPositionView } from '../types/adapters.ts';
import { silentLogger, type Logger } from '../util/logger.ts';
import { BSC_ADDRESSES } from '../config/builtins.ts';
import { renderRows, usd } from '../notify/messageFormat.ts';
import { checkBuildAllocation, type AllocationLimits } from '../strategy/allocation.ts';
import { checkWriteAllowed, WRITE_ACTIONS } from '../strategy/stateMachine.ts';
import { evaluateSwapQuote, planSwapIntent, type SwapLimits } from '../strategy/swapPlanner.ts';
import type { PositionPlan } from '../strategy/positionPlanner.ts';
import { canOpenNewAttempt, RAW_TX_FORMATS, TX_PURPOSES } from '../store/txStore.ts';

/** §5.3.1: the stablecoin the strategy settles into. U = USDT (§10 preferred reserve). */
const DEFAULT_U_TOKEN = BSC_ADDRESSES.USDT as Address;

/** A build refuses for a named reason; it never throws for a business refusal. */
export const BUILD_REFUSALS = {
  GUARD_FAILED: 'tx_guard_failed',
  ALLOCATION_EXCEEDED: 'allocation_exceeded',
  WRITE_BLOCKED: 'write_blocked_by_state',
  QUOTE_REJECTED: 'swap_gate_rejected',
  APPROVAL_DENIED: 'approval_denied',
  ALREADY_EXECUTED: 'idempotency_key_already_used',
  ADAPTER_FAILED: 'adapter_failed',
  /** The post-swap wallet cannot fund the mint (§5.3.3 refusal path). */
  POST_SWAP_SHORTFALL: 'post_swap_shortfall',
} as const;
export type BuildRefusal = (typeof BUILD_REFUSALS)[keyof typeof BUILD_REFUSALS];

export interface BuildPositionInput {
  readonly pool: PoolSnapshot;
  /**
   * LP capital to commit. Must be produced by `lpBudgetUsd(nav, limits)` — §3 caps LP at
   * `max_lp_ratio × NAV`, and `navUsd`/`currentLpValueUsd` below exist so the executor can verify the
   * RESULTING allocation rather than trusting that this number was derived correctly.
   */
  readonly capitalUsd: UsdAmount;
  /** NAV the allocation is judged against (§3). */
  readonly navUsd: UsdAmount;
  /** LP value already deployed; the cap applies to the total, not to this increment alone. */
  readonly currentLpValueUsd: UsdAmount;
  /** §3 allocation limits, read from config; passed in so the executor restates no constant. */
  readonly allocationLimits: AllocationLimits;
  readonly walletAddress: Address;
  /** Output of `planPosition` — the §38 optimal ratio, already computed from the live price. */
  readonly plan: PositionPlan;
  /** Fresh quote for exactly the swap the plan requires. */
  readonly quote: SwapQuote;
  readonly tickRange: { readonly lowerTick: Tick; readonly upperTick: Tick; readonly tickSpacing: number };
  /** §40 slippage-derived minimums for the add-liquidity leg (RAW). */
  readonly amount0MinRaw: bigint;
  readonly amount1MinRaw: bigint;
  readonly guard: TxGuardChecks;
  readonly limits: SwapLimits;
  readonly deadline: SwapExecutionRequest['deadline'];
  readonly idempotencyKey: string;
  readonly now: IsoTimestamp;
}

/** What actually happened. `partial` is set when only part of the intent landed (§43). */
export interface ExecutionOutcome {
  readonly ok: boolean;
  readonly refusal?: BuildRefusal;
  readonly reason: string;
  /** Set when a transaction was sent. */
  readonly swapTxHash?: Hash;
  readonly addLiquidityTxHash?: Hash;
  readonly positionTokenId?: bigint;
  /** §43: the operation must not be retried automatically. */
  readonly partial?: {
    readonly completedSteps: readonly string[];
    readonly failedStep: string;
    readonly reason: string;
  };
  /** §77 audit row ids / the approval request id, when one was involved. */
  readonly approvalRequestId?: string;
}

export interface PositionExecutorDeps {
  readonly dex: DexAdapter;
  readonly txStore: TxStore;
  readonly stateMachine: StateMachine;
  readonly approvalGate: ApprovalGate;
  /** Current bot state; injected so the executor never caches a stale gate verdict. */
  readonly currentState: () => BotState;
  /**
   * §40 limits for the exit-conversion swaps. Absent (legacy wiring / read-only builds) the exit
   * still removes liquidity but CANNOT convert the legs — the outcome then says so explicitly with
   * the residual balances, instead of silently violating §5.3.2.
   */
  readonly swapLimits?: (poolId: PoolId) => SwapLimits;
  /** §41 TTL for the exit-conversion quotes. */
  readonly quoteTtlSeconds?: number;
  /** Where the build narrates its steps. Silent unless the composition root supplies one. */
  readonly logger?: Logger;
}

/**
 * Executes a position build.
 *
 * Atomic vs two-step is a property of the venue: PancakeSwap's SmartRouter can carry
 * swap+add-liquidity in one transaction, the plain V3 router cannot (its `multicall` is a
 * self-delegatecall). The executor does not care which — it asks the adapter and interprets the
 * result, because the partial-failure semantics differ and §43 is the reason this distinction has
 * to be visible.
 */
export class PositionExecutor {
  /** Legs cached from the position read at the START of an exit — the burn erases them. */
  private exitLegs: LpPositionView | null = null;
  private readonly deps: PositionExecutorDeps;
  private readonly log: Logger;

  constructor(deps: PositionExecutorDeps) {
    this.deps = deps;
    this.log = deps.logger ?? silentLogger;
  }

  /**
   * §39 build. The order of the checks is deliberate: cheap, local, and non-bypassable first;
   * anything involving a human last, so an operator is never asked to approve something the guard
   * would have rejected anyway.
   */
  async buildPosition(input: BuildPositionInput): Promise<ExecutionOutcome> {
    this.log.info('execute', 'build requested', {
      poolId: input.pool.poolId,
      capitalUsd: input.capitalUsd,
      navUsd: input.navUsd,
      atomic: this.deps.dex.supportsAtomicBuild,
      idempotencyKey: input.idempotencyKey,
    });

    const guard = this.checkGuard(input.guard);
    if (guard !== null) return guard;

    const gate = this.checkState(WRITE_ACTIONS.SWAP_BUILD);
    if (gate !== null) return gate;

    // §3: the LP cap applies to the TOTAL allocation, so two individually-compliant builds must not be
    // able to breach the ratio together. Checked before the quote so an over-budget build never reaches
    // the point of being quoted or approved.
    const allocation = checkBuildAllocation({
      navUsd: input.navUsd,
      currentLpValueUsd: input.currentLpValueUsd,
      requestedUsd: input.capitalUsd,
      limits: input.allocationLimits,
    });
    if (!allocation.ok) {
      return {
        ok: false,
        refusal: BUILD_REFUSALS.ALLOCATION_EXCEEDED,
        reason: `allocation refused: ${allocation.reason ?? 'unspecified'}`,
      };
    }

    const quoteVerdict = evaluateSwapQuote(input.quote, input.limits, input.now);
    if (!quoteVerdict.ok) {
      return {
        ok: false,
        refusal: BUILD_REFUSALS.QUOTE_REJECTED,
        reason: `swap gate rejected the quote: ${quoteVerdict.reasons.join('; ')}`,
      };
    }

    // §38: the swap amount comes from the concentrated-liquidity solution, never a fixed split.
    const intent = planSwapIntent(input.plan, input.quote, input.quote.slippageTolerance);

    const request = await this.deps.approvalGate.request(APPROVAL_KINDS.BUILD_POSITION, {
      summary: this.describeBuild(input, intent.amountInRaw),
      json: {
        poolId: input.pool.poolId,
        chainId: input.pool.chainId,
        dex: input.pool.dex,
        capitalUsd: input.capitalUsd,
        entryPrice: input.pool.currentPrice.value,
        lowerPrice: input.plan.lowerPrice,
        upperPrice: input.plan.upperPrice,
        lowerTick: input.plan.lowerTick,
        upperTick: input.plan.upperTick,
        liquidity: input.plan.liquidity.toString(),
        amount0Raw: input.plan.amount0.toString(),
        amount1Raw: input.plan.amount1.toString(),
        swapAmountInRaw: intent.amountInRaw.toString(),
        swapTokenIn: intent.tokenIn,
        swapTokenOut: intent.tokenOut,
        amountOutMinimumRaw: intent.amountOutMinimumRaw.toString(),
        priceImpact: input.quote.priceImpact,
        slippageTolerance: input.quote.slippageTolerance,
        maxPriceImpact: input.limits.maxPriceImpact,
        idempotencyKey: input.idempotencyKey,
      },
    });

    // `request()` returns null when the channel could not even publish the request. Nothing has been
    // created and nothing may run — refusing here is the §96 behaviour, and it is why the executor
    // treats a null request as a denial rather than retrying.
    if (request === null) {
      return {
        ok: false,
        refusal: BUILD_REFUSALS.APPROVAL_DENIED,
        reason:
          'not executed — no approval request could be created (approval channel unavailable); ' +
          'fail closed, no build was attempted',
      };
    }

    const outcome = await this.deps.approvalGate.gate(APPROVAL_KINDS.BUILD_POSITION, request.id, () =>
      this.runBuild(input),
    );

    return this.fromGateOutcome(outcome, request.id);
  }

  /** §71-style exit. Only a `REMOVE_LIQUIDITY`-class write, so it can run from RISK_REVIEW. */
  async exitPosition(input: {
    readonly poolId: PoolId;
    readonly positionTokenId: bigint;
    readonly liquidityRaw: bigint | null;
    readonly amount0MinRaw: bigint;
    readonly amount1MinRaw: bigint;
    readonly recipient: Address;
    readonly deadline: RemoveLiquidityRequest['deadline'];
    readonly guard: TxGuardChecks;
    readonly idempotencyKey: string;
  }): Promise<ExecutionOutcome> {
    const guard = this.checkGuard(input.guard);
    if (guard !== null) return guard;

    const gate = this.checkState(WRITE_ACTIONS.REMOVE_LIQUIDITY);
    if (gate !== null) return gate;

    const duplicate = this.checkIdempotencyKey(input.idempotencyKey);
    if (duplicate !== null) return duplicate;
    // The legs are read while the position still exists — after a full exit the NFT is burned and
    // nothing on chain remembers which tokens it held.
    this.exitLegs = await this.deps.dex.getPosition(input.positionTokenId).catch(() => null);


    this.deps.txStore.recordIntended(
      {
        idempotencyKey: input.idempotencyKey,
        chainId: this.deps.dex.chainId,
        purpose: TX_PURPOSES.REMOVE_LIQUIDITY,
        rawTx: JSON.stringify({
          kind: 'removeLiquidity',
          poolId: input.poolId,
          positionTokenId: input.positionTokenId.toString(),
          liquidityRaw: input.liquidityRaw === null ? 'all' : input.liquidityRaw.toString(),
        }),
        rawTxFormat: RAW_TX_FORMATS.CALL_REQUEST,
      },
      input.guard,
    );

    try {
      const result = await this.deps.dex.removeLiquidity({
        poolId: input.poolId,
        positionTokenId: input.positionTokenId,
        liquidityRaw: input.liquidityRaw,
        amount0MinRaw: input.amount0MinRaw,
        amount1MinRaw: input.amount1MinRaw,
        recipient: input.recipient,
        deadline: input.deadline,
        idempotencyKey: input.idempotencyKey,
        guard: input.guard,
      });
      this.deps.txStore.markSubmitted(input.idempotencyKey, result.txHash);
      if (result.partial !== undefined) {
        return {
          ok: false,
          reason: `remove liquidity partially executed: ${result.partial.reason}`,
          partial: {
            completedSteps: result.partial.completedSteps,
            failedStep: result.partial.failedStep,
            reason: result.partial.reason,
          },
        };
      }

      /*
       * 撤池后必须回到纯 U (§5.3.2): the removal credited token0 + token1 + fees to the wallet;
       * every non-U leg is converted here, each swap confirmed before the next read.
       */
      return this.convertProceedsToU(input);
    } catch (error) {
      return this.adapterFailure(input.idempotencyKey, error);
    }
  }

  /**
   * The second act of an exit: sell whatever is not U (§5.3.2), in the position's own pool — the
   * market that just priced the legs is the market to unwind them in.
   *
   * Each conversion is an independently idempotent swap (`<exitKey>#convert<n>`): a crash between
   * leg conversions must not re-sell a leg that already sold (§97). When the composition root did
   * not wire §40 limits, this is not a silent skip — the outcome reports the residual balances.
   */
  private async convertProceedsToU(input: {
    readonly poolId: PoolId;
    readonly positionTokenId: bigint;
    readonly idempotencyKey: string;
    readonly guard: TxGuardChecks;
    readonly deadline: RemoveLiquidityRequest['deadline'];
    readonly recipient: Address;
  }): Promise<ExecutionOutcome> {
    const legs = await this.poolLegs(input);
    if (legs === null) {
      return {
        ok: false,
        reason:
          'liquidity removed, but the proceeds could not be identified (the position record was ' +
          'already burned and no leg metadata was supplied); the wallet is NOT back to pure U',
        partial: {
          completedSteps: ['removeLiquidity'],
          failedStep: 'convertToU',
          reason: 'position metadata unavailable after the burn; legs unknown',
        },
      };
    }

    const limits = this.deps.swapLimits?.(input.poolId);
    const convertTo = DEFAULT_U_TOKEN;
    const ttl = this.deps.quoteTtlSeconds ?? 30;
    let convertIndex = 0;
    const converted: Address[] = [];

    for (const leg of legs) {
      if (leg.address.toLowerCase() === convertTo.toLowerCase()) continue;
      const held = await this.deps.dex.getTokenBalance(leg.address, input.recipient);
      // Dust below a hundredth of a whole unit is not worth a swap; a larger residual violates §5.3.2.
      const DUST = 10n ** BigInt(Math.max(leg.decimals - 4, 0)); // 0.0001 units (for a ~$300 token, ≈$0.03)
      if (held <= DUST) continue;

      if (limits === undefined) {
        return {
          ok: false,
          reason:
            `liquidity removed, but no swap limits were wired for the exit conversion, so the ` +
            `${leg.address} proceeds (${held.toString()} raw) were NOT converted to ${convertTo}; ` +
            'the wallet is NOT back to pure U (§5.3.2)',
          partial: {
            completedSteps: ['removeLiquidity'],
            failedStep: 'convertToU',
            reason: 'swapLimits not injected into PositionExecutor',
          },
        };
      }

      const quote = await this.deps.dex.quoteSwap({
        poolId: input.poolId,
        tokenIn: leg.address,
        tokenOut: convertTo,
        amountIn: held,
        ttlSeconds: ttl,
      });
      this.log.info('exit', 'quoting the exit conversion', {
        token: leg.address,
        amountIn: held.toString(),
        out: quote.amountOutRaw.toString(),
        impact: quote.priceImpact,
      });
      const gate = evaluateSwapQuote(quote, limits, new Date().toISOString());
      if (!gate.ok) {
        return {
          ok: false,
          reason:
            `exit conversion quote rejected (§40/§41): ${gate.reasons.join('; ')} — the ` +
            `${leg.address} proceeds are still in the wallet`,
          partial: {
            completedSteps: ['removeLiquidity'],
            failedStep: 'convertToU',
            reason: gate.reasons.join('; '),
          },
        };
      }

      const convertKey = `${input.idempotencyKey}#convert${convertIndex}`;
      convertIndex += 1;
      this.deps.txStore.recordIntended(
        {
          idempotencyKey: convertKey,
          chainId: this.deps.dex.chainId,
          purpose: TX_PURPOSES.SWAP,
          rawTx: JSON.stringify({
            kind: 'convertToU',
            poolId: input.poolId,
            tokenIn: leg.address,
            tokenOut: convertTo,
            amountInRaw: held.toString(),
            amountOutMinimumRaw: quote.amountOutMinimumRaw.toString(),
          }),
          rawTxFormat: RAW_TX_FORMATS.CALL_REQUEST,
          attempt: 1,
        },
        input.guard,
      );

      const swap = await this.deps.dex.executeSwap({
        quote,
        deadline: input.deadline,
        purpose: SWAP_PURPOSES.EXIT_POSITION,
        idempotencyKey: convertKey,
        guard: input.guard,
      });
      this.deps.txStore.markSubmitted(convertKey, swap.txHash);
      converted.push(leg.address);
    }

    // Post-verify: non-U balances must be dust (§5.3.2 is a state, not a claim).
    const leftovers: Array<{ readonly token: Address; readonly balanceRaw: bigint }> = [];
    for (const leg of legs) {
      if (leg.address.toLowerCase() === convertTo.toLowerCase()) continue;
      const held = await this.deps.dex.getTokenBalance(leg.address, input.recipient);
      const DUST = 10n ** BigInt(Math.max(leg.decimals - 4, 0)); // 0.0001 units (for a ~$300 token, ≈$0.03)
      if (held > DUST) leftovers.push({ token: leg.address, balanceRaw: held });
    }
    if (leftovers.length > 0) {
      return {
        ok: false,
        reason:
          `liquidity removed and conversions were sent, but the wallet still holds non-U legs: ` +
          leftovers.map((l) => `${l.token} ${l.balanceRaw.toString()}`).join(', '),
        partial: {
          completedSteps: ['removeLiquidity', ...converted.map(() => 'convertToU')],
          failedStep: 'verifyPureU',
          reason: leftovers.map((l) => `${l.token} ${l.balanceRaw.toString()}`).join(', '),
        },
      };
    }

    return {
      ok: true,
      reason:
        converted.length === 0
          ? 'liquidity removed; proceeds were already pure U'
          : 'liquidity removed and proceeds converted to U (§5.3.2)',
    };
  }

  /**
   * Legs of the position's pool, cached from the position read at the START of the exit — a full
   * exit burns the NFT, and afterwards nothing on chain remembers which tokens it held.
   */
  private async poolLegs(input: {
    readonly poolId: PoolId;
    readonly positionTokenId: bigint;
  }): Promise<readonly { readonly address: Address; readonly decimals: number }[] | null> {
    const position = this.exitLegs ?? (await this.deps.dex.getPosition(input.positionTokenId).catch(() => null));
    if (position === null) return null;
    return [
      { address: position.token0, decimals: 18 },
      { address: position.token1, decimals: 18 },
    ];
  }

  /**
   * §62/§63 fee collection. Runs automatically (no approval): it reduces exposure and moves the
   * proceeds toward the reserve, so blocking it on a human would only increase risk.
   */
  async collectFees(input: {
    readonly poolId: PoolId;
    readonly positionTokenId: bigint;
    readonly recipient: Address;
    readonly guard: TxGuardChecks;
    readonly idempotencyKey: string;
  }): Promise<ExecutionOutcome> {
    const guard = this.checkGuard(input.guard);
    if (guard !== null) return guard;

    const gate = this.checkState(WRITE_ACTIONS.COLLECT_FEES);
    if (gate !== null) return gate;

    const duplicate = this.checkIdempotencyKey(input.idempotencyKey);
    if (duplicate !== null) return duplicate;

    const request: CollectFeesRequest = {
      poolId: input.poolId,
      positionTokenId: input.positionTokenId,
      recipient: input.recipient,
      idempotencyKey: input.idempotencyKey,
      guard: input.guard,
    };

    this.deps.txStore.recordIntended(
      {
        idempotencyKey: input.idempotencyKey,
        chainId: this.deps.dex.chainId,
        purpose: TX_PURPOSES.COLLECT_FEES,
        rawTx: JSON.stringify({
          kind: 'collectFees',
          poolId: input.poolId,
          positionTokenId: input.positionTokenId.toString(),
        }),
        rawTxFormat: RAW_TX_FORMATS.CALL_REQUEST,
      },
      input.guard,
    );

    try {
      const result = await this.deps.dex.collectFees(request);
      this.deps.txStore.markSubmitted(input.idempotencyKey, result.txHash);
      return { ok: true, reason: 'fees collected', addLiquidityTxHash: result.txHash };
    } catch (error) {
      return this.adapterFailure(input.idempotencyKey, error);
    }
  }

  /**
   * The body that runs only once an approval is held.
   *
   * Splitting this out is the point: `buildPosition` cannot reach it without passing `gate()`, and
   * `gate()` in turn cannot release without an approved persisted request.
   *
   * Two build shapes exist and the venue decides which (§42). The executor never branches on a DEX
   * id — it asks the adapter. The difference matters because the failure modes are different: an
   * atomic build either lands or does not, while a two-transaction build can land the swap and miss
   * the mint, which is the §43 `PARTIAL_POSITION` case.
   */
  private async runBuild(input: BuildPositionInput): Promise<ExecutionOutcome> {
    // §97: an intent is persisted before the first send, and the *executor* must refuse a key that has
    // already been used. `TxStore.record` deliberately RETURNS the existing row for a repeated
    // `(key, attempt)` rather than throwing (it is a record-keeping primitive, not a lock), so the
    // guard has to live here — otherwise a retry after a crash would re-send the same build.
    const refusal = this.checkIdempotencyKey(input.idempotencyKey);
    if (refusal !== null) return refusal;

    // The intent is recorded against the attempt it actually represents. A retry after a definite
    // failure (§98 FAILED/REVERTED) opens attempt N+1; recording it as attempt 1 again would return the
    // old row unchanged, so the new transaction would have nowhere to be recorded and `markSubmitted`
    // would then refuse the REVERTED row — i.e. the documented retry path would be broken.
    this.recordIntent(input);

    // D3.7: the two-transaction build is the ONLY shape, on every venue.
    return this.runTwoStepBuild(input);
  }

  /**
   * §97. Only a definite, observed failure may be retried; an in-flight or confirmed operation must
   * not be. `canOpenNewAttempt` is the store's own rule, so the two layers cannot disagree about
   * which states are retryable.
   */
  private checkIdempotencyKey(idempotencyKey: string): ExecutionOutcome | null {
    const latest = this.deps.txStore.latestAttempt(idempotencyKey);
    if (latest === null) return null;
    const verdict = canOpenNewAttempt(latest);
    if (verdict.ok) return null;
    return {
      ok: false,
      refusal: BUILD_REFUSALS.ALREADY_EXECUTED,
      reason:
        `not executed — '${idempotencyKey}' is already on record in state ${latest.state} ` +
        `(${verdict.code}): ${verdict.reason}`,
    };
  }

  /**
   * The build, uniformly as TWO transactions on every venue (§5.4/D3.7):
   *   swap → (adapter confirms on chain) → re-read the wallet → mint with the ACTUAL balances
   *
   * The window between the two sends is not a hazard to be closed with atomicity but a state to be
   * read correctly: the swap never fills at the mid price the plan used (fees + slippage), so the
   * planned ratio is stale by the time the mint runs. The mint sizes from the wallet AFTER the
   * swap (§5.3.3), and the 30% reserve is kept by capping the quote leg at the plan.
   */
  private async runTwoStepBuild(input: BuildPositionInput): Promise<ExecutionOutcome> {
    const swapRequest: SwapExecutionRequest = {
      quote: input.quote,
      deadline: input.deadline,
      purpose: SWAP_PURPOSES.BUILD_POSITION,
      idempotencyKey: input.idempotencyKey,
      guard: input.guard,
    };

    let swapTxHash: Hash;
    try {
      const swap = await this.deps.dex.executeSwap(swapRequest);
      swapTxHash = swap.txHash;
      this.deps.txStore.markSubmitted(input.idempotencyKey, swap.txHash);

      // A partial from the swap leg means the mint must not be attempted at all.
      if (swap.partial !== undefined) {
        return this.partialOutcome('swap', swap.txHash, swap.partial);
      }
      // The adapter has already confirmed the swap on chain (§5.3.5) — the wallet read below is
      // a settled fact, not an in-flight intent.
    } catch (error) {
      return this.adapterFailure(input.idempotencyKey, error);
    }

    /*
     * Re-read the wallet (§5.3.3): the plan's figures are stale by exactly the swap's fee+slippage.
     *
     * Stock leg: the whole holding goes in — by §5.3.1 the wallet held none before the build, so
     * this is what the swap produced. Quote leg: capped at the PLAN, not the wallet, so the 30%
     * reserve stays out of the position; the pool refunds whatever the tighter leg leaves.
     */
    const held0 = await this.deps.dex.getTokenBalance(input.pool.token0, input.walletAddress);
    const held1 = await this.deps.dex.getTokenBalance(input.pool.token1, input.walletAddress);
    if (held0 <= 0n || held1 <= 0n) {
      return {
        ok: false,
        refusal: BUILD_REFUSALS.POST_SWAP_SHORTFALL,
        reason:
          `after the swap (${swapTxHash}) the wallet holds ${held0.toString()} of ${input.pool.token0} ` +
          `and ${held1.toString()} of ${input.pool.token1}; nothing can be minted from that`,
        swapTxHash,
        partial: {
          completedSteps: ['swap'],
          failedStep: 'addLiquidity',
          reason: 'post-swap wallet read returned a zero balance on at least one leg',
        },
      };
    }
    const desired0 = held0;
    const desired1 = input.plan.amount1 < held1 ? input.plan.amount1 : held1;
    if (desired1 <= 0n) {
      return {
        ok: false,
        refusal: BUILD_REFUSALS.POST_SWAP_SHORTFALL,
        reason: `the plan's quote leg (${input.plan.amount1.toString()}) exceeds the post-swap wallet (${held1.toString()})`,
        swapTxHash,
        partial: {
          completedSteps: ['swap'],
          failedStep: 'addLiquidity',
          reason: 'quote leg underfunded after the swap',
        },
      };
    }

    /*
     * Minimums, re-derived from the ACTUAL amounts (§5.3.3) at the tolerance the gate approved.
     * The approved intent's ratios (min/desired of the PLAN) are applied to the actual figures —
     * NOT the plan's raw minimums, which no longer correspond to anything.
     *
     * The stock leg binds L (the swap pays fees, yielding slightly less stock than planned), so
     * the mint consumes quote proportionally: used1 ≈ plan.amount1 × desired0/plan.amount0.
     * Bounding min1 by that estimate keeps the check honest without asking the pool to accept
     * more than it will actually spend.
     */
    const ratioOf = (min: bigint, desired: bigint): bigint => (desired <= 0n ? 10_000n : (min * 10_000n) / desired);
    const r0 = ratioOf(input.amount0MinRaw, input.plan.amount0);
    const r1 = ratioOf(input.amount1MinRaw, input.plan.amount1);
    const used1Estimate =
      input.plan.amount0 > 0n ? (input.plan.amount1 * desired0) / input.plan.amount0 : desired1;
    const bounded1 = used1Estimate < desired1 ? used1Estimate : desired1;

    const liquidityRequest = this.addLiquidityRequest(input, {
      amount0DesiredRaw: desired0,
      amount1DesiredRaw: desired1,
      amount0MinRaw: (desired0 * r0) / 10_000n,
      amount1MinRaw: (bounded1 * r1) / 10_000n,
    });

    try {
      const liquidity = await this.deps.dex.addLiquidity(liquidityRequest);
      this.recordSubmitted(addKey(input.idempotencyKey), liquidity.txHash, TX_PURPOSES.ADD_LIQUIDITY);

      if (liquidity.partial !== undefined) {
        return this.partialOutcome('add liquidity', liquidity.txHash, liquidity.partial, swapTxHash);
      }

      return {
        ok: true,
        reason: 'position built (swap confirmed, wallet re-read, mint confirmed — §5.3.3/§5.3.5)',
        swapTxHash,
        addLiquidityTxHash: liquidity.txHash,
        ...(liquidity.positionTokenId === undefined ? {} : { positionTokenId: liquidity.positionTokenId }),
      };
    } catch (error) {
      // The swap already landed: the §43 partial, never an auto-retry of the mint.
      const failure = this.adapterFailure(input.idempotencyKey, error);
      return {
        ...failure,
        reason: `swap landed but add liquidity failed: ${failure.reason}`,
        swapTxHash,
        partial: {
          completedSteps: ['swap'],
          failedStep: 'addLiquidity',
          reason: failure.reason,
        },
      };
    }
  }

  /** §43: park for manual review, carrying the exact step that failed. */
  private partialOutcome(
    label: string,
    txHash: Hash,
    partial: { readonly completedSteps: readonly string[]; readonly failedStep: string; readonly reason: string },
    swapTxHash?: Hash,
  ): ExecutionOutcome {
    return {
      ok: false,
      reason: `${label} partially executed: ${partial.reason}`,
      ...(swapTxHash === undefined ? { addLiquidityTxHash: txHash } : { swapTxHash }),
      partial: {
        completedSteps: partial.completedSteps,
        failedStep: partial.failedStep,
        reason: partial.reason,
      },
    };
  }

  /**
   * Record the build intent for the attempt it represents (§97/§98).
   *
   * The attempt number is derived from the store rather than assumed: a first build is attempt 1, and a
   * deliberate retry after FAILED/REVERTED is the next one. `record` returns the existing row unchanged
   * for a repeated `(key, attempt)`, so hardcoding 1 would silently discard the retry's own record.
   * `checkIdempotencyKey` has already established that opening a new attempt is allowed here.
   */
  private recordIntent(input: BuildPositionInput): void {
    const latest = this.deps.txStore.latestAttempt(input.idempotencyKey);
    const attempt = latest === null ? 1 : latest.attempt + 1;
    this.deps.txStore.recordIntended(
      {
        idempotencyKey: input.idempotencyKey,
        chainId: this.deps.dex.chainId,
        purpose: TX_PURPOSES.SWAP,
        rawTx: JSON.stringify({
          kind: 'buildPosition',
          poolId: input.pool.poolId,
          capitalUsd: input.capitalUsd,
          amount0Raw: input.plan.amount0.toString(),
          amount1Raw: input.plan.amount1.toString(),
        }),
        rawTxFormat: RAW_TX_FORMATS.CALL_REQUEST,
        attempt,
      },
      input.guard,
    );
  }

  /**
   * §98 bookkeeping for the second leg of a two-transaction build.
   *
   * The added leg gets its own key (it is a different transaction). It is recorded as the next attempt
   * for that key, so a retried build records the retry's mint rather than colliding with the first one.
   */
  private recordSubmitted(idempotencyKey: string, txHash: Hash, purpose: (typeof TX_PURPOSES)[keyof typeof TX_PURPOSES]): void {
    const latest = this.deps.txStore.latestAttempt(idempotencyKey);
    this.deps.txStore.record({
      idempotencyKey,
      chainId: this.deps.dex.chainId,
      purpose,
      rawTx: JSON.stringify({ txHash }),
      rawTxFormat: RAW_TX_FORMATS.CALL_REQUEST,
      txHash,
      attempt: latest === null ? 1 : latest.attempt + 1,
    });
  }

  private addLiquidityRequest(
    input: BuildPositionInput,
    amounts?: {
      readonly amount0DesiredRaw: bigint;
      readonly amount1DesiredRaw: bigint;
      readonly amount0MinRaw: bigint;
      readonly amount1MinRaw: bigint;
    },
  ): AddLiquidityRequest {
    return {
      poolId: input.pool.poolId,
      tickRange: {
        lowerTick: input.tickRange.lowerTick,
        upperTick: input.tickRange.upperTick,
        tickSpacing: input.tickRange.tickSpacing,
      },
      // §5.3.3/D3.7: the amounts are the post-swap wallet, re-read by the executor; the plan's
      // figures remain available through `input.plan` for attribution only.
      amount0DesiredRaw: amounts?.amount0DesiredRaw ?? input.plan.amount0,
      amount1DesiredRaw: amounts?.amount1DesiredRaw ?? input.plan.amount1,
      amount0MinRaw: amounts?.amount0MinRaw ?? input.amount0MinRaw,
      amount1MinRaw: amounts?.amount1MinRaw ?? input.amount1MinRaw,
      recipient: input.walletAddress,
      deadline: input.deadline,
      idempotencyKey: addKey(input.idempotencyKey),
      guard: input.guard,
    };
  }

  /** §95. `ok` is the aggregate the adapters also check; a `false` here stops everything. */
  private checkGuard(guard: TxGuardChecks): ExecutionOutcome | null {
    if (guard.ok) return null;
    return {
      ok: false,
      refusal: BUILD_REFUSALS.GUARD_FAILED,
      reason: `transaction guard rejected the build: ${guard.failures.join('; ')}`,
    };
  }

  /** §44/§58/§60/§66. Reads the state at call time, never a cached value. */
  private checkState(action: (typeof WRITE_ACTIONS)[keyof typeof WRITE_ACTIONS]): ExecutionOutcome | null {
    const state = this.deps.currentState();
    const verdict = checkWriteAllowed(state, action);
    if (verdict.ok) return null;
    return {
      ok: false,
      refusal: BUILD_REFUSALS.WRITE_BLOCKED,
      reason: verdict.reason ?? `${state} does not permit ${action.id}`,
    };
  }

  private adapterFailure(idempotencyKey: string, error: unknown): ExecutionOutcome {
    const message = error instanceof Error ? error.message : String(error);
    this.log.error('execute', 'the venue refused the build', {
      reason: message,
      // The decoded revert reason, when viem managed to extract one: `STF`, `Transaction too old`, etc.
      shortMessage: (error as { shortMessage?: string }).shortMessage ?? '',
      revert: (error as { data?: unknown }).data ?? 'none',
    });

    /*
     * The WHOLE error is persisted, not just its message.
     *
     * viem puts the calldata, the estimated gas arguments and the decoded revert reason on the error
     * object, and only `message` survives a template literal. A failed build was therefore recorded as
     * "adapter failed: ..." with the one piece of evidence that identifies the cause — the encoded call —
     * discarded. Diagnosing it required re-deriving the transaction by hand from a partially pasted
     * trace, which is not a reasonable thing to ask of an operator at 3am.
     *
     * `JSON.stringify` with a plain replacer: the error carries bigints, which throw on serialisation, and
     * a diagnostic that itself crashes is worse than none.
     */
    const detail = safeDetail(error);
    this.deps.txStore.markUnknown(idempotencyKey, detail);
    return {
      ok: false,
      refusal: BUILD_REFUSALS.ADAPTER_FAILED,
      reason: `adapter failed: ${message} (left unresolved for a chain query; not retried)`,
    };
  }

  private fromGateOutcome(outcome: GateOutcome<ExecutionOutcome>, requestId: string): ExecutionOutcome {
    if (outcome.approved) return { ...outcome.value, approvalRequestId: requestId };
    return {
      ok: false,
      refusal: BUILD_REFUSALS.APPROVAL_DENIED,
      reason: `not executed — ${outcome.reason}: ${outcome.recordedReason}`,
      approvalRequestId: requestId,
    };
  }

  /** Human-readable digest for the approval message. Must contain no secret material. */
  /**
   * The approval prompt's digest.
   *
   * This is the last thing a human sees before real money moves, so it is written to be CHECKED, not
   * merely displayed: the figures an operator must verify are the ones with a plain-language label, and the
   * raw units appear only where a raw unit is what the transaction actually contains.
   *
   * Ordering follows the decision: what is being committed, at what price, over what range, and what the
   * swap will cost. A number that cannot be judged on its own is paired with the bound it must satisfy
   * (`impact 0.02% (上限 0.80%)`), because a bare percentage forces the operator to remember the limit.
   */
  private describeBuild(input: BuildPositionInput, swapAmountInRaw: bigint): string {
    const price = input.pool.currentPrice.value;
    const swing = (input.plan.lowerPrice / price - 1) * 100;
    const rise = (input.plan.upperPrice / price - 1) * 100;
    return [
      `建仓 ${input.pool.dex}`,
      shortPool(input.pool.poolId),
      '',
      renderRows([
        { label: '投入金额', value: usd(input.capitalUsd) },
        { label: '当前价格', value: usd(price) },
        { label: '价格区间', value: `${usd(input.plan.lowerPrice)} ~ ${usd(input.plan.upperPrice)}` },
        { label: '区间幅度', value: `${swing.toFixed(1)}% ~ +${rise.toFixed(1)}%` },
        { label: '需兑换', value: `${swapAmountInRaw.toString()}（最小单位）` },
        { label: '价格影响', value: `${(input.quote.priceImpact * 100).toFixed(4)}%（上限 ${(input.limits.maxPriceImpact * 100).toFixed(2)}%）` },
        { label: '允许滑点', value: `${(input.quote.slippageTolerance * 100).toFixed(2)}%` },
      ]),
    ].join('\n');
  }
}

/** `56:pancakeswap-v3:0xe531…` → `…e531fcb1f5` — the tail identifies the pool; the full id is unreadable. */
function shortPool(poolId: string): string {
  const address = poolId.split(':')[2] ?? poolId;
  return `池子 …${address.slice(-10)}`;
}

/**
 * Everything useful the error carries, as text that survives both JSON and a SQLite column.
 *
 * viem's error object holds `data` (the calldata), `metaMessages` (the estimate-gas arguments) and the
 * decoded revert reason. Losing them makes a revert undiagnosable from the record alone.
 */
function safeDetail(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const carrier = error as Error & {
    readonly data?: unknown;
    readonly metaMessages?: readonly string[];
    readonly cause?: unknown;
  };
  const parts: string[] = [error.message];
  if (carrier.metaMessages !== undefined && carrier.metaMessages.length > 0) {
    parts.push(carrier.metaMessages.join('\n'));
  }
  if (carrier.data !== undefined) parts.push(`data: ${stringifySafe(carrier.data)}`);
  if (carrier.cause !== undefined) parts.push(`cause: ${stringifySafe(carrier.cause)}`);
  return parts.join('\n\n');
}

/** JSON with bigint support and a depth cap, so a cyclic or huge error cannot break the record. */
function stringifySafe(value: unknown, depth = 0): string {
  if (depth > 6) return '[deep]';
  try {
    return JSON.stringify(value, (_key, val) =>
      typeof val === 'bigint' ? `${val.toString()}n` : val,
    ) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Key for the second (mint) transaction of a two-transaction build.
 *
 * One function so the executor and the adapters cannot disagree about the derived key: the adapter
 * stamps its request with it and the executor records the resulting hash under it. A mismatch there
 * would leave the mint unrecorded and the build looking like a §43 partial.
 */
export function addKey(buildKey: string): string {
  return `${buildKey}#add`;
}
