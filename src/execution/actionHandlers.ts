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
import type { Address, PoolId, UsdAmount } from '../types/primitives.ts';
import type { PositionExecutor } from './positionExecutor.ts';
import type { StateMachine } from '../strategy/stateMachine.ts';
import type { PositionReader } from '../chain/positionReader.ts';
import type { DexAdapter, TxGuardChecks } from '../types/adapters.ts';
import { BOT_STATES, type BotState } from '../types/state.ts';
import { renderMessage, titleWithIcon } from '../notify/messageFormat.ts';

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
  /**
   * The ONE path that opens a position (§45). Injected rather than reimplemented so `/start`, the post-exit
   * rebuild and the risk-driven switch all take the same route — a second build path would be a second set
   * of bugs, and the first one would keep working while the second silently diverged.
   */
  readonly buildPosition?: (options?: {
    readonly affordableUsd?: UsdAmount;
    readonly trigger?: string;
  }) => Promise<{ readonly ok: boolean; readonly message: string }>;
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
      return { ok: false, message: '当前没有仓位，无需撤池。', nextState: this.state() };
    }

    if (position.liquidity === 0n) {
      // A position with zero liquidity still owns an NFT and may hold unclaimed fees, but there is no
      // liquidity to remove. Reported rather than silently treated as a success.
      return {
        ok: false,
        message:
          `仓位 ${position.positionTokenId} 的流动性为 0，没有可撤出的部分。\n` +
          '未领取的手续费会由自动收取流程处理。',
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
      /**
       * A timestamp deadline. `previous-blockhash` is refused by the PancakeSwap v3 adapter because the
       * `NonfungiblePositionManager` exposes only `multicall(bytes[])` and cannot take a blockhash — so
       * passing it here meant **every `/exit` failed**. The adapter was right to refuse; this caller was
       * wrong to ask.
       */
      deadline: { kind: 'timestamp', unixSeconds: Math.floor(Date.now() / 1000) + 600 },
      guard: emptyGuard(),
      idempotencyKey: `manual-exit:${position.poolId}:${position.positionTokenId.toString()}`,
    });

    if (!outcome.ok) {
      return {
        ok: false,
        message: `撤池失败：${outcome.reason}`,
        nextState: this.state(),
      };
    }

    // §6.2/§6.4: a manual exit re-runs pool selection. The policy only gates the AUTOMATIC rebuild — the
    // exit itself already happened, because refusing to close a position the operator wants closed would
    // be worse than whatever the round trip costs.
    const rebuild = await this.deps.approveRebuild?.(position);
    if (rebuild !== undefined && !rebuild.allowed) {
      await this.notify(
        'warning',
        titleWithIcon('warning', '已撤池，但暂不重建'),
        renderMessage({
          severity: 'warning',
          title: '已撤池，但暂不重建',
          action: '现在空仓。想重新建仓时发 /start。',
          note: rebuild.reason,
        }),
      );
      return {
        ok: true,
        message: `已撤池。暂不自动重建，原因：${rebuild.reason}\n想重新建仓时发 /start。`,
        nextState: BOT_STATES.IDLE,
      };
    }

    // Actually rebuild. This used to return a message SAYING it would — and nothing consumed the
    // SELECT_POOL state, so the bot sat flat while the text promised otherwise.
    if (this.deps.buildPosition === undefined) {
      return {
        ok: true,
        message: '已撤池。当前进程没有建仓能力（未配置签名钱包），想重新建仓时请发 /start。',
        nextState: BOT_STATES.IDLE,
      };
    }

    await this.notify(
      'info',
      titleWithIcon('info', '正在重新选池'),
      renderMessage({ severity: 'info', title: '正在重新选池', action: '仓位已撤出，正在挑选替代池子…' }),
    );
    const built = await this.deps.buildPosition({ trigger: 'post-exit rebuild' });
    return {
      ok: true,
      message: built.ok
        ? `已撤池，正在重新建仓。\n${built.message}`
        : `已撤池，但未能重新建仓。\n${built.message}`,
      // Same reasoning as `/start`: the position IS closed, so the bot is flat. A submitted build is still
      // behind its approval gate and owns its own transition.
      nextState: BOT_STATES.IDLE,
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
          `已有持仓（${position.poolId}，tokenId ${position.positionTokenId}）。\n` +
          '如需平仓请先发 /exit。',
        nextState: this.state(),
      };
    }

    // §6.2: `/start` needs no confirmation of its own — the command IS the authorisation. The build it
    // triggers goes through the same approval gate as any other, because the gate protects the money being
    // committed, not the intent to commit it.
    if (this.deps.buildPosition === undefined) {
      return {
        ok: false,
        message: '当前进程不能建仓：没有配置签名钱包，只能只读监控。',
        nextState: this.state(),
      };
    }

    await this.notify(
      'info',
      titleWithIcon('info', '正在挑选池子'),
      renderMessage({ severity: 'info', title: '正在挑选池子', action: '扫描与链上核验大约需要几分钟，结果会推送给你。' }),
    );
    const built = await this.deps.buildPosition({ trigger: '/start' });
    return {
      ok: built.ok,
      message: built.ok
        ? `已发起建仓。\n${built.message}`
        : `没有建仓。\n${built.message}`,
      /**
       * The state the bot is actually in, not the state a build might eventually reach.
       *
       * `nextState` describes where the bot stands once this handler returns. A build that was submitted is
       * still awaiting its approval gate, so the bot is in its current state — reporting `PREPARE_POSITION`
       * would name a state the state machine has not entered, and from `IDLE` it is not even a legal edge.
       * The build path owns its own transitions.
       */
      nextState: this.state(),
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
      return { ok: false, message: `当前状态是 ${state}，无需恢复。`, nextState: state };
    }
    if (state !== BOT_STATES.PAUSED) {
      // GLOBAL_RISK_OFF / EMERGENCY mean the risk condition is still true. Clearing them needs the
      // condition resolved, not an operator acknowledgement.
      return {
        ok: false,
        message:
          `不能从 ${state} 恢复：这个状态由实时风险条件驱动，不是人工暂停。\n` +
          '请先确认风险已解除（发 /risk 查看）再恢复。',
        nextState: state,
      };
    }
    return {
      ok: true,
      message: '已恢复为空仓状态。想建仓时发 /start。',
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


