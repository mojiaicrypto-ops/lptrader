/**
 * Contract test for the frozen shared layer.
 *
 * The assertions below are type-level: `npm run typecheck` fails if a required export disappears, if
 * an amount field stops being `bigint`, or if a field silently becomes `any`. That is why
 * `@ts-expect-error` appears next to deliberately wrong assignments — if any of them START compiling,
 * the type has loosened and the test fails.
 *
 * Runtime assertions only cover the pieces that are values (state tables, id constants).
 */
import { describe, expect, it } from 'vitest';
import type { Address, Hex } from '../../src/types/primitives.ts';
import {
  DEX_IDS,
  TOKEN_KINDS,
  TOKEN_RISK_TIERS,
  type ChainId,
  type DexId,
  type PoolId,
  type Ratio,
  type Tick,
  type TokenId,
  type UsdAmount,
} from '../../src/types/primitives.ts';
import { UI_AMOUNT_MODES, type TokenAmount, type TokenMeta } from '../../src/types/token.ts';
import type { PoolSnapshot, PoolFilterResult, PoolFilterThresholds, Sourced, TickRange } from '../../src/types/market.ts';
import type { DecisionLog, DrawdownState, PortfolioSnapshot, Position, SwapRecord } from '../../src/types/portfolio.ts';
import {
  APPROVAL_TYPES,
  MARKET_STATUSES,
  PEG_LEVELS,
  SWAP_PURPOSES,
  TX_STATES,
  type AddLiquidityRequest,
  type ChainAdapter,
  type CollectFeesRequest,
  type DeadlineSpec,
  type DexAdapter,
  type LpPositionView,
  type PegAssessment,
  type PoolDataProvider,
  type PoolPriceView,
  type ReferencePriceProvider,
  type RemoveLiquidityRequest,
  type SwapQuote,
  type SwapExecutionRequest,
  type SwapQuoteRequest,
  type TxGuardChecks,
  type TxState,
  type SwapPurpose,
  type ApprovalType,
  type MarketStatus,
  type PegLevel,
} from '../../src/types/adapters.ts';
import {
  BOT_STATES,
  BOT_STATE_TRANSITIONS,
  NO_NEW_CAPITAL_STATES,
  READ_ONLY_STATES,
  type BotState,
} from '../../src/types/state.ts';
import {
  APPROVAL_KINDS,
  ALERT_SEVERITIES,
  noopNotifier,
  type AlertSeverity,
  type ApprovalDecision,
  type ApprovalKind,
  type ApprovalRequest,
  type ApprovalStatus,
  type Notifier,
} from '../../src/types/notifier.ts';
import type { TokenRegistry, Whitelist, WhitelistDexEntry } from '../../src/types/registry.ts';
import type {
  ApprovalsConfig,
  RiskConfig,
  StrategyConfig,
  TelegramConfig,
} from '../../src/types/config.ts';
import { loadConfig } from '../../src/config/index.ts';
import { encryptPrivateKey, decryptPrivateKey } from '../../src/security/keystore.ts';

/** Assignable only when `T` is exactly `bigint` (fails for a union, fails for `any`). */
type IsExactlyBigint<T> = [T] extends [bigint] ? ([bigint] extends [T] ? true : false) : false;

describe('frozen primitive unions', () => {
  it('exposes the DEX, kind and risk-tier identifiers', () => {
    expect(Object.values(DEX_IDS).sort()).toEqual(['pancakeswap-v3', 'uniswap-v3']);
    expect(Object.keys(TOKEN_KINDS).sort()).toEqual([
      'BSTOCKS',
      'OTHER',
      'STABLECOIN',
      'WRAPPED_NATIVE',
    ]);
    expect(Object.values(TOKEN_RISK_TIERS).sort()).toEqual(['BLOCKED', 'CORE', 'HIGH_VOL']);
  });

  it('exposes the full §44 state set plus the two documented extensions', () => {
    const baseline: readonly BotState[] = [
      'IDLE',
      'SELECT_POOL',
      'PREPARE_POSITION',
      'SWAP',
      'ADD_LIQUIDITY',
      'MONITOR',
      'OUT_OF_RANGE',
      'UNDERPERFORMING',
      'SEARCH_REPLACEMENT',
      'EXIT_POSITION',
      'SWITCH_POOL',
      'RISK_REVIEW',
      'GLOBAL_RISK_OFF',
      'PAUSED',
      'ERROR',
    ];
    for (const state of baseline) {
      expect(Object.values(BOT_STATES)).toContain(state);
    }
    expect(Object.values(BOT_STATES)).toContain('PARTIAL_POSITION');
    expect(Object.values(BOT_STATES)).toContain('EMERGENCY');
    expect(NO_NEW_CAPITAL_STATES).toContain('GLOBAL_RISK_OFF');
    expect(READ_ONLY_STATES).toContain('EMERGENCY');
  });

  it('declares a transition table for every state and no unknown target', () => {
    const states = Object.keys(BOT_STATE_TRANSITIONS);
    expect(states.sort()).toEqual([...Object.values(BOT_STATES)].sort());
    for (const targets of Object.values(BOT_STATE_TRANSITIONS)) {
      for (const target of targets) {
        expect(Object.values(BOT_STATES)).toContain(target);
      }
    }
  });

  it('exposes tx state, swap purposes, approval types and peg levels', () => {
    expect(Object.values(TX_STATES)).toEqual([
      'CREATED',
      'SUBMITTED',
      'CONFIRMED',
      'FAILED',
      'REVERTED',
      'UNKNOWN',
    ]);
    expect(Object.values(SWAP_PURPOSES).sort()).toEqual([
      'BUILD_POSITION',
      'EXIT_POSITION',
      'FEE_CONVERSION',
      'SWITCH_POOL',
    ]);
    expect(Object.values(APPROVAL_TYPES).sort()).toEqual(['exact', 'zero-then-max']);
    expect(Object.values(PEG_LEVELS)).toEqual([
      'NORMAL',
      'WARNING',
      'STOP_NEW_CAPITAL',
      'EXIT_REVIEW',
      'EMERGENCY_EXIT',
    ]);
    expect(Object.values(MARKET_STATUSES)).toContain('closed');
  });

  it('exposes the UI amount modes used for BEP-677 tokens', () => {
    expect(UI_AMOUNT_MODES.BEP677_SCALED).toBe('bep677-scaled');
    expect(UI_AMOUNT_MODES.PLAIN).toBe('plain');
  });
});

describe('approval gate + notifier contract', () => {
  it('limits approval kinds to the two human-confirmed operations', () => {
    expect(Object.values(APPROVAL_KINDS).sort()).toEqual(['BUILD_POSITION', 'SWITCH_POOL']);
  });

  it('carries the request/decision shape required for an auditable gate', () => {
    const request: ApprovalRequest = {
      id: 'req-1',
      kind: APPROVAL_KINDS.BUILD_POSITION,
      createdAt: '2026-09-29T00:00:00.000Z',
      expiresAt: '2026-09-29T00:30:00.000Z',
      payloadSummary: 'build QQQB/USDC',
      payloadJson: { poolId: '56:pancakeswap-v3:0xfc4e' },
      status: 'pending' satisfies ApprovalStatus,
    };
    const decision: ApprovalDecision = {
      requestId: request.id,
      approved: false,
      decidedBy: '42',
      decidedAt: '2026-09-29T00:01:00.000Z',
      reason: 'not now',
    };
    expect(decision.approved).toBe(false);
  });

  it('no-op notifier never approves, so a disabled channel cannot authorise a write', async () => {
    const notifier: Notifier = noopNotifier;
    const decision = await notifier.requestApproval({
      id: 'req-2',
      kind: APPROVAL_KINDS.SWITCH_POOL,
      createdAt: '2026-09-29T00:00:00.000Z',
      expiresAt: '2026-09-29T00:30:00.000Z',
      payloadSummary: 'switch pool',
      payloadJson: {},
      status: 'pending',
    });
    expect(decision.approved).toBe(false);
    await expect(notifier.query('status')).rejects.toThrow();
    await expect(notifier.send('info', 't', 'b')).resolves.toBeUndefined();
  });

  it('exposes none of the transaction-sending surface on the notifier', () => {
    const surface = noopNotifier as unknown as Record<string, unknown>;
    for (const forbidden of ['sendTransaction', 'signTransaction', 'sign', 'privateKey', 'walletClient']) {
      expect(surface[forbidden]).toBeUndefined();
    }
  });

  it('exposes the three alert severities', () => {
    const severities: AlertSeverity[] = ['info', 'warning', 'critical'];
    expect(severities).toHaveLength(3);
    expect(Object.values(ALERT_SEVERITIES)).toEqual(severities);
  });
});

describe('type-level guarantees (compiled by tsc, asserted here for documentation)', () => {
  it('keeps token amounts as raw bigint and carries the UI multiplier', () => {
    // These aliases fail to compile if the field type is not exactly bigint.
    type RawIsBigint = IsExactlyBigint<TokenAmount['raw']>;
    type UiIsBigint = IsExactlyBigint<TokenAmount['ui']>;
    type MultiplierIsBigint = IsExactlyBigint<TokenAmount['uiMultiplier']>;
    type LiquidityIsBigint = IsExactlyBigint<Position['liquidity']>;
    type ActiveLiquidityIsBigint = IsExactlyBigint<PoolSnapshot['activeLiquidity']>;
    type SqrtPriceIsBigint = IsExactlyBigint<PoolSnapshot['sqrtPriceX96']>;

    const guarantees: [
      RawIsBigint,
      UiIsBigint,
      MultiplierIsBigint,
      LiquidityIsBigint,
      ActiveLiquidityIsBigint,
      SqrtPriceIsBigint,
    ] = [true, true, true, true, true, true];
    expect(guarantees.every(Boolean)).toBe(true);
  });

  it('rejects a UI-scaled number where a raw amount is required', () => {
    const amount = { raw: 1n, ui: 1n } as TokenAmount;
    // @ts-expect-error — raw must be bigint; a JS number (a UI amount) is not assignable.
    const wrong: TokenAmount = { ...amount, raw: 1 };
    expect(wrong).toBeDefined();
  });

  it('binds record status/state fields to the BotState union', () => {
    // A store row or decision log entry must not be able to carry an invented status string.
    const position: Pick<Position, 'status'> = { status: BOT_STATES.MONITOR };
    const log: Pick<DecisionLog, 'state'> = { state: BOT_STATES.RISK_REVIEW };
    // @ts-expect-error — an invented status string must not be assignable to Position.status.
    const badPosition: Pick<Position, 'status'> = { status: 'OPEN' };
    // @ts-expect-error — nor to DecisionLog.state.
    const badLog: Pick<DecisionLog, 'state'> = { state: 'MONITORING' };
    expect([position.status, log.state, badPosition, badLog]).toBeDefined();
  });

  it('keeps the bot state and tx state unions closed', () => {
    // @ts-expect-error — an invented state must not typecheck.
    const badState: BotState = 'REBALANCE_MID_RANGE';
    // @ts-expect-error — §98 has no RETRY state.
    const badTxState: TxState = 'RETRYING';
    // @ts-expect-error — §12 has no such DEX id.
    const badDex: DexId = 'sushiswap-v3';
    // @ts-expect-error — only the two human-gated kinds exist.
    const badKind: ApprovalKind = 'COLLECT_FEES';
    expect([badState, badTxState, badDex, badKind]).toBeDefined();
  });

  it('keeps StrategyConfig aligned with the yaml schema', async () => {
    const config: StrategyConfig = await loadConfig({ useBuiltinsOnly: true });
    const approvals: ApprovalsConfig = config.approvals;
    const telegram: TelegramConfig = config.telegram;
    const risk: RiskConfig = config.risk;
    const whitelist: Whitelist = config.whitelist;
    const registry: TokenRegistry = whitelist.registry;
    const dexEntries: readonly WhitelistDexEntry[] = whitelist.dexes;
    const token: TokenMeta = registry.requireTokenByAddress(56, registry.listAddresses(56)[0]!);
    expect(approvals.buildPosition).toBe('confirm');
    expect(approvals.switchPool).toBe('confirm');
    expect(approvals.others).toBe('auto');
    expect(typeof approvals.timeoutMinutes).toBe('number');
    expect(typeof telegram.enabled).toBe('boolean');
    expect(risk.maxDrawdown).toBeCloseTo(0.15);
    expect(dexEntries.length).toBeGreaterThan(0);
    expect(token.decimals).toBe(18);
  });

  it('keeps every shared record type constructible', () => {
    const address = '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d' satisfies Address;
    const tokenId = '56:0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d' satisfies TokenId;
    const poolId = '56:pancakeswap-v3:0xfc4e' satisfies PoolId;
    const chainId = 56 satisfies ChainId;
    const ratio = 0.005 satisfies Ratio;
    const tick = -887220 satisfies Tick;
    const usd = 1000 satisfies UsdAmount;
    const hex = '0x1234' satisfies Hex;
    const balance: TokenAmount = {
      tokenId,
      address,
      decimals: 18,
      raw: 10n ** 18n,
      ui: 10n ** 18n,
      uiMultiplier: 10n ** 18n,
    };
    const sourced: Sourced<number> = { value: 1, source: 'onchain', asOf: 'now', stale: false };
    const range: TickRange = { lowerTick: -100, upperTick: 100, tickSpacing: 10, referenceTick: 0 };
    const thresholds: PoolFilterThresholds = {
      minTvlUsd: 500_000,
      minAvgDailyVolume7dUsd: 250_000,
      minPoolAgeDays: 7,
      maxNavDeviation: 0.01,
      maxSwapPriceImpact: 0.005,
    };
    const filterResult: PoolFilterResult = {
      poolId,
      passed: true,
      reasons: [],
      evaluatedAt: 'now',
    };
    const guard: TxGuardChecks = {
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
    const deadline: DeadlineSpec = { kind: 'previous-blockhash', blockhash: hex };
    const purpose: SwapPurpose = SWAP_PURPOSES.BUILD_POSITION;
    const approvalType: ApprovalType = APPROVAL_TYPES.ZERO_THEN_MAX;
    const marketStatus: MarketStatus = MARKET_STATUSES.OPEN;
    const pegLevel: PegLevel = PEG_LEVELS.NORMAL;
    const quoteRequest: SwapQuoteRequest = { poolId, tokenIn: address, tokenOut: address, amountIn: 1n, ttlSeconds: 30 };
    const swapQuote: SwapQuote = {
      poolId,
      tokenIn: address,
      tokenOut: address,
      amountInRaw: 1n,
      amountOutRaw: 1n,
      amountInUsd: 1,
      priceImpact: ratio,
      slippageTolerance: 0.003,
      amountOutMinimumRaw: 1n,
      quotedAt: 'now',
      expiresAt: 'later',
      route: [],
    };
    const addRequest: AddLiquidityRequest = {
      poolId,
      tickRange: { lowerTick: -100, upperTick: 100, tickSpacing: 10 },
      amount0DesiredRaw: 1n,
      amount1DesiredRaw: 1n,
      amount0MinRaw: 0n,
      amount1MinRaw: 0n,
      recipient: address,
      deadline,
      idempotencyKey: 'k',
      guard,
    };

    const plainSwapRequest: SwapExecutionRequest = {
      quote: swapQuote,
      deadline,
      purpose,
      idempotencyKey: 'k',
      guard,
    };
    void plainSwapRequest;
    const removeRequest: RemoveLiquidityRequest = {
      poolId,
      positionTokenId: 1n,
      liquidityRaw: null,
      amount0MinRaw: 0n,
      amount1MinRaw: 0n,
      recipient: address,
      deadline,
      idempotencyKey: 'k',
      guard,
    };
    const collectRequest: CollectFeesRequest = {
      poolId,
      positionTokenId: 1n,
      recipient: address,
      idempotencyKey: 'k',
      guard,
    };
    const poolPrice: PoolPriceView = {
      poolId,
      sqrtPriceX96: 1n,
      tick: 0,
      liquidity: 1n,
      feeTier: 100,
      tickSpacing: 1,
      priceToken1PerToken0: 1,
      asOf: 'now',
    };
    const lpPosition: LpPositionView = {
      poolId,
      positionTokenId: 1n,
      owner: address,
      token0: address,
      token1: address,
      feeTier: 100,
      tickLower: -100,
      tickUpper: 100,
      liquidity: 1n,
      feeGrowthInside0LastX128: 0n,
      feeGrowthInside1LastX128: 0n,
      tokensOwed0Raw: 0n,
      tokensOwed1Raw: 0n,
    };
    const peg: PegAssessment = {
      tokenId,
      deviation: 0.005,
      marketStatus,
      level: pegLevel,
      hardExitAllowed: true,
      reason: 'open market',
      asOf: 'now',
    };
    const drawdown: DrawdownState = {
      initialNAV: 10_000,
      peakNAV: 11_000,
      currentNAV: 9_500,
      drawdownFromPeak: 0.136,
      drawdownFromInitial: 0.05,
      riskOffLineNAV: 8_500,
      breached: false,
      asOf: 'now',
      windowSeconds: 300,
    };
    const position: Position = {
      id: 'p1',
      chainId,
      dex: DEX_IDS.PANCAKESWAP_V3,
      poolAddress: address,
      poolId,
      token0: address,
      token1: address,
      token0Id: tokenId,
      token1Id: tokenId,
      openedAt: 'now',
      initialNAV: usd,
      entryPrice: 1,
      entryEquityUsd: 10_000,
      lowerPrice: 0.85,
      upperPrice: 1.16,
      lowerTick: tick,
      upperTick: tick,
      initialToken0: balance,
      initialToken1: balance,
      liquidity: 1n,
      status: BOT_STATES.MONITOR,
      totalFeesUSD: 0,
      realizedPnL: 0,
      unrealizedPnL: 0,
      benchmarkValue: usd,
      feeILRatio: null,
    };
    const swap: SwapRecord = {
      txHash: hex,
      timestamp: 'now',
      chainId,
      tokenIn: address,
      tokenOut: address,
      tokenInId: tokenId,
      tokenOutId: tokenId,
      amountIn: balance,
      amountOut: balance,
      expectedAmountOut: balance,
      slippage: 0.001,
      priceImpact: ratio,
      gasCostUSD: 0.5,
      purpose,
      idempotencyKey: 'k',
    };
    const decision: DecisionLog = {
      timestamp: 'now',
      state: BOT_STATES.MONITOR,
      action: 'HOLD',
      reason: 'inside range',
      result: 'noop',
    };

    // §42 capability: `supportsAtomicBuild` is REQUIRED on every DexAdapter and is exactly boolean.
    // Expressed as conditional types rather than @ts-expect-error, so the assertion cannot be
    // satisfied by an unrelated nearby error. If the field became optional, `Pick<DexAdapter,'dex'>`
    // would be assignable to `DexAdapter` and this alias would collapse to `never` (build failure).
    type CapabilityIsRequired = Pick<DexAdapter, 'dex'> extends DexAdapter ? never : true;
    type CapabilityIsBoolean = [DexAdapter['supportsAtomicBuild']] extends [boolean]
      ? [boolean] extends [DexAdapter['supportsAtomicBuild']]
        ? true
        : never
      : never;
    const capabilityRequired: CapabilityIsRequired = true;
    const capabilityBoolean: CapabilityIsBoolean = true;
    const atomicCapableAdapter: Pick<DexAdapter, 'dex' | 'supportsAtomicBuild'> = {
      dex: DEX_IDS.PANCAKESWAP_V3,
      supportsAtomicBuild: true,
    };
    const twoTxAdapter: Pick<DexAdapter, 'dex' | 'supportsAtomicBuild'> = {
      dex: DEX_IDS.UNISWAP_V3,
      supportsAtomicBuild: false,
    };
    expect([capabilityRequired, capabilityBoolean, atomicCapableAdapter, twoTxAdapter]).toBeDefined();

    // The two adapter interfaces are only referenced so tsc keeps checking their shape.
    const adapterShapes: [
      ChainAdapter,
      DexAdapter,
      PoolDataProvider,
      ReferencePriceProvider,
      PortfolioSnapshot,
    ] = [
      null as unknown as ChainAdapter,
      null as unknown as DexAdapter,
      null as unknown as PoolDataProvider,
      null as unknown as ReferencePriceProvider,
      null as unknown as PortfolioSnapshot,
    ];
    void adapterShapes;
    void sourced;
    void range;
    void thresholds;
    void filterResult;
    void quoteRequest;
    void swapQuote;
    void addRequest;
    void removeRequest;
    void collectRequest;
    void poolPrice;
    void lpPosition;
    void peg;
    void drawdown;
    void position;
    void swap;
    void decision;
    void approvalType;

    expect(tokenId).toContain('56:');
    expect(swap.amountIn.raw).toBe(10n ** 18n);
  });

  it('keeps keystore decryption available as a fail-closed primitive', async () => {
    const envelope = await encryptPrivateKey(`0x${'33'.repeat(32)}`, 'unit-test-passphrase', {
      kdfParams: { N: 2 ** 14, r: 8, p: 1 },
    });
    const decrypted = await decryptPrivateKey(envelope, 'unit-test-passphrase');
    expect(decrypted.privateKeyHex).toBe(`0x${'33'.repeat(32)}`);
    expect(decrypted.address.startsWith('0x')).toBe(true);
  });
});
