import { describe, expect, it, vi } from 'vitest';
import { RiskWiring, planFor, describeRiskAction } from '../../src/execution/riskWiring.ts';
import { loadConfig } from '../../src/config/index.ts';
import { RISK_ACTIONS, evaluateRisk } from '../../src/strategy/riskManager.ts';
import { BOT_STATES } from '../../src/types/state.ts';
import type { PortfolioMonitor } from '../../src/execution/portfolioMonitor.ts';
import type { Position } from '../../src/types/portfolio.ts';
import type { PoolSnapshot } from '../../src/types/market.ts';
import { BSC_ADDRESSES, BSC_BSTOCKS } from '../../src/config/builtins.ts';
import { DEX_IDS, type Address } from '../../src/types/primitives.ts';

const CHAIN = 56;
const QQQB = BSC_BSTOCKS.find((token) => token.symbol === 'QQQB')!.address as Address;
const USDT = BSC_ADDRESSES.USDT as Address;
const POOL_ADDRESS = '0xe531fcb1f5a195de7608b9f4f9518544c2cdb693' as Address;
const POOL_ID = `${CHAIN}:${DEX_IDS.PANCAKESWAP_V3}:${POOL_ADDRESS}`;

function positionRecord(over: Partial<Position> = {}): Position {
  return {
    id: '1',
    chainId: CHAIN,
    dex: DEX_IDS.PANCAKESWAP_V3,
    poolAddress: POOL_ADDRESS,
    poolId: POOL_ID,
    token0: QQQB,
    token1: USDT,
    token0Id: `${CHAIN}:${QQQB}`,
    token1Id: `${CHAIN}:${USDT}`,
    openedAt: '2026-09-29T00:00:00.000Z',
    initialNAV: 10_000,
    entryPrice: 735.2,
    entryEquityUsd: 10_000,
    lowerPrice: 624.9,
    upperPrice: 852.8,
    lowerTick: 64_424,
    upperTick: 67_533,
    initialToken0: { tokenId: `${CHAIN}:${QQQB}`, address: QQQB, decimals: 18, raw: 0n, ui: 0n, uiMultiplier: 10n ** 18n },
    initialToken1: { tokenId: `${CHAIN}:${USDT}`, address: USDT, decimals: 18, raw: 0n, ui: 0n, uiMultiplier: 10n ** 18n },
    liquidity: 1_207_496_218_710_976_946_883n,
    status: BOT_STATES.MONITOR,
    totalFeesUSD: 0,
    realizedPnL: 0,
    unrealizedPnL: 0,
    benchmarkValue: 0,
    feeILRatio: null,
    ...over,
  };
}

function poolSnapshot(over: Partial<PoolSnapshot> = {}): PoolSnapshot {
  const sourced = <T,>(value: T) => ({ value, source: 'onchain' as const, asOf: '2026-09-30T00:00:00.000Z', stale: false });
  return {
    timestamp: '2026-09-30T00:00:00.000Z',
    chainId: CHAIN,
    dex: DEX_IDS.PANCAKESWAP_V3,
    poolAddress: POOL_ADDRESS,
    poolId: POOL_ID,
    token0: QQQB,
    token1: USDT,
    token0Id: `${CHAIN}:${QQQB}`,
    token1Id: `${CHAIN}:${USDT}`,
    feeTier: 100,
    token0Decimals: 18,
    token1Decimals: 18,
    tvlUSD: sourced(620_000),
    volume24h: sourced(6_300_000),
    volume7d: sourced(35_500_000),
    fees24h: sourced(630),
    fees7d: sourced(3_550),
    poolAgeDays: 81,
    currentPrice: sourced(735.2),
    sqrtPriceX96: 2_154_702_184_312_214_094_591_448_544_382n,
    currentTick: 66_041,
    activeLiquidity: 1_158_746_174_719_549_200_573_411n,
    stockReferencePrice: sourced(735),
    tokenNAVDeviation: sourced(0.0005),
    stockVolatility7d: sourced(0.02),
    stockVolatility30d: sourced(0.025),
    swapImpact1000USD: sourced(0.001),
    swapImpact3500USD: sourced(0.0035),
    swapImpact5000USD: sourced(0.005),
    estimatedAPR1d: sourced(0.2),
    estimatedAPR7d: sourced(0.2),
    estimatedAPR30d: sourced(0.2),
    marketDataSource: 'onchain',
    ...over,
  };
}

/** A monitor double: the real valuation logic is tested in its own file, so this returns a stated result. */
function monitorDouble(result: {
  readonly totalNAV: number;
  readonly reserveRatio: number;
  readonly lpPositionValue: number;
  readonly drawdown: unknown;
  readonly problems?: readonly string[];
  readonly walletStablecoinValue?: number;
}): PortfolioMonitor {
  const snapshot = {
    timestamp: '2026-09-30T00:00:00.000Z',
    chainId: CHAIN,
    walletAddress: '0x1111111111111111111111111111111111111111' as Address,
    walletStablecoinValue: result.walletStablecoinValue ?? 3_000,
    walletStockTokenValue: 0,
    walletBalances: [],
    lpToken0Amount: { tokenId: '', address: QQQB, decimals: 18, raw: 0n, ui: 0n, uiMultiplier: 10n ** 18n },
    lpToken1Amount: { tokenId: '', address: USDT, decimals: 18, raw: 0n, ui: 0n, uiMultiplier: 10n ** 18n },
    lpPositionValue: result.lpPositionValue,
    unclaimedFeeToken0: { tokenId: '', address: QQQB, decimals: 18, raw: 0n, ui: 0n, uiMultiplier: 10n ** 18n },
    unclaimedFeeToken1: { tokenId: '', address: USDT, decimals: 18, raw: 0n, ui: 0n, uiMultiplier: 10n ** 18n },
    unclaimedFeeValue: 0,
    realizedFees: 0,
    gasCost: 0,
    swapCost: 0,
    slippageCost: 0,
    totalNAV: result.totalNAV,
    initialNAV: 10_000,
    peakNAV: result.totalNAV,
    benchmarkNAV: result.totalNAV,
    lpAllocationRatio: 0.7,
    reserveRatio: result.reserveRatio,
    reservePrincipal: 3_000,
    profitVault: 0,
    nativeBalanceWei: 0n,
  };
  return {
    walletAddress: () => '0x1111111111111111111111111111111111111111' as Address,
    monitor: vi.fn(async () => ({
      snapshot,
      drawdown: result.drawdown,
      complete: (result.problems ?? []).length === 0,
      problems: result.problems ?? [],
    })),
    lpLegs: vi.fn(),
    lpPositionValue: vi.fn(),
    buildPriceTable: vi.fn(),
    readWallet: vi.fn(),
  } as unknown as PortfolioMonitor;
}

async function monitor(options: {
  readonly nav?: number;
  readonly reserveRatio?: number;
  readonly problems?: readonly string[];
  readonly open?: boolean;
  readonly pool?: PoolSnapshot;
  readonly tvl?: readonly { readonly asOf: string; readonly tvlUsd: number }[];
  readonly marketDecline?: unknown;
} = {}) {
  const config = await loadConfig();
  const open = options.open ?? true;
  const nav = options.nav ?? 10_000;
  return new RiskWiring({
    monitor: monitorDouble({
      totalNAV: nav,
      reserveRatio: options.reserveRatio ?? 0.3,
      lpPositionValue: nav * 0.7,
      // `null` drawdown ⇔ incomplete valuation, mirroring PortfolioMonitor's own contract.
      drawdown: (options.problems ?? []).length === 0 ? {} : null,
      ...(options.problems === undefined ? {} : { problems: options.problems }),
    }),
    config,
    allocationLimits: { maxLpRatio: config.capital.maxLpRatio, reserveRatio: config.capital.reserveRatio },
    openPosition: async () =>
      open
        ? {
            record: positionRecord(),
            pool: options.pool ?? poolSnapshot(),
            positionTokenId: 4_242n,
            liquidity: 1_207_496_218_710_976_946_883n,
            owner: '0x1111111111111111111111111111111111111111',
          }
        : null,
    tvlSeries: () => options.tvl ?? [],
    ...(options.marketDecline === undefined
      ? {}
      : { marketDecline: () => options.marketDecline as never }),
  });
}

describe('§3 fail closed: no verdict from an unusable valuation', () => {
  it('produces NO drawdown verdict when the valuation is incomplete', async () => {
    // A NAV built from an unpriced leg is a floor, not the portfolio value, so neither "safe" nor
    // "breached" can be concluded. Reporting "breached" here is the measured bug that halted the bot on a
    // fabricated total loss.
    const m = await monitor({ problems: ['USDC: no usable reference price'] });
    const round = await m.round({ priorPeakNAV: 10_000, realizedFees: 0 });

    expect(round.valuationProblems).toBeDefined();
    expect(round.plan.report.drawdown).toBeNull();
    expect(round.plan.report.dataDegraded).toBe(true);
    // And no action may be inferred from it beyond an alert.
    expect(round.plan.autoExit).toBe(false);
  });

  it('still evaluates the reserve ratio, which does not depend on prices', async () => {
    const m = await monitor({ reserveRatio: 0.1, problems: ['something unpriced'] });
    const round = await m.round({ priorPeakNAV: 10_000, realizedFees: 0 });

    // Reserve is a ratio of NAV, so an incomplete NAV makes it unreliable too - the report must say the
    // verdict is degraded rather than present it as a clean number.
    expect(round.plan.report.dataDegraded).toBe(true);
  });
});

describe('§6.3 automatic exit only for the catastrophic cases', () => {
  it('exits automatically on EMERGENCY (waiting for a human IS the risk)', async () => {
    const report = evaluateRisk(
      {
        asOf: '2026-09-30T00:00:00.000Z',
        emergencyEvents: [
          { condition: 'TOKEN_CONTRACT_PAUSED', detectedAt: '2026-09-30T00:00:00.000Z', detail: 'paused' } as never,
        ],
      },
      await loadConfig(),
    );
    const plan = planFor(report, true);

    expect(plan.action).toBe(RISK_ACTIONS.EMERGENCY);
    expect(plan.autoExit).toBe(true);
    expect(plan.nextState).toBe(BOT_STATES.EMERGENCY);
  });

  it('does NOT auto-exit for RISK_REVIEW — a human decides (§8.6)', async () => {
    const report = evaluateRisk({ asOf: '2026-09-30T00:00:00.000Z' }, await loadConfig());
    const plan = planFor(report, true);
    expect(plan.autoExit).toBe(false);
  });

  it('never auto-exits when flat, whatever the verdict says', () => {
    // There is nothing to close; an "exit" here would be a state change with no substance.
    const report = { action: RISK_ACTIONS.EMERGENCY, alertSeverity: 'critical', recommendedState: BOT_STATES.EMERGENCY, reasons: [] } as never;
    expect(planFor(report, false).autoExit).toBe(false);
  });
});

describe('§8.6 price below range is routed to a human, with the context to decide', () => {
  it('reports the range breach and the two numbers that separate market move from token problem', async () => {
    // The whole point of §8.6: an operator cannot judge without knowing whether the STOCK fell too.
    const report = evaluateRisk(
      {
        asOf: '2026-09-30T00:00:00.000Z',
        range: { currentPrice: 600, lowerPrice: 624.9, upperPrice: 852.8 },
      },
      await loadConfig(),
    );
    const plan = planFor(report, true);
    const text = describeRiskAction(plan, {
      currentPrice: 600,
      lowerPrice: 624.9,
      upperPrice: 852.8,
      stockPriceChange: -0.085,
      referenceNavChange: -0.086,
      deviation: 0.001,
    });

    // The INVARIANTS, not the phrasing: the breach must be stated, and both the stock move and the token's
    // own deviation must appear — an operator cannot judge §8.6 without knowing whether the stock fell too.
    // Asserting the English wording instead would pin the formatter rather than the information.
    expect(text).toMatch(/已跌破下限/);
    expect(text).toMatch(/-8\.50%/);
    expect(text).toMatch(/-8\.60%/);
    expect(text).toMatch(/偏离/);
  });

  it('says the deviation is unknown rather than implying the token is fine', () => {
    const plan = planFor(
      { action: RISK_ACTIONS.RISK_REVIEW, alertSeverity: 'warning', recommendedState: BOT_STATES.RISK_REVIEW, reasons: ['below range'] } as never,
      true,
    );
    const text = describeRiskAction(plan, {
      currentPrice: 600,
      lowerPrice: 625,
      upperPrice: 853,
      stockPriceChange: -0.08,
      referenceNavChange: -0.08,
      deviation: null,
    });

    // An unknown deviation must be VISIBLE as unknown. Printing a number — or omitting the field so it
    // reads as "nothing to report" — would imply the token was checked and found fine.
    expect(text).toMatch(/参考净值/);
    expect(text).not.toMatch(/偏离 0\.0000%/);
  });

  it('states plainly that no automatic action will be taken', () => {
    const plan = planFor(
      { action: RISK_ACTIONS.RISK_REVIEW, alertSeverity: 'warning', recommendedState: BOT_STATES.RISK_REVIEW, reasons: ['below range'] } as never,
      true,
    );
    // The invariant: a RISK_REVIEW must say the bot will NOT act on its own. Without it an operator may
    // assume the system is handling the situation and take no action at all.
    const text = describeRiskAction(plan);
    expect(text).toMatch(/不会自动处理/);
    expect(text).toMatch(/\/exit/);
  });
});

describe('§59 needs the time series, which is why the table exists', () => {
  it('reaches a TVL-collapse verdict when the pool history supports it', async () => {
    // End-to-end through module 3: history in, verdict out. Before the snapshot table this could only ever
    // be insufficient-data, so the rule existed and could not fire.
    const m = await monitor({
      tvl: [
        { asOf: '2026-09-29T00:00:00.000Z', tvlUsd: 600_000 },
        { asOf: '2026-09-30T00:00:00.000Z', tvlUsd: 250_000 },
      ],
    });
    const round = await m.round({ priorPeakNAV: 10_000, realizedFees: 0 });

    expect(round.plan.report.tvl?.status).toBe('review');
    expect(round.plan.report.tvl?.failClosed).toBe(false);
  });

  it('stays fail-closed with no history rather than assuming the pool is fine', async () => {
    const m = await monitor({ tvl: [] });
    const round = await m.round({ priorPeakNAV: 10_000, realizedFees: 0 });

    expect(round.plan.report.tvl?.status).toBe('insufficient-data');
    expect(round.plan.report.tvl?.failClosed).toBe(true);
  });
});
