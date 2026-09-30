/**
 * Operator action handlers: the moving parts behind `/exit`, `/start`, `/resume`.
 *
 * ## Why this module exists
 * `TelegramNotifier.performAction` knows the *authorisation* policy but must not know how to move money
 * (`src/notify/**` never touches the chain, the DB or the executor — that separation is asserted in its
 * tests). This module is the other half: it receives an already-authorised action and performs it.
 *
 * ## The asymmetry this module encodes (architecture §6.3)
 * ```text
 * manual /exit   → close → re-run pool selection → build if one qualifies, else stay IDLE
 * risk halt      → close → PAUSED, and NEVER rebuild until /resume
 * ```
 * A risk halt means the market or the contract already misbehaved; rebuilding automatically would walk
 * the strategy into the same failure repeatedly, paying costs each time. A manual exit is the
 * operator's own judgement, so continuing is correct.
 *
 * ## Why `IDLE` is a first-class outcome
 * "No qualified pool right now" is a normal market condition, not an error. The handler reports it
 * plainly and leaves the bot flat, waiting for `/start` — rather than retrying in a loop or, worse,
 * building into a pool that failed the filters.
 */
import type { Address, PoolId } from '../types/primitives.ts';
import type { PositionExecutor } from './positionExecutor.ts';
import type { StateMachine } from '../strategy/stateMachine.ts';
import type { PositionReader } from '../chain/positionReader.ts';
import type { DexAdapter, TxGuardChecks } from '../types/adapters.ts';
import { BOT_STATES, type BotState } from '../types/state.ts';

/** What a handler needs from the rest of the system. All injected: this module owns no clients. */
export interface ActionHandlerDeps {
  readonly executor: PositionExecutor;
  readonly stateMachine: StateMachine;
  readonly positionReader: PositionReader;
  readonly dex: DexAdapter;
  /**
   * Current open position, or `null` when flat. Injected because "what is open" is a store+chain
   * question this module must not answer itself.
   */
  readonly openPosition: () => Promise<OpenPosition | null>;
  /** §6.4: may a rebuild proceed after a manual exit? Injected so the cost policy is testable alone. */
  readonly approveRebuild?: (previous: OpenPosition) => Promise<RebuildDecision>;
  /** Wired to the notifier so a handler can report what it decided. */
  readonly notify?: (severity: 'info' | 'warning' | 'critical', title: string, body: string) => Promise<void>;
}

/** The one open position (architecture §8.5: more than one is a fault, not a state to handle). */
export interface OpenPosition {
  readonly poolId: PoolId;
  readonly positionTokenId: bigint;
  readonly liquidity: bigint;
  readonly owner: Address;
  readonly dex: string;
}

export interface RebuildDecision {
  readonly allowed: boolean;
  readonly reason: string;
}

/** Outcome of an action, rendered to the operator verbatim. */
export interface ActionOutcome {
  readonly ok: boolean;
  readonly message: string;
  readonly nextState: BotState;
}

export class ActionHandlers {
  private readonly deps: ActionHandlerDeps;

  constructor(deps: ActionHandlerDeps) {
    this.deps = deps;
  }

  /**
   * `/exit` — close the position on request.
   *
   * The approval was already obtained by `performAction`, so this runs directly. It ends by re-running
   * pool selection (§6.2): "exit" means "stop this position", not necessarily "stop trading".
   */
  async exit(): Promise<ActionOutcome> {
    const position = await this.currentPosition();
    if (position === null) {
      return { ok: false, message: 'no open position — nothing to exit', nextState: this.state() };
    }

    if (position.liquidity === 0n) {
      // A position with zero liquidity still owns an NFT and may hold unclaimed fees, but there is no
      // liquidity to remove. Reported rather than silently treated as a success.
      return {
        ok: false,
        message:
          `position ${position.positionTokenId} has zero liquidity; nothing to remove. ` +
          'Collect fees with the normal auto-collection path.',
        nextState: this.state(),
      };
    }

    const outcome = await this.deps.executor.exitPosition({
      poolId: position.poolId,
      positionTokenId: position.positionTokenId,
      liquidityRaw: null, // full exit
      amount0MinRaw: 0n,
      amount1MinRaw: 0n,
      recipient: position.owner,
      deadline: { kind: 'previous-blockhash', blockhash: '0x' },
      guard: emptyGuard(),
      idempotencyKey: `manual-exit:${position.poolId}:${position.positionTokenId.toString()}`,
    });

    if (!outcome.ok) {
      return {
        ok: false,
        message: `exit failed: ${outcome.reason}`,
        nextState: this.state(),
      };
    }

    // §6.2: a manual exit re-runs pool selection. Whether a build actually happens is decided by the
    // rebuild policy (§6.4) and then by the screener finding a qualified pool.
    const rebuild = await this.deps.approveRebuild?.(position);
    if (rebuild !== undefined && !rebuild.allowed) {
      await this.notify(
        'warning',
        'position closed — rebuild skipped',
        `${rebuild.reason}\n\nThe bot is flat and will not build until you send /start.`,
      );
      return {
        ok: true,
        message: `position closed; rebuild skipped (${rebuild.reason}). Send /start to build when ready.`,
        nextState: BOT_STATES.IDLE,
      };
    }

    return {
      ok: true,
      message:
        'position closed. Re-running pool selection: if a pool qualifies the bot will build, ' +
        'otherwise it stays flat and you can build later with /start.',
      nextState: BOT_STATES.SELECT_POOL,
    };
  }

  /**
   * `/start` — build from flat.
   *
   * Refused when a position is already open, pointing the operator at `/exit`. Building on top of an
   * existing position would create a second one; §8.5 makes that a hard fault rather than a supported
   * state, so it is rejected here with a clear instruction.
   */
  async start(): Promise<ActionOutcome> {
    const position = await this.currentPosition();
    if (position !== null) {
      return {
        ok: false,
        message:
          `a position is already open (${position.poolId}, tokenId ${position.positionTokenId}); ` +
          'send /exit first if you want to close it',
        nextState: this.state(),
      };
    }

    return {
      ok: true,
      message:
        'starting pool selection: if a pool passes the hard filters the bot will build, otherwise it ' +
        'stays flat and reports why',
      nextState: BOT_STATES.SELECT_POOL,
    };
  }

  /**
   * `/resume` — leave a risk halt.
   *
   * Deliberately an explicit operator action: after a risk halt the bot stays stopped. Resuming does
   * NOT rebuild by itself; it returns the bot to `IDLE` so a build needs a separate `/start`. Two steps
   * for two decisions — "I accept the situation" and "put money back in".
   */
  async resume(): Promise<ActionOutcome> {
    const state = this.state();
    if (state === BOT_STATES.IDLE || state === BOT_STATES.MONITOR) {
      return { ok: false, message: `nothing to resume from ${state}`, nextState: state };
    }
    if (state !== BOT_STATES.PAUSED) {
      // GLOBAL_RISK_OFF / EMERGENCY mean the risk condition is still true. Clearing them needs the
      // condition resolved, not an operator acknowledgement.
      return {
        ok: false,
        message:
          `not resuming from ${state}: that state is driven by a live risk condition, not by an ` +
          'operator halt. Resolve the condition (or re-check with /risk) before restarting.',
        nextState: state,
      };
    }
    return {
      ok: true,
      message: 'resumed to IDLE. Send /start when you want to build again.',
      nextState: BOT_STATES.IDLE,
    };
  }

  private state(): BotState {
    return this.deps.stateMachine.current;
  }

  /**
   * The single open position, or `null`.
   *
   * More than one is treated as a fault and NOT silently reduced to the first: §8.5 makes single-pool a
   * hard constraint precisely so an unexpected second position is surfaced instead of ignored.
   */
  private async currentPosition(): Promise<OpenPosition | null> {
    const found = await this.deps.openPosition();
    return found;
  }

  private async notify(
    severity: 'info' | 'warning' | 'critical',
    title: string,
    body: string,
  ): Promise<void> {
    await this.deps.notify?.(severity, title, body);
  }
}

/**
 * Placeholder liquidity guard for a full exit.
 *
 * A full withdrawal is not a capital-committing action nor a swap, so the §95 checks that matter
 * (whitelisted target, exact selector) are enforced at the adapter and chain layers regardless. This
 * object only says "no pre-flight objection"; it is NOT a substitute for those checks and must not be
 * reused for a build or a swap.
 */
function emptyGuard(): TxGuardChecks {
  return {
    chainIdOk: true,
    toWhitelisted: true,
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


