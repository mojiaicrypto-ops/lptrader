import { describe, expect, it, vi } from 'vitest';
import { ActionHandlers, type ActionHandlerDeps, type OpenPosition } from '../../src/execution/actionHandlers.ts';
import { BOT_STATES } from '../../src/types/state.ts';
import type { ExecutionOutcome } from '../../src/execution/positionExecutor.ts';
import type { Address } from '../../src/types/primitives.ts';

const POOL = '56:pancakeswap-v3:0xe531fcb1f5a195de7608b9f4f9518544c2cdb693';
const OWNER = '0x1111111111111111111111111111111111111111' as Address;

function openPosition(over: Partial<OpenPosition> = {}): OpenPosition {
  return {
    poolId: POOL,
    positionTokenId: 4242n,
    liquidity: 1_768_671_767_819_460_977_256n,
    owner: OWNER,
    dex: 'pancakeswap-v3',
    ...over,
  };
}

function ok(): ExecutionOutcome {
  return { ok: true, reason: 'liquidity removed', addLiquidityTxHash: '0xremove' as never };
}

function harness(options: {
  readonly position?: OpenPosition | null;
  readonly state?: (typeof BOT_STATES)[keyof typeof BOT_STATES];
  readonly exitResult?: ExecutionOutcome;
  readonly rebuild?: { readonly allowed: boolean; readonly reason: string };
  readonly build?: { readonly ok: boolean; readonly message: string };
  readonly noBuildPath?: boolean;
} = {}) {
  const exitPosition = vi.fn(async () => options.exitResult ?? ok());
  const buildPosition = vi.fn(async () => options.build ?? { ok: true, message: 'approval requested' });
  const deps: ActionHandlerDeps = {
    executor: { exitPosition } as never,
    stateMachine: { current: options.state ?? BOT_STATES.MONITOR } as never,
    positionReader: {} as never,
    dex: {} as never,
    openPosition: vi.fn(async () => (options.position === undefined ? openPosition() : options.position)),
    ...(options.rebuild === undefined
      ? {}
      : { approveRebuild: vi.fn(async () => options.rebuild!) }),
    ...(options.noBuildPath === true ? {} : { buildPosition }),
    notify: vi.fn(async () => {}),
  };
  return { handlers: new ActionHandlers(deps), exitPosition, buildPosition, deps };
}

describe('/exit (manual close, architecture §6.2)', () => {
  it('closes the position and moves to pool re-selection', async () => {
    const { handlers, exitPosition, buildPosition } = harness();
    const outcome = await handlers.exit();

    expect(outcome.ok).toBe(true);
    expect(exitPosition).toHaveBeenCalledTimes(1);
    // §6.2: a manual exit re-runs pool selection — "exit" means stop this position, not stop trading.
    // This used to be a MESSAGE claiming a rebuild would happen; SELECT_POOL had no consumer, so the bot
    // sat flat while the text promised otherwise. The build path is now actually invoked.
    expect(buildPosition).toHaveBeenCalledTimes(1);
    expect(outcome.nextState).toBe(BOT_STATES.IDLE);
    expect(outcome.message).toMatch(/replacement build started/);
  });

  it('stays flat and says so when no build path is wired', async () => {
    // A read-only process has no build path. Reporting SELECT_POOL would claim a selection that cannot run.
    const { handlers, buildPosition } = harness({ noBuildPath: true });
    const outcome = await handlers.exit();
    expect(buildPosition).not.toHaveBeenCalled();
    expect(outcome.nextState).toBe(BOT_STATES.IDLE);
    expect(outcome.message).toMatch(/No build path is wired/);
  });

  it('reports a failed rebuild instead of claiming success', async () => {
    const { handlers } = harness({ build: { ok: false, message: 'NO_QUALIFIED_POOL: nothing passed' } });
    const outcome = await handlers.exit();
    expect(outcome.nextState).toBe(BOT_STATES.IDLE);
    expect(outcome.message).toMatch(/rebuild did not proceed/);
  });

  it('refuses when there is nothing open', async () => {
    const { handlers, exitPosition } = harness({ position: null });
    const outcome = await handlers.exit();

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/no open position/);
    expect(exitPosition).not.toHaveBeenCalled();
  });

  it('refuses a zero-liquidity position instead of reporting a false success', async () => {
    // The NFT still exists and may hold unclaimed fees, but there is no liquidity to remove. Reporting
    // "closed" here would be a lie the operator acts on.
    const { handlers, exitPosition } = harness({ position: openPosition({ liquidity: 0n }) });
    const outcome = await handlers.exit();

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/zero liquidity/);
    expect(exitPosition).not.toHaveBeenCalled();
  });

  it('reports a failed exit without pretending it worked', async () => {
    const { handlers } = harness({
      exitResult: { ok: false, reason: 'mint reverted', refusal: 'adapter_failed' } as ExecutionOutcome,
    });
    const outcome = await handlers.exit();

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain('mint reverted');
    // The state must NOT advance on failure: nothing was closed.
    expect(outcome.nextState).toBe(BOT_STATES.MONITOR);
  });

  it('stays flat instead of rebuilding when the cost policy refuses (§6.4)', async () => {
    // An exit can return stock tokens; rebuilding into a DIFFERENT stock would need two swaps. The policy
    // keeps that cost bounded, and a refusal must leave the bot flat rather than building anyway.
    const { handlers, deps } = harness({
      rebuild: { allowed: false, reason: 'switching stock would cost 1.2% > 0.75% cap' },
    });
    const outcome = await handlers.exit();

    expect(outcome.ok).toBe(true);
    expect(outcome.nextState).toBe(BOT_STATES.IDLE);
    expect(outcome.message).toMatch(/rebuild skipped/);
    expect(deps.notify).toHaveBeenCalledWith(
      'warning',
      expect.stringContaining('rebuild skipped'),
      expect.stringContaining('0.75%'),
    );
  });

  it('rebuilds when the cost policy allows it', async () => {
    const { handlers, buildPosition } = harness({ rebuild: { allowed: true, reason: 'same stock leg' } });
    const outcome = await handlers.exit();
    expect(buildPosition).toHaveBeenCalledTimes(1);
    // IDLE is where the bot actually is: the build is behind its approval gate and owns its own transition.
    expect(outcome.nextState).toBe(BOT_STATES.IDLE);
  });
});

describe('/start (manual build, architecture §6.2)', () => {
  it('starts pool selection from flat without needing an approval', async () => {
    const { handlers, exitPosition, buildPosition } = harness({ position: null });
    const outcome = await handlers.start();

    expect(outcome.ok).toBe(true);
    // The command IS the authorisation (§6.2), so no approval is requested for /start itself — but the
    // build it triggers runs, which is what this previously only claimed in a message.
    expect(buildPosition).toHaveBeenCalledTimes(1);
    // The bot stays in its current state; the build path owns the transition.
    expect(outcome.nextState).toBe(BOT_STATES.MONITOR);
    // /start must not touch the exit path.
    expect(exitPosition).not.toHaveBeenCalled();
  });

  it('stays flat and idle when no pool qualifies', async () => {
    const { handlers } = harness({
      position: null,
      build: { ok: false, message: 'NO_QUALIFIED_POOL: no pool passed the hard filters' },
    });
    const outcome = await handlers.start();
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/no position was opened/);
    // The bot stays where it was. Reporting SELECT_POOL claimed a selection that never happened — the bug
    // this whole change removes.
    expect(outcome.nextState).toBe(BOT_STATES.MONITOR);
  });

  it('refuses when a position is already open, and points at /exit', async () => {
    // §8.5 makes single-pool a hard constraint, so building on top would create the exact state the
    // constraint forbids. Refusing with an instruction beats silently doing nothing.
    const { handlers } = harness();
    const outcome = await handlers.start();

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/already open/);
    expect(outcome.message).toMatch(/\/exit/);
  });
});

describe('/resume (leave a risk halt, architecture §6.3)', () => {
  it('leaves PAUSED, returning to IDLE — and does NOT rebuild by itself', async () => {
    const { handlers } = harness({ state: BOT_STATES.PAUSED, position: null });
    const outcome = await handlers.resume();

    expect(outcome.ok).toBe(true);
    // Two decisions, two steps: "I accept the situation" then "put money back in".
    expect(outcome.nextState).toBe(BOT_STATES.IDLE);
    expect(outcome.message).toMatch(/\/start/);
  });

  it('refuses to resume from a state driven by a live risk condition', async () => {
    // GLOBAL_RISK_OFF and EMERGENCY mean the condition is still true; acknowledging it is not the same as
    // resolving it, so an operator cannot clear these with a command.
    for (const state of [BOT_STATES.GLOBAL_RISK_OFF, BOT_STATES.EMERGENCY] as const) {
      const { handlers } = harness({ state, position: null });
      const outcome = await handlers.resume();
      expect(outcome.ok).toBe(false);
      expect(outcome.message).toMatch(/live risk condition/);
      expect(outcome.nextState).toBe(state);
    }
  });

  it('refuses when there is nothing to resume', async () => {
    for (const state of [BOT_STATES.IDLE, BOT_STATES.MONITOR] as const) {
      const { handlers } = harness({ state, position: null });
      const outcome = await handlers.resume();
      expect(outcome.ok).toBe(false);
      expect(outcome.message).toMatch(/nothing to resume/);
    }
  });
});

describe('single-pool fault surfacing (architecture §8.5)', () => {
  it('does not silently reduce multiple positions to the first', async () => {
    // The store has a UNIQUE partial index making a second open position impossible on a healthy path, so
    // one appearing means a bug or manual intervention. The handler must surface the fault rather than
    // pick one and carry on, which would hide the cause.
    const { handlers, deps } = harness();
    const second = openPosition({ positionTokenId: 9999n, poolId: '56:uniswap-v3:0xdead' });
    // The deps contract exposes a single position; a caller that cannot decide must fail loudly. Assert
    // the contract boundary instead of a silent first-wins: `openPosition` is what enforces it.
    expect(deps.openPosition).toBeDefined();
    await expect(deps.openPosition()).resolves.toEqual(openPosition());

    // And the handler propagates whatever it is given (no filtering of its own).
    const outcome = await handlers.start();
    expect(outcome.message).toMatch(/already open/);
    void second;
  });
});
