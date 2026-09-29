/**
 * T6 offline tests for `src/data/poolFilter.ts` — §16 hard filters, one condition per test, every
 * boundary stated in the §16 text plus the fail-closed behaviour that makes a stale/unavailable
 * figure a rejection reason instead of a numeric near-miss.
 *
 * Thresholds are read from the real config (`config/strategy.yaml` via `loadConfig`), never
 * hardcoded at the call site, so "loosening the YAML and the verdict changes" is itself asserted.
 * Everything runs without network.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.ts';
import {
  POOL_FILTER_CODES,
  describeThresholds,
  evaluatePoolFilters,
  filterPools,
  type PoolFilterEvaluation,
} from '../../src/data/poolFilter.ts';
import { poolIdFor } from '../../src/data/poolDataProvider.ts';
import { DEX_IDS, type Address } from '../../src/types/primitives.ts';
import { createWhitelist } from '../../src/config/index.ts';
import { DATA_SOURCES, type PoolFilterThresholds, type PoolSnapshot, type Sourced } from '../../src/types/market.ts';
import type { Whitelist } from '../../src/types/registry.ts';

/* ------------------------------------------------------------------ *
 * Real BSC addresses (research §1/§4.1) — identity is the address (§8)
 * ------------------------------------------------------------------ */

const QQQB = '0x205812cdbed920aff76c6580abd681a46d11efc7' as Address;
const USDC = '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d' as Address;
const USDT = '0x55d398326f99059ff775485246999027b3197955' as Address;
/** The measured same-symbol impostor (research §1): NOT in the builtin whitelist. */
const QQQB_IMPOSTOR = '0xb904108b7f6d3b27c23128ca2b62738061b8a689' as Address;

/** QQQB/USDT @ PancakeSwap V3 0.01% (research §4.1). */
const POOL_ADDRESS = '0xe531fcb1f5a195de7608b9f4f9518544c2cdb693' as Address;

const CHAIN_ID = 56;
const EVALUATED_AT = '2026-09-29T09:50:00.000Z';

let whitelist: Whitelist;
let thresholds: PoolFilterThresholds;
let config: Awaited<ReturnType<typeof loadConfig>>;

beforeAll(async () => {
  config = await loadConfig();
  whitelist = config.whitelist;
  thresholds = config.pool;
});

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

function sourced<T>(value: T, source: Sourced<T>['source'], stale = false): Sourced<T> {
  return { value, source, asOf: EVALUATED_AT, stale };
}

interface SnapshotOverrides {
  readonly token0?: Address;
  readonly token1?: Address;
  readonly dex?: PoolSnapshot['dex'];
  readonly poolId?: string;
  readonly poolAddress?: Address;
  readonly tvlUSD?: Sourced<number>;
  readonly volume24h?: Sourced<number>;
  readonly volume7d?: Sourced<number>;
  readonly poolAgeDays?: number;
  readonly tokenNAVDeviation?: Sourced<number | null>;
  readonly swapImpact3500USD?: Sourced<number>;
}

/** A snapshot that passes every §16 condition; each test perturbs exactly one field. */
function snapshot(overrides: SnapshotOverrides = {}): PoolSnapshot {
  const token0 = overrides.token0 ?? QQQB;
  const token1 = overrides.token1 ?? USDT;
  const dex = overrides.dex ?? DEX_IDS.PANCAKESWAP_V3;
  const registry = whitelist.registry;
  return {
    timestamp: EVALUATED_AT,
    chainId: CHAIN_ID,
    dex,
    poolAddress: overrides.poolAddress ?? POOL_ADDRESS,
    poolId: overrides.poolId ?? poolIdFor(CHAIN_ID, dex, POOL_ADDRESS),
    token0,
    token1,
    token0Id: registry.idFor(CHAIN_ID, token0),
    token1Id: registry.idFor(CHAIN_ID, token1),
    feeTier: 100,
    token0Decimals: 18,
    token1Decimals: 18,
    tvlUSD: overrides.tvlUSD ?? sourced(1_770_000, DATA_SOURCES.GECKOTERMINAL),
    volume24h: overrides.volume24h ?? sourced(1_340_000, DATA_SOURCES.GECKOTERMINAL),
    volume7d: overrides.volume7d ?? sourced(7_000_000, DATA_SOURCES.DEXPAPRIKA),
    fees24h: sourced(13_400, DATA_SOURCES.DERIVED),
    fees7d: sourced(70_000, DATA_SOURCES.DERIVED),
    poolAgeDays: overrides.poolAgeDays ?? 81,
    createdAt: '2026-07-10T00:00:00.000Z',
    currentPrice: sourced(601.25, DATA_SOURCES.GECKOTERMINAL),
    sqrtPriceX96: 0n,
    currentTick: 0,
    activeLiquidity: 0n,
    stockReferencePrice: sourced(601.25, DATA_SOURCES.BINANCE_INDEX),
    tokenNAVDeviation: overrides.tokenNAVDeviation ?? sourced(0.0005, DATA_SOURCES.DERIVED),
    stockVolatility7d: sourced(0.01, DATA_SOURCES.GECKOTERMINAL),
    stockVolatility30d: sourced(0.02, DATA_SOURCES.GECKOTERMINAL),
    swapImpact1000USD: sourced(0.0008, DATA_SOURCES.ONCHAIN),
    swapImpact3500USD: overrides.swapImpact3500USD ?? sourced(0.0021, DATA_SOURCES.ONCHAIN),
    swapImpact5000USD: sourced(0.003, DATA_SOURCES.ONCHAIN),
    estimatedAPR1d: sourced(0.1, DATA_SOURCES.DERIVED),
    estimatedAPR7d: sourced(0.09, DATA_SOURCES.DERIVED),
    estimatedAPR30d: sourced(0.08, DATA_SOURCES.DERIVED),
    marketDataSource: DATA_SOURCES.GECKOTERMINAL,
  };
}

function evaluate(overrides: SnapshotOverrides = {}): PoolFilterEvaluation {
  return evaluatePoolFilters(snapshot(overrides), thresholds, {
    evaluatedAt: EVALUATED_AT,
    whitelist,
    onchainVerified: true,
  });
}

function checkFor(evaluation: PoolFilterEvaluation, condition: string) {
  const check = evaluation.checks.find((entry) => entry.condition === condition);
  expect(check, `no check for condition ${condition}`).toBeDefined();
  return check!;
}

function reasonFor(evaluation: PoolFilterEvaluation, code: string): string {
  const reason = evaluation.reasons.find((entry) => entry.startsWith(`[${code}]`));
  expect(reason, `no reason with code ${code}: ${evaluation.reasons.join(' | ')}`).toBeDefined();
  return reason!;
}

/* ------------------------------------------------------------------ *
 * Thresholds come from config
 * ------------------------------------------------------------------ */

describe('thresholds are the §16 config values, never literals', () => {
  it('resolves the §16 defaults from config/strategy.yaml', () => {
    expect(thresholds).toEqual({
      minTvlUsd: 500_000,
      minAvgDailyVolume7dUsd: 250_000,
      minPoolAgeDays: 7,
      maxNavDeviation: 0.01,
      maxSwapPriceImpact: 0.005,
    });
    expect(describeThresholds(thresholds)).toEqual([
      'TVL >= $500,000',
      '7D Avg Daily Volume >= $250,000',
      'Pool Age >= 7.000d',
      'Token/NAV Deviation < 1.0000%',
      '$3500 Swap Price Impact < 0.5000%',
    ]);
  });

  it('a passing baseline snapshot really does pass every §16 condition', () => {
    const evaluation = evaluate();
    expect(evaluation.reasons).toEqual([]);
    expect(evaluation.passed).toBe(true);
    expect(evaluation.complete).toBe(true);
    expect(evaluation.checks).toHaveLength(13);
  });

  it('changing a config threshold flips the verdict without touching the snapshot', () => {
    const pool = snapshot({ tvlUSD: sourced(520_000, DATA_SOURCES.GECKOTERMINAL) });
    const options = { evaluatedAt: EVALUATED_AT, whitelist, onchainVerified: true };
    const strict: PoolFilterThresholds = { ...thresholds, minTvlUsd: 600_000 };
    expect(evaluatePoolFilters(pool, thresholds, options).passed).toBe(true);
    const evaluation = evaluatePoolFilters(pool, strict, options);
    expect(evaluation.passed).toBe(false);
    expect(evaluation.failedCodes).toEqual([POOL_FILTER_CODES.TVL_BELOW_MINIMUM]);
  });
});

/* ------------------------------------------------------------------ *
 * §16 TVL >= $500,000
 * ------------------------------------------------------------------ */

describe('§16 TVL >= min_tvl_usd', () => {
  it('exactly at the threshold passes (>= not >)', () => {
    const evaluation = evaluate({ tvlUSD: sourced(thresholds.minTvlUsd, DATA_SOURCES.GECKOTERMINAL) });
    const check = checkFor(evaluation, 'tvl');
    expect(check.comparison).toBe('>=');
    expect(check.actual).toBe(500_000);
    expect(check.threshold).toBe(500_000);
    expect(check.passed).toBe(true);
    expect(evaluation.passed).toBe(true);
  });

  it('one cent below the threshold is rejected with the actual value and the threshold named', () => {
    const evaluation = evaluate({
      tvlUSD: sourced(thresholds.minTvlUsd - 0.01, DATA_SOURCES.GECKOTERMINAL),
    });
    expect(evaluation.passed).toBe(false);
    expect(evaluation.failedCodes).toContain(POOL_FILTER_CODES.TVL_BELOW_MINIMUM);
    const reason = reasonFor(evaluation, POOL_FILTER_CODES.TVL_BELOW_MINIMUM);
    expect(reason).toContain('tvlUSD $499,999.99');
    expect(reason).toContain('>= $500,000');
    expect(evaluation.complete).toBe(true); // a real value, so the rejection is on merit
  });
});

/* ------------------------------------------------------------------ *
 * §16 7D Avg Daily Volume >= $250,000
 * ------------------------------------------------------------------ */

describe('§16 7D avg daily volume >= min_avg_daily_volume_7d', () => {
  it('compares the 7-DAY AVERAGE, so a 7d sum of exactly 250 000 FAILS', () => {
    const evaluation = evaluate({
      volume7d: sourced(thresholds.minAvgDailyVolume7dUsd, DATA_SOURCES.DEXPAPRIKA),
    });
    const check = checkFor(evaluation, 'avgDailyVolume7d');
    expect(check.actual).toBe(250_000 / 7);
    expect(check.passed).toBe(false);
    expect(evaluation.passed).toBe(false);
    // The reason spells out both numbers, so "sum vs average" cannot be misread from the log.
    const reason = reasonFor(evaluation, POOL_FILTER_CODES.VOLUME_7D_BELOW_MINIMUM);
    expect(reason).toContain('avg daily volume 7D $35,714.29');
    expect(reason).toContain('7D total $250,000');
  });

  it('a 7d sum of exactly 7 × 250 000 passes', () => {
    const evaluation = evaluate({
      volume7d: sourced(thresholds.minAvgDailyVolume7dUsd * 7, DATA_SOURCES.DEXPAPRIKA),
    });
    const check = checkFor(evaluation, 'avgDailyVolume7d');
    expect(check.actual).toBe(250_000);
    expect(check.passed).toBe(true);
    expect(evaluation.passed).toBe(true);
  });

  it('one cent below the 7d average is rejected', () => {
    const evaluation = evaluate({
      volume7d: sourced(thresholds.minAvgDailyVolume7dUsd * 7 - 0.07, DATA_SOURCES.DEXPAPRIKA),
    });
    expect(evaluation.passed).toBe(false);
    expect(evaluation.failedCodes).toEqual([POOL_FILTER_CODES.VOLUME_7D_BELOW_MINIMUM]);
  });

  it('a high 24h volume does not substitute for the 7d average', () => {
    // $6.5M in 24h but only $700k over the week (≈$100k/day) — §16 gates on the 7d average.
    const evaluation = evaluate({
      volume24h: sourced(6_500_000, DATA_SOURCES.GECKOTERMINAL),
      volume7d: sourced(700_000, DATA_SOURCES.DEXPAPRIKA),
    });
    expect(evaluation.passed).toBe(false);
    expect(evaluation.failedCodes).toEqual([POOL_FILTER_CODES.VOLUME_7D_BELOW_MINIMUM]);
  });
});

/* ------------------------------------------------------------------ *
 * §16 Pool Age >= 7 days
 * ------------------------------------------------------------------ */

describe('§16 pool age >= min_pool_age_days', () => {
  it('exactly 7.0 days passes', () => {
    const evaluation = evaluate({ poolAgeDays: thresholds.minPoolAgeDays });
    const check = checkFor(evaluation, 'poolAge');
    expect(check.comparison).toBe('>=');
    expect(check.passed).toBe(true);
    expect(evaluation.passed).toBe(true);
  });

  it('6.999 days is rejected', () => {
    const evaluation = evaluate({ poolAgeDays: 6.999 });
    expect(evaluation.passed).toBe(false);
    expect(evaluation.failedCodes).toEqual([POOL_FILTER_CODES.POOL_TOO_YOUNG]);
    expect(reasonFor(evaluation, POOL_FILTER_CODES.POOL_TOO_YOUNG)).toContain('pool age 6.999d >= 7.000d');
  });

  it('an unknown creation time is unavailable, not "too young"', () => {
    const evaluation = evaluate({ poolAgeDays: Number.NaN });
    expect(evaluation.passed).toBe(false);
    expect(evaluation.failedCodes).toEqual([POOL_FILTER_CODES.POOL_AGE_UNAVAILABLE]);
    expect(checkFor(evaluation, 'poolAge').actual).toBeNull();
    expect(evaluation.complete).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * §16 Token/NAV Deviation < 1%
 * ------------------------------------------------------------------ */

describe('§16 token/NAV deviation < max_nav_deviation', () => {
  it('exactly 1% FAILS (the §16 comparison is strictly less-than)', () => {
    const evaluation = evaluate({
      tokenNAVDeviation: sourced(thresholds.maxNavDeviation, DATA_SOURCES.DERIVED),
    });
    const check = checkFor(evaluation, 'navDeviation');
    expect(check.comparison).toBe('<');
    expect(check.actual).toBe(0.01);
    expect(check.threshold).toBe(0.01);
    expect(check.passed).toBe(false);
    expect(evaluation.passed).toBe(false);
    expect(reasonFor(evaluation, POOL_FILTER_CODES.NAV_DEVIATION_EXCEEDED)).toContain('1.0000% < 1.0000%');
  });

  it('just under 1% passes', () => {
    const evaluation = evaluate({
      tokenNAVDeviation: sourced(0.009_999, DATA_SOURCES.DERIVED),
    });
    expect(evaluation.passed).toBe(true);
    expect(checkFor(evaluation, 'navDeviation').passed).toBe(true);
  });

  it('a null deviation (no trustworthy reference NAV, §57) is unavailable — fail closed', () => {
    const evaluation = evaluate({
      tokenNAVDeviation: sourced(null, DATA_SOURCES.UNAVAILABLE, true),
    });
    expect(evaluation.passed).toBe(false);
    expect(evaluation.failedCodes).toEqual([POOL_FILTER_CODES.NAV_DEVIATION_UNAVAILABLE]);
    expect(checkFor(evaluation, 'navDeviation').actual).toBeNull();
    expect(evaluation.complete).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * §16 $3500 swap price impact < 0.5%
 * ------------------------------------------------------------------ */

describe('§16 $3500 swap price impact < max_swap_price_impact', () => {
  it('exactly 0.5% FAILS', () => {
    const evaluation = evaluate({
      swapImpact3500USD: sourced(thresholds.maxSwapPriceImpact, DATA_SOURCES.ONCHAIN),
    });
    const check = checkFor(evaluation, 'swapImpact3500');
    expect(check.comparison).toBe('<');
    expect(check.passed).toBe(false);
    expect(evaluation.failedCodes).toEqual([POOL_FILTER_CODES.SWAP_IMPACT_EXCEEDED]);
    expect(reasonFor(evaluation, POOL_FILTER_CODES.SWAP_IMPACT_EXCEEDED)).toContain(
      '$3500 swap price impact 0.5000% < 0.5000%',
    );
  });

  it('just under 0.5% passes', () => {
    const evaluation = evaluate({ swapImpact3500USD: sourced(0.004_999, DATA_SOURCES.ONCHAIN) });
    expect(evaluation.passed).toBe(true);
  });

  it('an on-chain quote failure is unavailable, not "0% impact"', () => {
    const evaluation = evaluate({
      swapImpact3500USD: { value: 0, source: DATA_SOURCES.UNAVAILABLE, asOf: EVALUATED_AT, stale: true },
    });
    expect(evaluation.passed).toBe(false);
    expect(evaluation.failedCodes).toEqual([POOL_FILTER_CODES.SWAP_IMPACT_UNAVAILABLE]);
    expect(checkFor(evaluation, 'swapImpact3500').actual).toBeNull();
    expect(evaluation.complete).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Whitelists: address, never symbol (§8/§11/§12/§14)
 * ------------------------------------------------------------------ */

describe('whitelist membership is decided by address', () => {
  it('a same-symbol impostor address is rejected as a leg', () => {
    const evaluation = evaluate({ token0: QQQB_IMPOSTOR });
    expect(evaluation.passed).toBe(false);
    expect(evaluation.failedCodes).toContain(POOL_FILTER_CODES.LEG_NOT_WHITELISTED);
    const reason = evaluation.reasons.find((entry) => entry.includes(QQQB_IMPOSTOR));
    expect(reason).toBeDefined();
    expect(reason).toContain('NOT in the token whitelist');
    expect(reason).toContain('regardless of any symbol');
    // The stock leg lookup also comes back empty, so §14 is reported too.
    expect(evaluation.failedCodes).toContain(POOL_FILTER_CODES.STOCK_LEG_MISSING);
  });

  it('a whitelisted address passes even when the leg is the second one', () => {
    const evaluation = evaluate({ token0: USDC, token1: QQQB });
    expect(evaluation.passed).toBe(true);
  });

  it('rejects a non-whitelisted STABLECOIN leg while the stock leg is fine', () => {
    // The impostor sits in the stablecoin slot, so §14's stock leg is satisfied and the failure is
    // precisely the stablecoin whitelist — the two legs are judged independently.
    const evaluation = evaluate({ token1: QQQB_IMPOSTOR });
    expect(evaluation.passed).toBe(false);
    expect(evaluation.failedCodes).toContain(POOL_FILTER_CODES.LEG_NOT_WHITELISTED);
    expect(evaluation.failedCodes).toContain(POOL_FILTER_CODES.STABLECOIN_LEG_MISSING);
    expect(evaluation.failedCodes).not.toContain(POOL_FILTER_CODES.STOCK_LEG_MISSING);
  });

  it('rejects a pool on a DEX that is not whitelisted for the chain (§12)', () => {
    // A whitelist that admits Uniswap V3 only: the Pancake pool must not slip through.
    const uniswapOnly = createWhitelist(
      config.whitelist.registry.list(),
      [56],
      [{ chainId: 56, dex: DEX_IDS.UNISWAP_V3 }],
    );
    const evaluation = evaluatePoolFilters(snapshot(), thresholds, {
      evaluatedAt: EVALUATED_AT,
      whitelist: uniswapOnly,
      onchainVerified: true,
    });
    expect(evaluation.passed).toBe(false);
    expect(evaluation.failedCodes).toEqual([POOL_FILTER_CODES.DEX_NOT_WHITELISTED]);
  });

  it('rejects a pool on a chain that is not whitelisted', () => {
    const evaluation = evaluatePoolFilters(
      { ...snapshot({ poolId: `97:${DEX_IDS.PANCAKESWAP_V3}:${POOL_ADDRESS}` }), chainId: 97 },
      thresholds,
      { evaluatedAt: EVALUATED_AT, whitelist, onchainVerified: true },
    );
    expect(evaluation.failedCodes).toContain(POOL_FILTER_CODES.CHAIN_NOT_WHITELISTED);
  });

  it('a pool whose poolId disagrees with chainId:dex:poolAddress is rejected (§13)', () => {
    const evaluation = evaluate({ poolId: `56:${DEX_IDS.UNISWAP_V3}:${POOL_ADDRESS}` });
    expect(evaluation.passed).toBe(false);
    expect(evaluation.failedCodes).toContain(POOL_FILTER_CODES.SNAPSHOT_INCONSISTENT);
    // The identity gate has its own condition, so it never collides with the §12 DEX whitelist.
    expect(evaluation.checks.filter((entry) => entry.condition === 'dex')).toHaveLength(1);
    expect(checkFor(evaluation, 'identity').code).toBe(POOL_FILTER_CODES.SNAPSHOT_INCONSISTENT);
  });

  it('without a whitelist supplied, membership is unverified — the §16 numeric gates still run', () => {
    const evaluation = evaluatePoolFilters(snapshot(), thresholds, {
      evaluatedAt: EVALUATED_AT,
      onchainVerified: true,
    });
    expect(evaluation.passed).toBe(true);
    expect(evaluation.checks.some((entry) => entry.message.includes('no whitelist supplied'))).toBe(
      true,
    );
  });
});

/* ------------------------------------------------------------------ *
 * FAIL CLOSED (§96/§57): stale or unavailable data must never pass
 * ------------------------------------------------------------------ */

describe('fail closed: stale / unavailable figures are rejections, never near-misses', () => {
  const stalenessCases: readonly {
    readonly label: string;
    readonly field: keyof SnapshotOverrides;
    readonly value: Sourced<number>;
    readonly code: string;
  }[] = [
    {
      label: 'tvlUSD marked stale',
      field: 'tvlUSD',
      value: { value: 1_770_000, source: DATA_SOURCES.GECKOTERMINAL, asOf: EVALUATED_AT, stale: true },
      code: POOL_FILTER_CODES.TVL_UNAVAILABLE,
    },
    {
      label: 'tvlUSD from an unavailable source (the provider writes 0)',
      field: 'tvlUSD',
      value: { value: 0, source: DATA_SOURCES.UNAVAILABLE, asOf: EVALUATED_AT, stale: true },
      code: POOL_FILTER_CODES.TVL_UNAVAILABLE,
    },
    {
      label: 'volume7d unavailable',
      field: 'volume7d',
      value: { value: 0, source: DATA_SOURCES.UNAVAILABLE, asOf: EVALUATED_AT, stale: true },
      code: POOL_FILTER_CODES.VOLUME_7D_UNAVAILABLE,
    },
    {
      label: 'volume7d stale despite a plausible number',
      field: 'volume7d',
      value: { value: 7_000_000, source: DATA_SOURCES.DEXPAPRIKA, asOf: EVALUATED_AT, stale: true },
      code: POOL_FILTER_CODES.VOLUME_7D_UNAVAILABLE,
    },
    {
      label: 'swapImpact3500USD stale despite a plausible number',
      field: 'swapImpact3500USD',
      value: { value: 0.001, source: DATA_SOURCES.ONCHAIN, asOf: EVALUATED_AT, stale: true },
      code: POOL_FILTER_CODES.SWAP_IMPACT_UNAVAILABLE,
    },
  ];

  for (const testCase of stalenessCases) {
    it(`${testCase.label} → ${testCase.code}, never a numeric comparison`, () => {
      const evaluation = evaluate({ [testCase.field]: testCase.value });
      expect(evaluation.passed).toBe(false);
      expect(evaluation.failedCodes).toContain(testCase.code);
      // The unavailable code must be the reason for that FIELD — not a "below minimum" near-miss.
      const offending = evaluation.checks.find((entry) => entry.code === testCase.code);
      expect(offending).toBeDefined();
      expect(offending!.actual).toBeNull();
      expect(evaluation.complete).toBe(false);
    });
  }

  it('a 0-valued unavailable TVL is NOT read as "no liquidity"', () => {
    const evaluation = evaluate({
      tvlUSD: { value: 0, source: DATA_SOURCES.UNAVAILABLE, asOf: EVALUATED_AT, stale: true },
    });
    expect(evaluation.failedCodes).not.toContain(POOL_FILTER_CODES.TVL_BELOW_MINIMUM);
    expect(evaluation.failedCodes).toContain(POOL_FILTER_CODES.TVL_UNAVAILABLE);
  });

  it('an unavailable figure cannot be rescued by an otherwise-perfect pool', () => {
    const evaluation = evaluate({
      tokenNAVDeviation: { value: null, source: DATA_SOURCES.UNAVAILABLE, asOf: EVALUATED_AT, stale: true },
    });
    // Every numeric gate is satisfied; the single unknown still rejects.
    expect(evaluation.passed).toBe(false);
    expect(evaluation.failedCodes).toEqual([POOL_FILTER_CODES.NAV_DEVIATION_UNAVAILABLE]);
  });

  it('filterPools reports the outcome as non-decisive when a rejection came from missing data', () => {
    const good = snapshot();
    const unknownTvl = snapshot({
      tvlUSD: { value: 0, source: DATA_SOURCES.UNAVAILABLE, asOf: EVALUATED_AT, stale: true },
    });
    const outcome = filterPools([good, unknownTvl], thresholds, {
      evaluatedAt: EVALUATED_AT,
      whitelist,
      onchainVerified: true,
    });
    expect(outcome.passed.map((entry) => entry.snapshot.poolId)).toEqual([good.poolId]);
    expect(outcome.rejected).toHaveLength(1);
    expect(outcome.decisive).toBe(false);
    expect(outcome.thresholds).toEqual(thresholds);
  });

  it('filterPools is decisive when every rejection was on merit', () => {
    const good = snapshot();
    const poor = snapshot({ tvlUSD: sourced(400_000, DATA_SOURCES.GECKOTERMINAL) });
    const outcome = filterPools([good, poor], thresholds, {
      evaluatedAt: EVALUATED_AT,
      whitelist,
      onchainVerified: true,
    });
    expect(outcome.decisive).toBe(true);
    expect(outcome.passed).toHaveLength(1);
    expect(outcome.rejected[0]?.evaluation.failedCodes).toEqual([
      POOL_FILTER_CODES.TVL_BELOW_MINIMUM,
    ]);
  });

  it('rejection reasons name the condition, the actual value and the threshold', () => {
    const evaluation = evaluate({
      tvlUSD: sourced(123_456, DATA_SOURCES.GECKOTERMINAL),
      volume7d: sourced(7 * 10_000, DATA_SOURCES.DEXPAPRIKA),
      poolAgeDays: 2,
    });
    expect(evaluation.reasons).toHaveLength(3);
    expect(evaluation.reasons[0]).toBe('[TVL_BELOW_MINIMUM] tvlUSD $123,456 >= $500,000 → FAIL');
    expect(evaluation.reasons[1]).toContain('[VOLUME_7D_BELOW_MINIMUM]');
    expect(evaluation.reasons[1]).toContain('$10,000');
    expect(evaluation.reasons[2]).toContain('[POOL_TOO_YOUNG]');
  });
});

/* ------------------------------------------------------------------ *
 * §15/§96 on-chain verification gate
 * ------------------------------------------------------------------ */

describe('§15 fail closed: an unread on-chain state cannot pass a hard filter', () => {
  it('treats a missing verification flag as unverified and rejects', () => {
    const evaluation = evaluatePoolFilters(snapshot(), thresholds, {
      evaluatedAt: EVALUATED_AT,
      whitelist,
    });
    expect(evaluation.passed).toBe(false);
    expect(evaluation.failedCodes).toEqual([POOL_FILTER_CODES.ONCHAIN_UNVERIFIED]);
    const check = checkFor(evaluation, 'onchain');
    expect(check.passed).toBe(false);
    expect(check.message).toContain('tick/liquidity/fee are unverified');
    // A rejection caused by missing data must not be presented as a pool-quality verdict.
    expect(evaluation.complete).toBe(false);
  });

  it('rejects explicitly when the caller states the on-chain read did not happen', () => {
    const evaluation = evaluatePoolFilters(snapshot(), thresholds, {
      evaluatedAt: EVALUATED_AT,
      whitelist,
      onchainVerified: false,
    });
    expect(evaluation.passed).toBe(false);
    expect(evaluation.failedCodes).toEqual([POOL_FILTER_CODES.ONCHAIN_UNVERIFIED]);
  });

  it('accepts a verified pool whose active liquidity is legitimately zero', () => {
    // `0n` from a SUCCESSFUL read is a legal all-out-of-range pool — it must pass the gate that
    // exists to reject an UNREAD pool. The two are not the same thing and are not conflated.
    const evaluation = evaluate();
    expect(evaluation.passed).toBe(true);
    expect(checkFor(evaluation, 'onchain').passed).toBe(true);
  });

  it('resolves verification per pool through `isOnchainVerified`', () => {
    const verified = snapshot();
    // A second, distinct pool identity — an unread one must be rejected while the read one passes.
    const unreadAddress = '0x62609d8964b2fb5ce0322c4e0b659466e7297df9' as Address;
    const unread = snapshot({
      poolAddress: unreadAddress,
      poolId: poolIdFor(CHAIN_ID, DEX_IDS.PANCAKESWAP_V3, unreadAddress),
    });
    const outcome = filterPools([verified, unread], thresholds, {
      evaluatedAt: EVALUATED_AT,
      whitelist,
      isOnchainVerified: (pool) => pool.poolId === verified.poolId,
    });
    expect(outcome.passed.map((entry) => entry.snapshot.poolId)).toEqual([verified.poolId]);
    expect(outcome.rejected[0]?.evaluation.failedCodes).toEqual([
      POOL_FILTER_CODES.ONCHAIN_UNVERIFIED,
    ]);
    expect(outcome.decisive).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Evaluation shape
 * ------------------------------------------------------------------ */

describe('evaluation shape', () => {
  it('always reports every gate so the DecisionLog can be diffed', () => {
    const evaluation = evaluate({ tvlUSD: sourced(100_000, DATA_SOURCES.GECKOTERMINAL) });
    expect(evaluation.checks.map((entry) => entry.condition)).toEqual([
      'identity',
      'chain',
      'dex',
      'stockLeg',
      'stablecoinLeg',
      'stockLeg',
      'stablecoinLeg',
      'onchain',
      'tvl',
      'avgDailyVolume7d',
      'poolAge',
      'navDeviation',
      'swapImpact3500',
    ]);
    expect(evaluation.chainId).toBe(56);
    expect(evaluation.dex).toBe(DEX_IDS.PANCAKESWAP_V3);
    expect(evaluation.poolAddress).toBe(POOL_ADDRESS);
  });
});
