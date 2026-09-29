import { describe, expect, it, vi } from 'vitest';
import { PositionExecutor, BUILD_REFUSALS } from '../../src/execution/positionExecutor.ts';
import { ApprovalGate } from '../../src/execution/approvalGate.ts';
import { InMemoryApprovalStore } from '../../src/execution/approvalGate.ts';
import { TxStore } from '../../src/store/txStore.ts';
import { openDatabase } from '../../src/store/db.ts';
import { StateMachine } from '../../src/strategy/stateMachine.ts';
import { BOT_STATES, type BotState } from '../../src/types/state.ts';
import { APPROVAL_KINDS, noopNotifier, type ApprovalDecision, type ApprovalRequest, type Notifier } from '../../src/types/notifier.ts';
import type {
  AddLiquidityRequest,
  CollectFeesRequest,
  DexAdapter,
  LpPositionView,
  PoolPriceView,
  PoolRefView,
  RemoveLiquidityRequest,
  SwapExecutionRequest,
  SwapQuote,
  LiquidityExecutionResult,
  SwapExecutionResult,
  TxGuardChecks,
} from '../../src/types/adapters.ts';
import type { PoolSnapshot } from '../../src/types/market.ts';
import type { PositionPlan } from '../../src/strategy/positionPlanner.ts';
import type { Address, Hash, Tick, FeeTier } from '../../src/types/primitives.ts';
import { DEX_IDS } from '../../src/types/primitives.ts';

const USDC = '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d' as Address;
const QQQB = '0x205812cdbed920aff76c6580abd681a46d11efc7' as Address;
const POOL = '56:pancakeswap-v3:0xe531fcb1f5a195de7608b9f4f9518544c2cdb693';

function guard(ok = true): TxGuardChecks {
  return ok
    ? {
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
      }
    : {
        chainIdOk: false,
        toWhitelisted: true,
        tokenInWhitelisted: true,
        tokenOutWhitelisted: true,
        functionSelectorOk: true,
        amountWithinLimit: true,
        slippageWithinLimit: true,
        deadlineOk: true,
        gasLimitSet: true,
        allowanceNotUnlimited: true,
        ok: false,
        failures: ['chainIdOk: expected 56, got 1'],
      };
}

const LIMITS = { maxSlippage: 0.003, maxPriceImpact: 0.005, quoteTtlSeconds: 30, liquidityRiskPriceImpact: 0.01 };

function quote(over: Partial<SwapQuote> = {}): SwapQuote {
  return {
    poolId: POOL,
    tokenIn: USDC,
    tokenOut: QQQB,
    amountInRaw: 3_185_000_000_000_000_000_000n,
    amountOutRaw: 4_300_000_000_000_000_000n,
    amountInUsd: 3185,
    priceImpact: 0.0012,
    slippageTolerance: 0.003,
    amountOutMinimumRaw: 4_287_100_000_000_000_000n,
    quotedAt: '2026-09-29T12:00:00.000Z',
    expiresAt: '2026-09-29T12:30:00.000Z',
    route: ['QQQB/USDT 0.01%'],
    ...over,
  };
}

function plan(over: Partial<PositionPlan> = {}): PositionPlan {
  return {
    lowerPrice: 629,
    upperPrice: 858.4,
    lowerTick: -100,
    upperTick: 100,
    liquidity: 123n,
    amount0: 1000n,
    amount1: 2000n,
    valueToken0Usd: 3180,
    valueToken1Usd: 3820,
    swapNeeded: { tokenIn: USDC, tokenOut: QQQB, amountIn: 3_185_000_000_000_000_000_000n },
    rangeProgress: 0.5,
    ...over,
  };
}

function poolSnapshot(): PoolSnapshot {
  const sourced = <T,>(value: T) => ({ value, source: 'onchain' as const, asOf: '2026-09-29T12:00:00.000Z', stale: false });
  return {
    timestamp: '2026-09-29T12:00:00.000Z',
    chainId: 56,
    dex: DEX_IDS.PANCAKESWAP_V3,
    poolAddress: '0xe531fcb1f5a195de7608b9f4f9518544c2cdb693',
    poolId: POOL,
    token0: QQQB,
    token1: USDC,
    token0Id: `56:${QQQB}`,
    token1Id: `56:${USDC}`,
    feeTier: 100,
    token0Decimals: 18,
    token1Decimals: 18,
    tvlUSD: sourced(622_547),
    volume24h: sourced(6_560_000),
    volume7d: sourced(40_000_000),
    fees24h: sourced(656),
    fees7d: sourced(4_000),
    poolAgeDays: 81,
    currentPrice: sourced(739.63),
    sqrtPriceX96: 2154702184312214094591448544382n,
    currentTick: 66064,
    activeLiquidity: 1556463151563366171503721n,
    stockReferencePrice: sourced(738.84),
    tokenNAVDeviation: sourced(0.001),
    stockVolatility7d: sourced(0.02),
    stockVolatility30d: sourced(0.025),
    swapImpact1000USD: sourced(0.0002),
    swapImpact3500USD: sourced(0.0006),
    swapImpact5000USD: sourced(0.0009),
    estimatedAPR1d: sourced(0.2),
    estimatedAPR7d: sourced(0.2),
    estimatedAPR30d: sourced(0.2),
    marketDataSource: 'onchain',
  };
}

/** Records every call so tests can assert an ABSENCE of sends, which is the point of most of them. */
class RecordingDex implements DexAdapter {
  readonly dex = DEX_IDS.PANCAKESWAP_V3;
  readonly chainId = 56;

  readonly calls: string[] = [];
  readonly addRequests: AddLiquidityRequest[] = [];
  readonly swapRequests: SwapExecutionRequest[] = [];
  readonly removalRequests: RemoveLiquidityRequest[] = [];
  readonly collectRequests: CollectFeesRequest[] = [];

  readonly supportsAtomicBuild: boolean;

  private readonly behaviour: {
    swap?: SwapExecutionResult | Error;
    add?: LiquidityExecutionResult | Error;
    remove?: LiquidityExecutionResult | Error;
    collect?: LiquidityExecutionResult | Error;
  };

  constructor(
    supportsAtomicBuild: boolean,
    behaviour: {
      swap?: SwapExecutionResult | Error;
      add?: LiquidityExecutionResult | Error;
      remove?: LiquidityExecutionResult | Error;
      collect?: LiquidityExecutionResult | Error;
    } = {},
  ) {
    this.supportsAtomicBuild = supportsAtomicBuild;
    this.behaviour = behaviour;
  }

  assertWhitelisted(): void {}
  async getPool(_t0: Address, _t1: Address, _fee: FeeTier): Promise<PoolRefView | null> {
    return null;
  }
  async getPoolPrice(_pool: Address): Promise<PoolPriceView> {
    throw new Error('not used');
  }
  async getLiquidity(_pool: Address): Promise<bigint> {
    return 0n;
  }
  async getTick(_pool: Address): Promise<Tick> {
    return 0;
  }
  async quoteSwap(): Promise<SwapQuote> {
    return quote();
  }
  async executeSwap(request: SwapExecutionRequest): Promise<SwapExecutionResult> {
    this.calls.push('executeSwap');
    this.swapRequests.push(request);
    const behaviour = this.behaviour.swap;
    if (behaviour instanceof Error) throw behaviour;
    return behaviour ?? { txHash: '0xswap' as Hash, state: 'CONFIRMED', amountInRaw: 1n, amountOutRaw: 2n };
  }
  async addLiquidity(request: AddLiquidityRequest): Promise<LiquidityExecutionResult> {
    this.calls.push('addLiquidity');
    this.addRequests.push(request);
    const behaviour = this.behaviour.add;
    if (behaviour instanceof Error) throw behaviour;
    return behaviour ?? { txHash: '0xadd' as Hash, state: 'CONFIRMED', positionTokenId: 4242n };
  }
  async removeLiquidity(request: RemoveLiquidityRequest): Promise<LiquidityExecutionResult> {
    this.calls.push('removeLiquidity');
    this.removalRequests.push(request);
    const behaviour = this.behaviour.remove;
    if (behaviour instanceof Error) throw behaviour;
    return behaviour ?? { txHash: '0xremove' as Hash, state: 'CONFIRMED' };
  }
  async collectFees(request: CollectFeesRequest): Promise<LiquidityExecutionResult> {
    this.calls.push('collectFees');
    this.collectRequests.push(request);
    const behaviour = this.behaviour.collect;
    if (behaviour instanceof Error) throw behaviour;
    return behaviour ?? { txHash: '0xcollect' as Hash, state: 'CONFIRMED' };
  }
  async getPosition(_tokenId: bigint): Promise<LpPositionView | null> {
    return null;
  }
}

/** Approves everything, so these tests exercise the executor rather than the gate. */
const alwaysApprove: Notifier = {
  send: async () => {},
  requestApproval: async (request: ApprovalRequest): Promise<ApprovalDecision> => ({
    requestId: request.id,
    approved: true,
    decidedBy: '555',
    decidedAt: '2026-09-29T12:00:01.000Z',
  }),
  query: async () => '',
};

function harness(options: { dex: DexAdapter; notifier?: Notifier; state?: BotState; now?: string }) {
  // Plain `:memory:` is private per open since the store owner fixed the singleton-map aliasing
  // (KI-16), so no unique URI or closeDatabase pairing is needed for isolation.
  const db = openDatabase(':memory:');
  const txStore = new TxStore(db);
  const gate = new ApprovalGate({
    notifier: options.notifier ?? alwaysApprove,
    timeoutMinutes: 30,
    store: new InMemoryApprovalStore(),
    now: () => Date.parse(options.now ?? '2026-09-29T12:00:05.000Z'),
  });
  let state: BotState = options.state ?? BOT_STATES.PREPARE_POSITION;
  const stateMachine = StateMachine.open(db, state);
  const executor = new PositionExecutor({
    dex: options.dex,
    txStore,
    stateMachine,
    approvalGate: gate,
    currentState: () => state,
  });
  return {
    executor,
    txStore,
    gate,
    setState: (next: BotState) => {
      state = next;
    },
  };
}

function buildInput(over: Record<string, unknown> = {}) {
  return {
    pool: poolSnapshot(),
    capitalUsd: 7000,
    walletAddress: '0x1111111111111111111111111111111111111111' as Address,
    plan: plan(),
    quote: quote(),
    tickRange: { lowerTick: -100, upperTick: 100, tickSpacing: 1 },
    amount0MinRaw: 990n,
    amount1MinRaw: 1980n,
    guard: guard(),
    limits: LIMITS,
    deadline: { kind: 'previous-blockhash' as const, blockhash: ('0x' + 'ab'.repeat(32)) as Hash },
    idempotencyKey: 'build-1',
    now: '2026-09-29T12:00:05.000Z',
    ...over,
  };
}

describe('§95 transaction guard', () => {
  it('refuses before asking a human anything when the guard fails', async () => {
    const dex = new RecordingDex(true);
    const notifier = { ...alwaysApprove, requestApproval: vi.fn(alwaysApprove.requestApproval) };
    const h = harness({ dex, notifier });

    const outcome = await h.executor.buildPosition(buildInput({ guard: guard(false) }));

    expect(outcome.ok).toBe(false);
    expect(outcome.refusal).toBe(BUILD_REFUSALS.GUARD_FAILED);
    expect(outcome.reason).toContain('chainIdOk');
    // The operator must not be asked to approve something the guard already rejected.
    expect(notifier.requestApproval).not.toHaveBeenCalled();
    expect(dex.calls).toEqual([]);
  });
});

describe('§44/§66 write gate', () => {
  it.each([
    BOT_STATES.GLOBAL_RISK_OFF,
    BOT_STATES.EMERGENCY,
    BOT_STATES.PAUSED,
    BOT_STATES.ERROR,
    BOT_STATES.RISK_REVIEW,
    BOT_STATES.PARTIAL_POSITION,
  ])('sends nothing from %s', async (state) => {
    const dex = new RecordingDex(true);
    const h = harness({ dex, state });

    const outcome = await h.executor.buildPosition(buildInput());

    expect(outcome.ok).toBe(false);
    expect(outcome.refusal).toBe(BUILD_REFUSALS.WRITE_BLOCKED);
    expect(dex.calls).toEqual([]);
  });
});

describe('§40/§41 swap gate runs before encoding', () => {
  it('refuses an over-impact quote and does not encode or ask for approval', async () => {
    const dex = new RecordingDex(true);
    const notifier = { ...alwaysApprove, requestApproval: vi.fn(alwaysApprove.requestApproval) };
    const h = harness({ dex, notifier });

    const outcome = await h.executor.buildPosition(
      buildInput({ quote: quote({ priceImpact: 0.02 }) }),
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.refusal).toBe(BUILD_REFUSALS.QUOTE_REJECTED);
    expect(outcome.reason).toContain('price_impact_exceeded');
    expect(dex.calls).toEqual([]);
    expect(notifier.requestApproval).not.toHaveBeenCalled();
  });

  it('refuses an expired quote rather than signing a stale price', async () => {
    const dex = new RecordingDex(true);
    const h = harness({ dex });

    const outcome = await h.executor.buildPosition(
      buildInput({ quote: quote({ expiresAt: '2026-09-29T11:59:00.000Z' }) }),
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain('quote_expired');
    expect(dex.calls).toEqual([]);
  });
});

describe('§42 atomic build', () => {
  it('produces exactly ONE adapter send and carries the trade in the add-liquidity call', async () => {
    const dex = new RecordingDex(true);
    const h = harness({ dex });

    const outcome = await h.executor.buildPosition(buildInput());

    expect(outcome.ok).toBe(true);
    expect(dex.calls).toEqual(['addLiquidity']);
    expect(dex.swapRequests).toEqual([]);
    expect(dex.addRequests).toHaveLength(1);
    const request = dex.addRequests[0];
    expect(request?.swapForDeficit).toBeDefined();
    expect(request?.swapForDeficit?.quote.tokenIn).toBe(USDC);
    expect(request?.swapForDeficit?.atomic).toBe(true);
  });

  it('does NOT fall back to the two-transaction path when the atomic build throws', async () => {
    // A venue advertising atomic support that then fails is an unexpected state. Retrying as
    // swap-then-add would send a swap the operator never approved under that shape.
    const dex = new RecordingDex(true, { add: new Error('smart router reverted: TICK_ORDER') });
    const h = harness({ dex });

    const outcome = await h.executor.buildPosition(buildInput());

    expect(outcome.ok).toBe(false);
    expect(outcome.refusal).toBe(BUILD_REFUSALS.ADAPTER_FAILED);
    expect(dex.calls).toEqual(['addLiquidity']);
    expect(dex.swapRequests).toEqual([]);
  });

  it('parks in a partial outcome when the atomic call reports one', async () => {
    const dex = new RecordingDex(true, {
      add: {
        txHash: '0xpartial' as Hash,
        state: 'CONFIRMED',
        partial: { completedSteps: ['swap'], failedStep: 'addLiquidity', reason: 'slippage', requiresManualReview: true },
      },
    });
    const h = harness({ dex });

    const outcome = await h.executor.buildPosition(buildInput());

    expect(outcome.ok).toBe(false);
    expect(outcome.partial?.failedStep).toBe('addLiquidity');
    expect(outcome.partial?.completedSteps).toEqual(['swap']);
  });
});

describe('§42/§43 two-transaction build', () => {
  it('sends swap then addLiquidity when the venue cannot combine', async () => {
    const dex = new RecordingDex(false);
    const h = harness({ dex });

    const outcome = await h.executor.buildPosition(buildInput());

    expect(outcome.ok).toBe(true);
    expect(dex.calls).toEqual(['executeSwap', 'addLiquidity']);
    expect(dex.addRequests[0]?.swapForDeficit).toBeUndefined();
  });

  it('reports a §43 partial when the swap lands but the mint fails, and never retries', async () => {
    const dex = new RecordingDex(false, { add: new Error('mint reverted') });
    const h = harness({ dex });

    const outcome = await h.executor.buildPosition(buildInput());

    expect(outcome.ok).toBe(false);
    expect(outcome.partial).toBeDefined();
    expect(outcome.partial?.completedSteps).toEqual(['swap']);
    expect(outcome.partial?.failedStep).toBe('addLiquidity');
    expect(outcome.swapTxHash).toBe('0xswap');
    // Exactly one swap and one attempted mint — no retry.
    expect(dex.calls).toEqual(['executeSwap', 'addLiquidity']);
  });

  it('does not attempt the mint at all when the swap leg is itself incomplete', async () => {
    const dex = new RecordingDex(false, {
      swap: {
        txHash: '0xswap' as Hash,
        state: 'CONFIRMED',
        amountInRaw: 1n,
        amountOutRaw: 2n,
        partial: { completedSteps: [], failedStep: 'swap', reason: 'route died', requiresManualReview: true },
      },
    });
    const h = harness({ dex });

    const outcome = await h.executor.buildPosition(buildInput());

    expect(outcome.ok).toBe(false);
    expect(dex.calls).toEqual(['executeSwap']);
    expect(outcome.partial?.failedStep).toBe('swap');
  });
});

describe('approval gate is not bypassable', () => {
  it('runs nothing when the approval is refused', async () => {
    const dex = new RecordingDex(true);
    const h = harness({ dex, notifier: noopNotifier });

    const outcome = await h.executor.buildPosition(buildInput());

    expect(outcome.ok).toBe(false);
    expect(outcome.refusal).toBe(BUILD_REFUSALS.APPROVAL_DENIED);
    expect(dex.calls).toEqual([]);
  });

  it('runs nothing when the request cannot even be published', async () => {
    const dex = new RecordingDex(true);
    const offline: Notifier = {
      send: async () => {},
      // A real channel refuses ON the request it was handed; the id must match, otherwise the gate
      // would wait out the whole TTL before refusing.
      requestApproval: async (request) => ({
        requestId: request.id,
        approved: false,
        decidedBy: 'telegram-notifier',
        decidedAt: '2026-09-29T12:00:01.000Z',
        reason: 'channel unavailable',
      }),
      query: async () => '',
    };
    const h = harness({ dex, notifier: offline });

    const outcome = await h.executor.buildPosition(buildInput());

    expect(outcome.ok).toBe(false);
    expect(dex.calls).toEqual([]);
  });

  it('asks for BUILD_POSITION, never SWITCH_POOL, and logs the digest without secrets', async () => {
    const dex = new RecordingDex(true);
    const seen: ApprovalRequest[] = [];
    const notifier: Notifier = {
      send: async () => {},
      requestApproval: async (request) => {
        seen.push(request);
        return { requestId: request.id, approved: true, decidedBy: '555', decidedAt: '2026-09-29T12:00:01.000Z' };
      },
      query: async () => '',
    };
    const h = harness({ dex, notifier });

    await h.executor.buildPosition(buildInput());

    expect(seen).toHaveLength(1);
    expect(seen[0]?.kind).toBe(APPROVAL_KINDS.BUILD_POSITION);
    expect(seen[0]?.payloadSummary).toContain('BUILD');
    // The digest must show the numbers the human is approving.
    expect(seen[0]?.payloadSummary).toContain('impact');
    expect(seen[0]?.payloadSummary).toContain('slippage');
  });
});

describe('§97 idempotency', () => {
  it('refuses a second build with the same idempotency key instead of re-sending', async () => {
    const dex = new RecordingDex(true);
    const h = harness({ dex });
    const input = buildInput();

    const first = await h.executor.buildPosition(input);
    expect(first.ok).toBe(true);
    expect(dex.calls).toEqual(['addLiquidity']);

    const second = await h.executor.buildPosition(input);

    expect(second.ok).toBe(false);
    expect(second.refusal).toBe(BUILD_REFUSALS.ALREADY_EXECUTED);
    // The key thing: the adapter was not called a second time.
    expect(dex.calls).toEqual(['addLiquidity']);
  });
});

describe('automatic operations need no approval (§91/D2)', () => {
  it('collects fees with the no-op notifier present (no human in the loop)', async () => {
    const dex = new RecordingDex(true);
    const h = harness({ dex, notifier: noopNotifier, state: BOT_STATES.MONITOR });

    const outcome = await h.executor.collectFees({
      poolId: POOL,
      positionTokenId: 1n,
      recipient: '0x1111111111111111111111111111111111111111' as Address,
      guard: guard(),
      idempotencyKey: 'collect-1',
    });

    expect(outcome.ok).toBe(true);
    expect(dex.calls).toEqual(['collectFees']);
  });

  it('exits a position automatically from RISK_REVIEW (§51 — risk work is not blocked on a human)', async () => {
    const dex = new RecordingDex(true);
    const h = harness({ dex, notifier: noopNotifier, state: BOT_STATES.RISK_REVIEW });

    const outcome = await h.executor.exitPosition({
      poolId: POOL,
      positionTokenId: 1n,
      liquidityRaw: null,
      amount0MinRaw: 0n,
      amount1MinRaw: 0n,
      recipient: '0x1111111111111111111111111111111111111111' as Address,
      deadline: { kind: 'previous-blockhash', blockhash: ('0x' + 'ab'.repeat(32)) as Hash },
      guard: guard(),
      idempotencyKey: 'exit-1',
    });

    expect(outcome.ok).toBe(true);
    expect(dex.calls).toEqual(['removeLiquidity']);
  });

  it('blocks collection while halted (§58/§66 read-only states)', async () => {
    const dex = new RecordingDex(true);
    const h = harness({ dex, state: BOT_STATES.EMERGENCY });

    const outcome = await h.executor.collectFees({
      poolId: POOL,
      positionTokenId: 1n,
      recipient: '0x1111111111111111111111111111111111111111' as Address,
      guard: guard(),
      idempotencyKey: 'collect-2',
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.refusal).toBe(BUILD_REFUSALS.WRITE_BLOCKED);
    expect(dex.calls).toEqual([]);
  });
});
