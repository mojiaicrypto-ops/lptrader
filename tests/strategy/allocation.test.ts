import { describe, expect, it } from 'vitest';
import {
  ALLOCATION_REFUSALS,
  allocationLimitsFrom,
  checkBuildAllocation,
  lpBudgetUsd,
  reserveFloorUsd,
  verifyPostAllocation,
} from '../../src/strategy/allocation.ts';
import { swapLimitsForPool } from '../../src/strategy/swapPlanner.ts';
import { buildPoolOverrides } from '../../src/config/index.ts';

const LIMITS = { maxLpRatio: 0.7, reserveRatio: 0.3 };

describe('§3 allocation limits', () => {
  it('derives the budget and the floor from NAV alone', () => {
    expect(lpBudgetUsd(10_000, LIMITS)).toBeCloseTo(7_000, 6);
    expect(reserveFloorUsd(10_000, LIMITS)).toBeCloseTo(3_000, 6);
  });

  it('treats an unusable NAV as zero budget rather than inventing one', () => {
    expect(lpBudgetUsd(0, LIMITS)).toBe(0);
    expect(lpBudgetUsd(Number.NaN, LIMITS)).toBe(0);
    expect(reserveFloorUsd(-5, LIMITS)).toBe(0);
  });

  it('rejects a configuration whose bands overlap', () => {
    expect(() => allocationLimitsFrom({ maxLpRatio: 0.8, reserveRatio: 0.3 })).toThrow(/exceeds 1/);
  });

  it('rejects out-of-range ratios instead of clamping', () => {
    expect(() => allocationLimitsFrom({ maxLpRatio: 0, reserveRatio: 0.3 })).toThrow(/max_lp_ratio/);
    expect(() => allocationLimitsFrom({ maxLpRatio: 0.7, reserveRatio: 1 })).toThrow(/reserve_ratio/);
  });

  it('reads exactly the configured ratios (no hidden constant)', () => {
    const custom = allocationLimitsFrom({ maxLpRatio: 0.5, reserveRatio: 0.4 });
    expect(lpBudgetUsd(10_000, custom)).toBeCloseTo(5_000, 6);
    expect(reserveFloorUsd(10_000, custom)).toBeCloseTo(4_000, 6);
  });
});

describe('checkBuildAllocation — sizing a build (§3/§68)', () => {
  it('allows a build that lands exactly on the cap', () => {
    const check = checkBuildAllocation({
      navUsd: 10_000,
      currentLpValueUsd: 0,
      requestedUsd: 7_000,
      limits: LIMITS,
    });
    expect(check.ok).toBe(true);
  });

  it('refuses one cent over the cap', () => {
    const check = checkBuildAllocation({
      navUsd: 10_000,
      currentLpValueUsd: 0,
      requestedUsd: 7_000.01,
      limits: LIMITS,
    });
    expect(check.ok).toBe(false);
    expect(check.refusal).toBe(ALLOCATION_REFUSALS.LP_EXCEEDS_MAX);
    expect(check.reason).toMatch(/exceeding max_lp_ratio/);
  });

  it('judges the TOTAL allocation, so two compliant builds cannot breach the ratio together', () => {
    // The failure this prevents: 4,000 then another 4,000 are each "under the 7,000 cap" but 8,000
    // together is 80% of NAV.
    const first = checkBuildAllocation({
      navUsd: 10_000,
      currentLpValueUsd: 0,
      requestedUsd: 4_000,
      limits: LIMITS,
    });
    expect(first.ok).toBe(true);

    const second = checkBuildAllocation({
      navUsd: 10_000,
      currentLpValueUsd: 4_000,
      requestedUsd: 4_000,
      limits: LIMITS,
    });
    expect(second.ok).toBe(false);
    expect(second.refusal).toBe(ALLOCATION_REFUSALS.LP_EXCEEDS_MAX);
    expect(second.reason).toMatch(/LP would become \$8,000\.00/);
  });

  it('refuses when the reserve would fall below its floor', () => {
    // LP below the LP cap is not enough on its own: the reserve floor is checked against the resulting
    // state, so NAV that is not actually free cannot be committed.
    const check = checkBuildAllocation({
      navUsd: 10_000,
      currentLpValueUsd: 6_800,
      requestedUsd: 100,
      limits: LIMITS,
    });
    // 6,900 ≤ 7,000 cap, but the reserve floor is breached only if LP exceeds it; here it does not, so
    // this build is allowed and the reserve check is exercised by the next case.
    expect(check.ok).toBe(true);

    const breaching = checkBuildAllocation({
      navUsd: 10_000,
      currentLpValueUsd: 6_950,
      requestedUsd: 200,
      limits: { maxLpRatio: 0.8, reserveRatio: 0.3 },
    });
    expect(breaching.ok).toBe(false);
    expect(breaching.refusal).toBe(ALLOCATION_REFUSALS.RESERVE_BELOW_MIN);
    expect(breaching.reason).toMatch(/below reserve_ratio/);
  });

  it('refuses an unusable NAV rather than allocating against it (§96)', () => {
    const check = checkBuildAllocation({
      navUsd: 0,
      currentLpValueUsd: 0,
      requestedUsd: 1_000,
      limits: LIMITS,
    });
    expect(check.ok).toBe(false);
    expect(check.refusal).toBe(ALLOCATION_REFUSALS.NAV_UNUSABLE);
  });

  it('refuses a non-positive request instead of silently doing nothing', () => {
    const check = checkBuildAllocation({
      navUsd: 10_000,
      currentLpValueUsd: 0,
      requestedUsd: 0,
      limits: LIMITS,
    });
    expect(check.ok).toBe(false);
    expect(check.refusal).toBe(ALLOCATION_REFUSALS.CAPITAL_NOT_POSITIVE);
  });
});

describe('verifyPostAllocation — observed balances (§3/§60)', () => {
  it('accepts a portfolio at the target split', () => {
    const result = verifyPostAllocation({
      navUsd: 10_000,
      lpValueUsd: 7_000,
      reserveUsd: 3_000,
      limits: LIMITS,
    });
    expect(result.ok).toBe(true);
    expect(result.lp.withinBand).toBe(true);
    expect(result.reserve.withinBand).toBe(true);
  });

  it('accepts an UNDER-deployed portfolio and treats it as headroom, not a fault', () => {
    // §4/§68: un-deployed capital is not an error, and the bot must never deploy it automatically.
    const result = verifyPostAllocation({
      navUsd: 10_000,
      lpValueUsd: 2_000,
      reserveUsd: 8_000,
      limits: LIMITS,
    });
    expect(result.ok).toBe(true);
    expect(result.lp.note).toMatch(/headroom/);
    expect(result.lp.note).toMatch(/not auto-deployed/);
  });

  it('flags LP above the cap', () => {
    const result = verifyPostAllocation({
      navUsd: 10_000,
      lpValueUsd: 7_500,
      reserveUsd: 2_500,
      limits: LIMITS,
    });
    expect(result.ok).toBe(false);
    expect(result.lp.withinBand).toBe(false);
    expect(result.problems.join(' ')).toMatch(/exceeds max_lp_ratio/);
  });

  it('flags a reserve below its floor', () => {
    const result = verifyPostAllocation({
      navUsd: 10_000,
      lpValueUsd: 7_000,
      reserveUsd: 2_000,
      limits: LIMITS,
    });
    expect(result.ok).toBe(false);
    expect(result.reserve.withinBand).toBe(false);
    expect(result.problems.join(' ')).toMatch(/below reserve_ratio/);
  });

  it('marks both bands unjudgeable when NAV is unusable, instead of reporting a pass', () => {
    const result = verifyPostAllocation({
      navUsd: 0,
      lpValueUsd: 0,
      reserveUsd: 0,
      limits: LIMITS,
    });
    expect(result.ok).toBe(false);
    expect(result.lp.withinBand).toBe(false);
    expect(result.reserve.withinBand).toBe(false);
    expect(result.problems.join(' ')).toMatch(/cannot be verified/);
  });
});

describe('§40 per-pool overrides (user ruling: per-pool 0.8% / 1%)', () => {
  const POOL = '56:pancakeswap-v3:0xe531fcb1f5a195de7608b9f4f9518544c2cdb693';

  const config = {
    swap: { maxSlippage: 0.003, maxPriceImpact: 0.005, quoteTtlSeconds: 30 },
    pool: { maxSwapPriceImpact: 0.005 },
    poolOverrides: {
      [POOL]: { maxSlippage: 0.008, maxPriceImpact: 0.008 },
    },
  };

  it('uses the global defaults for a pool with no override', () => {
    const limits = swapLimitsForPool('56:uniswap-v3:0xabc', config);
    expect(limits.maxSlippage).toBe(0.003);
    expect(limits.maxPriceImpact).toBe(0.005);
  });

  it('applies the per-pool override to that pool only', () => {
    const overridden = swapLimitsForPool(POOL, config);
    expect(overridden.maxSlippage).toBe(0.008);
    expect(overridden.maxPriceImpact).toBe(0.008);

    const other = swapLimitsForPool('56:pancakeswap-v3:0xother', config);
    expect(other.maxSlippage).toBe(0.003);
  });

  it('keeps the liquidity-risk tier anchored to the ADMISSION threshold, not the widened tolerance', () => {
    // Widening the per-trade tolerance must not also raise the bar for declaring the POOL risky.
    const limits = swapLimitsForPool(POOL, config);
    expect(limits.liquidityRiskPriceImpact).toBeCloseTo(0.01, 9);
    expect(limits.liquidityRiskPriceImpact).toBeLessThan(limits.maxPriceImpact * 2 + 1);
  });
});

describe('buildPoolOverrides — startup validation (§13 identity, §16 admission)', () => {
  const pool = { max_swap_price_impact: 0.005 };
  const swap = { max_slippage: 0.003, max_price_impact: 0.005 };

  it('accepts a widening override keyed by a §13 pool identity', () => {
    const resolved = buildPoolOverrides(pool, swap, {
      '56:pancakeswap-v3:0xE531fCb1f5a195dE7608b9F4F9518544c2cdB693': {
        max_slippage: 0.01,
        max_price_impact: 0.01,
      },
    });
    expect(Object.keys(resolved)).toHaveLength(1);
    expect(resolved['56:pancakeswap-v3:0xE531fCb1f5a195dE7608b9F4F9518544c2cdB693']?.maxSlippage).toBe(0.01);
  });

  it('fills in the global default for a field the override omits', () => {
    const resolved = buildPoolOverrides(pool, swap, {
      '56:pancakeswap-v3:0xE531fCb1f5a195dE7608b9F4F9518544c2cdB693': { max_slippage: 0.01 },
    });
    expect(resolved['56:pancakeswap-v3:0xE531fCb1f5a195dE7608b9F4F9518544c2cdB693']?.maxPriceImpact).toBe(0.005);
  });

  it('rejects a key that is not a §13 identity, because it could never match a pool', () => {
    expect(() => buildPoolOverrides(pool, swap, { 'QQQB/USDT': { max_slippage: 0.01 } })).toThrow(
      /not a §13 pool identity/,
    );
  });

  it('rejects a tolerance STRICTER than the admission threshold as contradictory', () => {
    // If a pool was admitted at 0.5%, an execution tolerance of 0.1% means the pool should simply not be
    // selected — accepting it would make the effective limit depend on which check ran first.
    expect(() =>
      buildPoolOverrides(pool, swap, {
        '56:pancakeswap-v3:0xE531fCb1f5a195dE7608b9F4F9518544c2cdB693': { max_price_impact: 0.001 },
      }),
    ).toThrow(/below the §16 admission threshold/);
  });

  it('treats an empty override map as no overrides', () => {
    expect(buildPoolOverrides(pool, swap, {})).toEqual({});
  });
});
