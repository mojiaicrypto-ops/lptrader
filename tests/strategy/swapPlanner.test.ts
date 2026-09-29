import { describe, expect, it } from 'vitest';
import {
  RANGE_POSITIONS,
  classifyRange,
  computeFeeAprFromTotals,
  computePriceImpact,
  evaluateSwapQuote,
  planSwapIntent,
  type SwapLimits,
} from '../../src/strategy/swapPlanner.ts';
import type { PoolPriceView, SwapQuote } from '../../src/types/adapters.ts';
import type { PositionPlan } from '../../src/strategy/positionPlanner.ts';
import { applyFloorRatio, fromFloat, toFloat } from '../../src/util/decimal.ts';

const USDC = '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d' as const;
const QQQB = '0x205812cdbed920aff76c6580abd681a46d11efc7' as const;

const LIMITS: SwapLimits = {
  maxSlippage: 0.003,
  maxPriceImpact: 0.005,
  quoteTtlSeconds: 30,
  liquidityRiskPriceImpact: 0.01,
};

const QUOTED_AT = '2026-09-29T12:00:00.000Z';
const FRESH = '2026-09-29T12:00:10.000Z';
const EXPIRED = '2026-09-29T12:00:31.000Z';

function quote(overrides: Partial<SwapQuote> = {}): SwapQuote {
  return {
    poolId: '56:pancakeswap-v3:0xe531fcb1f5a195de7608b9f4f9518544c2cdb693',
    tokenIn: USDC,
    tokenOut: QQQB,
    amountInRaw: 3_185_000_000_000_000_000_000n,
    amountOutRaw: 4_300_000_000_000_000_000n,
    amountInUsd: 3185,
    priceImpact: 0.0012,
    slippageTolerance: 0.003,
    amountOutMinimumRaw: 4_287_100_000_000_000_000n,
    quotedAt: QUOTED_AT,
    expiresAt: '2026-09-29T12:00:30.000Z',
    route: ['QQQB/USDT 0.01%'],
    ...overrides,
  };
}

function plan(overrides: Partial<PositionPlan> = {}): PositionPlan {
  return {
    lowerPrice: 629,
    upperPrice: 858.4,
    lowerTick: -100,
    upperTick: 100,
    liquidity: 1n,
    amount0: 1n,
    amount1: 1n,
    valueToken0Usd: 3180,
    valueToken1Usd: 3820,
    swapNeeded: { tokenIn: USDC, tokenOut: QQQB, amountIn: 3_185_000_000_000_000_000_000n },
    rangeProgress: 0.5,
    ...overrides,
  };
}

describe('evaluateSwapQuote (§40/§41 gates)', () => {
  it('passes a fresh quote inside both limits', () => {
    const result = evaluateSwapQuote(quote(), LIMITS, FRESH);
    expect(result.ok).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.poolLiquidityRisk).toBe(false);
  });

  it('rejects an expired quote even when everything else is fine (§41)', () => {
    const result = evaluateSwapQuote(quote(), LIMITS, EXPIRED);
    expect(result.ok).toBe(false);
    expect(result.reasons.join(' ')).toContain('quote_expired');
  });

  it('treats the expiry instant itself as expired (>=, not >)', () => {
    const result = evaluateSwapQuote(quote(), LIMITS, '2026-09-29T12:00:30.000Z');
    expect(result.ok).toBe(false);
    expect(result.reasons.join(' ')).toContain('quote_expired');
  });

  it('rejects price impact above the 0.5% cap (§40)', () => {
    const result = evaluateSwapQuote(quote({ priceImpact: 0.006 }), LIMITS, FRESH);
    expect(result.ok).toBe(false);
    expect(result.reasons.join(' ')).toContain('price_impact_exceeded');
  });

  it('accepts price impact exactly at the cap (not ">" exclusive)', () => {
    const result = evaluateSwapQuote(quote({ priceImpact: 0.005 }), LIMITS, FRESH);
    expect(result.ok).toBe(true);
  });

  it('rejects slippage above the 0.3% cap (§40)', () => {
    const result = evaluateSwapQuote(quote({ slippageTolerance: 0.004 }), LIMITS, FRESH);
    expect(result.ok).toBe(false);
    expect(result.reasons.join(' ')).toContain('slippage_exceeded');
  });

  it('flags the pool as a liquidity risk above the second tier, even alongside a rejection', () => {
    const result = evaluateSwapQuote(quote({ priceImpact: 0.02 }), LIMITS, FRESH);
    expect(result.ok).toBe(false);
    expect(result.poolLiquidityRisk).toBe(true);
  });

  it('rejects a non-positive output (would encode a zero minimum)', () => {
    const result = evaluateSwapQuote(quote({ amountOutRaw: 0n }), LIMITS, FRESH);
    expect(result.ok).toBe(false);
    expect(result.reasons.join(' ')).toContain('amount_out_non_positive');
  });

  it('rejects NaN/negative impact instead of letting NaN slip past comparisons', () => {
    expect(evaluateSwapQuote(quote({ priceImpact: Number.NaN }), LIMITS, FRESH).ok).toBe(false);
    expect(evaluateSwapQuote(quote({ priceImpact: -1 }), LIMITS, FRESH).ok).toBe(false);
  });
});

describe('planSwapIntent (§38 optimal-ratio swap)', () => {
  it('uses the planner amount, never a fixed 50/50 split', () => {
    const intent = planSwapIntent(plan(), quote(), 0.003);
    expect(intent.amountInRaw).toBe(3_185_000_000_000_000_000_000n);
    expect(intent.noSwapNeeded).toBe(false);
    // A guessed half of the 7,000 USDC budget would be 3,500e18 — assert we did NOT do that.
    expect(intent.amountInRaw).not.toBe(3_500_000_000_000_000_000_000n);
  });

  it('derives the minimum output from the tolerance instead of trusting the quote', () => {
    const intent = planSwapIntent(plan(), quote({ amountOutMinimumRaw: 1n }), 0.003);
    // 4.3e18 * (1 - 0.003) = 4287100000000000000
    expect(intent.amountOutMinimumRaw).toBe(4_287_100_000_000_000_000n);
  });

  it('returns a no-op intent when the plan needs no swap', () => {
    const intent = planSwapIntent(plan({ swapNeeded: null }), quote(), 0.003);
    expect(intent.noSwapNeeded).toBe(true);
    expect(intent.amountInRaw).toBe(0n);
  });

  it('throws when the quote trades a different pair than the plan (never silently swaps the wrong token)', () => {
    expect(() => planSwapIntent(plan(), quote({ tokenIn: QQQB, tokenOut: USDC }), 0.003)).toThrow(
      /mismatch/,
    );
  });
});

describe('classifyRange (§37 three placements)', () => {
  const range = { lowerPrice: 629, upperPrice: 858.4 };

  it.each([
    ['in range', 740, RANGE_POSITIONS.IN_RANGE],
    ['at the upper bound is above range', 858.4, RANGE_POSITIONS.ABOVE_RANGE],
    ['at the lower bound is below range', 629, RANGE_POSITIONS.BELOW_RANGE],
    ['above', 900, RANGE_POSITIONS.ABOVE_RANGE],
    ['below', 500, RANGE_POSITIONS.BELOW_RANGE],
  ])('%s', (_label, price, expected) => {
    expect(classifyRange(range, price)).toBe(expected);
  });
});

describe('computePriceImpact (§40)', () => {
  const pool: Pick<PoolPriceView, 'priceToken1PerToken0' | 'poolId'> = {
    priceToken1PerToken0: 1 / 740,
    poolId: '56:pancakeswap-v3:0xe531fcb1f5a195de7608b9f4f9518544c2cdb693',
  };

  it('computes near-zero impact for a trade at the mid price', () => {
    const impact = computePriceImpact({
      pool,
      tokenIn: USDC,
      tokenOut: QQQB,
      amountInRaw: fromFloat(1000, 18),
      amountOutRaw: fromFloat(1000 * (1 / 740), 18),
      tokenInDecimals: 18,
      tokenOutDecimals: 18,
      poolToken0: USDC,
    });
    expect(impact).toBeLessThan(1e-9);
  });

  it('orients correctly when the trade sells pool token1 instead of token0', () => {
    // Same economics, reversed pool ordering: token0 = QQQB, so the mid must be USDC per QQQB (740),
    // not the 1/740 used in the USDC-first pool. Getting this wrong understates impact by ~5e5×.
    const reversed: Pick<PoolPriceView, 'priceToken1PerToken0' | 'poolId'> = {
      priceToken1PerToken0: 740,
      poolId: '56:pancakeswap-v3:0xe531fcb1f5a195de7608b9f4f9518544c2cdb693',
    };

    // Selling pool token0 (QQQB) for USDC: rate is still expressed as token1 per token0.
    expect(
      computePriceImpact({
        pool: reversed,
        tokenIn: QQQB,
        tokenOut: USDC,
        amountInRaw: fromFloat(1, 18),
        amountOutRaw: fromFloat(740, 18),
        tokenInDecimals: 18,
        tokenOutDecimals: 18,
        poolToken0: QQQB,
      }),
    ).toBeLessThan(1e-9);

    // Selling pool token1 (USDC) for QQQB: the rate must be inverted, not used as-is.
    const impact = computePriceImpact({
      pool: reversed,
      tokenIn: USDC,
      tokenOut: QQQB,
      amountInRaw: fromFloat(740, 18),
      amountOutRaw: fromFloat(1, 18),
      tokenInDecimals: 18,
      tokenOutDecimals: 18,
      poolToken0: QQQB,
    });
    expect(impact).toBeLessThan(1e-9);
  });

  it('detects a real impact in the reversed orientation too (guards an inverted mid)', () => {
    // If the orientation were inverted, a 1% adverse move would read as ~99% and be caught here.
    const reversed: Pick<PoolPriceView, 'priceToken1PerToken0' | 'poolId'> = {
      priceToken1PerToken0: 740,
      poolId: '56:pancakeswap-v3:0xe531fcb1f5a195de7608b9f4f9518544c2cdb693',
    };
    const impact = computePriceImpact({
      pool: reversed,
      tokenIn: USDC,
      tokenOut: QQQB,
      amountInRaw: fromFloat(740, 18),
      amountOutRaw: fromFloat(1 / 1.01, 18),
      tokenInDecimals: 18,
      tokenOutDecimals: 18,
      poolToken0: QQQB,
    });
    expect(impact).toBeGreaterThan(0.009);
    expect(impact).toBeLessThan(0.011);
  });

  it('reports a real impact when the executed rate deviates from the mid', () => {
    const impact = computePriceImpact({
      pool,
      tokenIn: USDC,
      tokenOut: QQQB,
      amountInRaw: fromFloat(1000, 18),
      // 1% worse than mid
      amountOutRaw: fromFloat(1000 * (1 / 740) * 0.99, 18),
      tokenInDecimals: 18,
      tokenOutDecimals: 18,
      poolToken0: USDC,
    });
    expect(impact).toBeGreaterThan(0.009);
    expect(impact).toBeLessThan(0.011);
    expect(evaluateSwapQuote(quote({ priceImpact: impact }), LIMITS, FRESH).ok).toBe(false);
  });

  it('refuses a non-positive amount rather than returning a meaningless ratio', () => {
    expect(() =>
      computePriceImpact({
        pool,
        tokenIn: USDC,
        tokenOut: QQQB,
        amountInRaw: 0n,
        amountOutRaw: 1n,
        tokenInDecimals: 18,
        tokenOutDecimals: 18,
        poolToken0: USDC,
      }),
    ).toThrow(/positive/);
  });
});

describe('computeFeeAprFromTotals (§18)', () => {
  it('annualises 7d fees over average TVL', () => {
    // 2,000 fees on 500,000 TVL over 7 days → 0.004 * 52.14 ≈ 0.2086
    expect(computeFeeAprFromTotals(2_000, 500_000)).toBeCloseTo(0.20857, 4);
  });

  it('returns null instead of Infinity when average TVL is zero', () => {
    expect(computeFeeAprFromTotals(1_000, 0)).toBeNull();
    expect(computeFeeAprFromTotals(Number.NaN, 100)).toBeNull();
  });
});

describe('decimal helpers', () => {
  it('converts an 18-decimal balance without Number precision loss', () => {
    // 12,345.6789 tokens
    expect(toFloat(12_345_678_900_000_000_000_000n, 18)).toBeCloseTo(12_345.6789, 4);
  });

  it('handles BSC USDC (18 decimals) — not the 6-decimal form', () => {
    expect(toFloat(1_000_000_000_000_000_000n, 18)).toBe(1);
  });

  it('round-trips whole-token values', () => {
    expect(fromFloat(740, 18)).toBe(740_000_000_000_000_000_000n);
  });

  it('truncates by default and rounds up only when asked', () => {
    const value = 0.9999999999999999999;
    expect(fromFloat(value, 18)).toBeLessThanOrEqual(fromFloat(value, 18, true));
    expect(fromFloat(1.5, 0)).toBe(1n);
    expect(fromFloat(1.5, 0, true)).toBe(2n);
  });

  it('floors a slippage-derived minimum', () => {
    expect(applyFloorRatio(1_000n, 0.997)).toBe(997n);
    expect(applyFloorRatio(3n, 0.5)).toBe(1n); // floor, not round
  });

  it('rejects out-of-range ratios instead of silently clamping', () => {
    expect(() => applyFloorRatio(1n, 1.5)).toThrow(/out of range/);
    expect(() => applyFloorRatio(1n, -0.1)).toThrow(/out of range/);
  });
});
