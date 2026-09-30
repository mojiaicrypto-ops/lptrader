import { describe, expect, it } from 'vitest';
import {
  CHAIN_ONLY_CONDITIONS,
  evaluatePoolFilters,
  filterPools,
  type PoolFilterOptions,
} from '../../src/data/poolFilter.ts';
import { loadConfig } from '../../src/config/index.ts';
import type { PoolSnapshot } from '../../src/types/market.ts';
import { BSC_ADDRESSES, BSC_BSTOCKS, KNOWN_BSC_POOLS } from '../../src/config/builtins.ts';
import { DEX_IDS, type Address } from '../../src/types/primitives.ts';

const CHAIN = 56;
const QQQB = BSC_BSTOCKS.find((token) => token.symbol === 'QQQB')!.address as Address;
const USDT = BSC_ADDRESSES.USDT as Address;
const POOL_ADDRESS = KNOWN_BSC_POOLS[1]!.poolAddress as Address;
const POOL_ID = `${CHAIN}:${DEX_IDS.PANCAKESWAP_V3}:${POOL_ADDRESS}`;

const sourced = <T,>(value: T, stale = false) => ({
  value,
  source: 'geckoterminal' as const,
  asOf: '2026-09-30T00:00:00.000Z',
  stale,
});

/** A snapshot that satisfies every HTTP-measurable §16 gate, with the chain-only figures unread. */
function admissionSnapshot(over: Partial<PoolSnapshot> = {}): PoolSnapshot {
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
    currentPrice: sourced(738),
    sqrtPriceX96: 0n,
    currentTick: 0,
    activeLiquidity: 0n,
    stockReferencePrice: sourced(738.84),
    // NOT measured: these need a chain read plus a reference price (architecture §4.2).
    tokenNAVDeviation: { value: null, source: 'unavailable', asOf: '2026-09-30T00:00:00.000Z', stale: true },
    stockVolatility7d: sourced(0.02),
    stockVolatility30d: sourced(0.025),
    swapImpact1000USD: { value: 0, source: 'unavailable', asOf: '2026-09-30T00:00:00.000Z', stale: true },
    swapImpact3500USD: { value: 0, source: 'unavailable', asOf: '2026-09-30T00:00:00.000Z', stale: true },
    swapImpact5000USD: { value: 0, source: 'unavailable', asOf: '2026-09-30T00:00:00.000Z', stale: true },
    estimatedAPR1d: sourced(0.2),
    estimatedAPR7d: sourced(0.2),
    estimatedAPR30d: sourced(0.2),
    marketDataSource: 'geckoterminal',
    ...over,
  };
}

async function thresholdsAndWhitelist() {
  const config = await loadConfig();
  return {
    config,
    thresholds: {
      minTvlUsd: config.pool.minTvlUsd,
      minAvgDailyVolume7dUsd: config.pool.minAvgDailyVolume7dUsd,
      minPoolAgeDays: config.pool.minPoolAgeDays,
      maxNavDeviation: config.pool.maxNavDeviation,
      maxSwapPriceImpact: config.pool.maxSwapPriceImpact,
    },
  };
}

const EVALUATED_AT = '2026-09-30T00:00:00.000Z';

describe('admission stage defers the chain-only gates instead of failing them (§4.2)', () => {
  it('does NOT reject a pool merely because the chain has not been read yet', async () => {
    // The bug this pins, seen live: every scan listed every candidate as rejected for ONCHAIN_UNVERIFIED —
    // the eligible pools included — and pushed a `warning` with all ten of them, once an hour. An alert that
    // fires on a healthy market trains the operator to ignore the channel.
    const { config, thresholds } = await thresholdsAndWhitelist();
    const options: PoolFilterOptions = {
      evaluatedAt: EVALUATED_AT,
      whitelist: config.whitelist,
      isOnchainVerified: () => false,
      deferChainOnly: true,
    };

    const evaluation = evaluatePoolFilters(admissionSnapshot(), thresholds, options);

    // The HTTP-measurable gates all pass, so the pool is not rejected...
    expect(evaluation.passed).toBe(true);
    expect(evaluation.reasons).toEqual([]);
    // ...but the verdict is explicitly PARTIAL: the three chain-only conditions were not judged, and each
    // records that rather than pretending to a verdict.
    expect(evaluation.complete).toBe(false);
    expect(evaluation.checks.filter((check) => check.deferred)).toHaveLength(3);
  });

  it('marks exactly the chain-only conditions as deferred when they are unread', async () => {
    const { config, thresholds } = await thresholdsAndWhitelist();
    const evaluation = evaluatePoolFilters(admissionSnapshot(), thresholds, {
      evaluatedAt: EVALUATED_AT,
      whitelist: config.whitelist,
      isOnchainVerified: () => false,
      deferChainOnly: true,
    });

    const deferred = evaluation.checks.filter((check) => check.deferred).map((check) => check.condition);
    // `onchain` is deferred by the verification flag, the other two by their unread figures.
    expect(deferred.sort()).toEqual([...CHAIN_ONLY_CONDITIONS].sort());
    // And each says "not measured yet", not "failed".
    for (const check of evaluation.checks.filter((entry) => entry.deferred)) {
      expect(check.message).toMatch(/not (measured|read) yet/);
    }
  });

  it('still FAILS a measured violation at the admission stage', async () => {
    // Deferral must not become a way to slip past a gate that WAS measurable. A TVL below the floor is
    // known at admission time and must reject.
    const { config, thresholds } = await thresholdsAndWhitelist();
    const evaluation = evaluatePoolFilters(admissionSnapshot({ tvlUSD: sourced(4.79) }), thresholds, {
      evaluatedAt: EVALUATED_AT,
      whitelist: config.whitelist,
      isOnchainVerified: () => false,
      deferChainOnly: true,
    });

    expect(evaluation.passed).toBe(false);
    expect(evaluation.failedCodes).toContain('TVL_BELOW_MINIMUM');
    expect(evaluation.reasons.join(' ')).toMatch(/tvl/i);
  });

  it('still FAILS a measured chain-only violation (a real impact above the cap)', async () => {
    // The other direction: if the figure WAS read and it is too high, deferral must not excuse it.
    const { config, thresholds } = await thresholdsAndWhitelist();
    const evaluation = evaluatePoolFilters(
      admissionSnapshot({
        swapImpact3500USD: { value: 0.02, source: 'onchain', asOf: EVALUATED_AT, stale: false },
      }),
      thresholds,
      {
        evaluatedAt: EVALUATED_AT,
        whitelist: config.whitelist,
        isOnchainVerified: () => false,
        deferChainOnly: true,
      },
    );

    expect(evaluation.passed).toBe(false);
    expect(evaluation.failedCodes).toContain('SWAP_IMPACT_EXCEEDED');
  });

  it('records deferred conditions as "not measured", not as the *_UNAVAILABLE failure code', async () => {
    // The distinction the operator needs: `*_UNAVAILABLE` means "we tried and could not", which is a data
    // problem worth alerting on. A deferral means "we have not tried yet", which is normal.
    const { config, thresholds } = await thresholdsAndWhitelist();
    const evaluation = evaluatePoolFilters(admissionSnapshot(), thresholds, {
      evaluatedAt: EVALUATED_AT,
      whitelist: config.whitelist,
      isOnchainVerified: () => false,
      deferChainOnly: true,
    });

    for (const check of evaluation.checks.filter((entry) => entry.deferred)) {
      expect(check.message).not.toMatch(/fail closed/);
    }
    // `failedCodes` is what a caller logs as the reason for rejection, so a deferral must not appear there.
    expect(evaluation.failedCodes).not.toContain('ONCHAIN_UNVERIFIED');
    expect(evaluation.failedCodes).not.toContain('NAV_DEVIATION_UNAVAILABLE');
    expect(evaluation.failedCodes).not.toContain('SWAP_IMPACT_UNAVAILABLE');
  });
});

describe('screening stage is UNCHANGED by the deferral (the safety property)', () => {
  it('still rejects an unread pool when the caller does not defer', async () => {
    // Module 2 has the chain, so it must judge those gates for real. §96 is untouched: the opt-in flag
    // cannot weaken the screening stage, only the admission stage.
    const { config, thresholds } = await thresholdsAndWhitelist();
    const evaluation = evaluatePoolFilters(admissionSnapshot(), thresholds, {
      evaluatedAt: EVALUATED_AT,
      whitelist: config.whitelist,
      isOnchainVerified: () => false,
    });

    expect(evaluation.passed).toBe(false);
    expect(evaluation.failedCodes).toContain('ONCHAIN_UNVERIFIED');
    expect(evaluation.reasons.join(' ')).toMatch(/fail closed/);
  });

  it('reports an unread figure as *_UNAVAILABLE when not deferring', async () => {
    const { config, thresholds } = await thresholdsAndWhitelist();
    const evaluation = evaluatePoolFilters(
      admissionSnapshot({ tvlUSD: { value: 0, source: 'unavailable', asOf: EVALUATED_AT, stale: true } }),
      thresholds,
      { evaluatedAt: EVALUATED_AT, whitelist: config.whitelist, isOnchainVerified: () => false },
    );

    expect(evaluation.failedCodes).toContain('TVL_UNAVAILABLE');
  });
});

describe('filterPools: a deferral is not a rejection', () => {
  it('puts an HTTP-qualifying pool in `passed` and keeps `decisive` false', async () => {
    // The operational upshot: the scan no longer reports "could not decide" for every pool, and the pools
    // that satisfy the admission gates appear as passed. `decisive: false` still tells the caller the
    // verdict is partial — so nothing reads this as a complete judgement.
    const { config, thresholds } = await thresholdsAndWhitelist();
    const outcome = filterPools([admissionSnapshot()], thresholds, {
      evaluatedAt: EVALUATED_AT,
      whitelist: config.whitelist,
      isOnchainVerified: () => false,
      deferChainOnly: true,
    });

    expect(outcome.passed).toHaveLength(1);
    expect(outcome.rejected).toHaveLength(0);
    expect(outcome.decisive).toBe(false);
  });
});
