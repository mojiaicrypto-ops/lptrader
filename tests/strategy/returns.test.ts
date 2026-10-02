import { describe, expect, it } from 'vitest';
import {
  computeAnnualizedApr,
  computeReturn,
  isPoolContributionNegative,
  valueEntryComposition,
} from '../../src/strategy/returns.ts';

const AT = '2026-09-30T00:00:00.000Z';

function baseline(over: Partial<Parameters<typeof computeReturn>[0]> = {}) {
  return { entryEquityUsd: 10_000, entryStockPriceUsd: 738, openedAt: AT, ...over };
}

describe('computeReturn: the headline is return on committed money', () => {
  it('reports the ratio and the USD change', () => {
    const report = computeReturn(baseline(), {
      currentEquityUsd: 11_000,
      currentStockPriceUsd: 738,
      holdEquityUsd: 10_000,
      at: AT,
    });
    expect(report.returnUsd).toBe(1_000);
    expect(report.returnRatio).toBeCloseTo(0.1, 10);
  });

  it('refuses to divide by an entry equity that was never recorded', () => {
    // A position opened before the baseline existed genuinely has no return to report. Back-filling from
    // the current wallet would report a different quantity under the same name.
    const report = computeReturn(baseline({ entryEquityUsd: null }), {
      currentEquityUsd: 11_000,
      currentStockPriceUsd: 738,
      holdEquityUsd: 10_000,
      at: AT,
    });
    expect(report.returnRatio).toBeNull();
    expect(report.returnUsd).toBeNull();
    expect(report.incompleteReasons.join(' ')).toMatch(/no entry equity was recorded/);
  });

  it('treats a non-positive entry equity as unusable rather than dividing', () => {
    const report = computeReturn(baseline({ entryEquityUsd: 0 }), {
      currentEquityUsd: 100,
      currentStockPriceUsd: 738,
      holdEquityUsd: 100,
      at: AT,
    });
    expect(report.returnRatio).toBeNull();
    expect(report.incompleteReasons.join(' ')).toMatch(/cannot be a denominator/);
  });
});

describe('computeReturn: attribution separates the market from the pool', () => {
  it('attributes a pure market rise to the market, leaving the pool at zero', () => {
    // Stock +10%, and the pool tracked it exactly: the operator earned money and the pool neither helped
    // nor hurt. Total return is positive and the pool contribution is zero — the case that proves the
    // split is not simply restating the total.
    const report = computeReturn(baseline(), {
      currentEquityUsd: 11_000,
      currentStockPriceUsd: 738 * 1.1,
      holdEquityUsd: 11_000,
      at: AT,
    });
    expect(report.marketContributionUsd).toBeCloseTo(1_000, 6);
    expect(report.poolContributionUsd).toBeCloseTo(0, 6);
  });

  it('holds the pool responsible when the position lags a rising market', () => {
    // Stock +10% but the position only reached 10,500: the 500 shortfall against simply holding is the
    // pool's doing. This is the shape of "fees did not cover the impermanent loss".
    const report = computeReturn(baseline(), {
      currentEquityUsd: 10_500,
      currentStockPriceUsd: 738 * 1.1,
      holdEquityUsd: 11_000,
      at: AT,
    });
    expect(report.returnUsd).toBe(500);
    expect(report.poolContributionUsd).toBeCloseTo(-500, 6);
    expect(report.poolContributionRatio).toBeCloseTo(-0.05, 10);
  });

  it('does NOT blame the pool when a fall is entirely the stock falling', () => {
    // The case the naive "equity is down ⇒ exit" rule would get wrong: the operator wanted the exposure,
    // and selling would crystallise the same loss. The pool contribution is zero, so nothing is flagged.
    const report = computeReturn(baseline(), {
      currentEquityUsd: 9_000,
      currentStockPriceUsd: 738 * 0.9,
      holdEquityUsd: 9_000,
      at: AT,
    });
    expect(report.returnUsd).toBe(-1_000);
    expect(report.poolContributionUsd).toBeCloseTo(0, 6);
    expect(isPoolContributionNegative(report)).toBe(false);
  });

  it('reports an unpriceable entry composition instead of assuming zero', () => {
    // A partial or missing valuation would understate the hypothetical, which OVERSTATES the pool's
    // contribution — the direction that would wrongly justify an exit.
    const report = computeReturn(baseline(), {
      currentEquityUsd: 10_500,
      currentStockPriceUsd: 800,
      holdEquityUsd: null,
      at: AT,
    });
    expect(report.poolContributionUsd).toBeNull();
    expect(report.poolContributionRatio).toBeNull();
    expect(report.incompleteReasons.join(' ')).toMatch(/could not be valued/);
    // And it must not read as "pool is fine".
    expect(isPoolContributionNegative(report)).toBe(false);
  });

  it('refuses to separate the market effect when a price is unusable', () => {
    const report = computeReturn(baseline(), {
      currentEquityUsd: 10_500,
      currentStockPriceUsd: 0,
      holdEquityUsd: 10_000,
      at: AT,
    });
    expect(report.marketContributionUsd).toBeNull();
    expect(report.incompleteReasons.join(' ')).toMatch(/stock price is unusable/);
  });
});

describe('valueEntryComposition: the hypothetical that sizes the pool contribution', () => {
  it('values both legs at current prices, decimal-adjusted', () => {
    const value = valueEntryComposition({
      initialToken0: { ui: 6_000_000_000_000_000_000n, decimals: 18 },
      initialToken1: { ui: 2_100_000_000_000_000_000_000n, decimals: 18 },
      price0Usd: 738,
      price1Usd: 1,
    });
    // 6 QQQB × 738 + 2,100 USDT.
    expect(value).toBeCloseTo(6 * 738 + 2_100, 6);
  });

  it('returns null rather than a partial sum when a leg cannot be priced', () => {
    // A partial valuation biases the contribution UPWARD (the hypothetical looks smaller than it is),
    // which would make an unprofitable pool look acceptable.
    expect(
      valueEntryComposition({
        initialToken0: { ui: 6_000_000_000_000_000_000n, decimals: 18 },
        initialToken1: { ui: 2_100_000_000_000_000_000_000n, decimals: 18 },
        price0Usd: 738,
        price1Usd: null,
      }),
    ).toBeNull();
  });
});

describe('isPoolContributionNegative: only a real shortfall counts', () => {
  it('ignores a negative inside the rounding floor', () => {
    const report = computeReturn(baseline(), {
      currentEquityUsd: 9_999.5,
      currentStockPriceUsd: 738,
      holdEquityUsd: 10_000,
      at: AT,
    });
    expect(report.poolContributionUsd).toBeCloseTo(-0.5, 6);
    // Sub-dollar is below the valuation's own error, so it is not evidence of anything.
    expect(isPoolContributionNegative(report, 1)).toBe(false);
  });

  it('flags a shortfall beyond the floor', () => {
    const report = computeReturn(baseline(), {
      currentEquityUsd: 9_900,
      currentStockPriceUsd: 738,
      holdEquityUsd: 10_000,
      at: AT,
    });
    expect(isPoolContributionNegative(report, 1)).toBe(true);
  });

  it('never flags an unmeasurable contribution', () => {
    const report = computeReturn(baseline(), {
      currentEquityUsd: 9_900,
      currentStockPriceUsd: 738,
      holdEquityUsd: null,
      at: AT,
    });
    // `null` means "we do not know", which must not be read as "negative".
    expect(isPoolContributionNegative(report)).toBe(false);
  });
});

describe('§4.2.1 computeAnnualizedApr — the APR the monitoring view shows', () => {
  const openedAt = '2026-10-02T00:00:00.000Z';

  it('simple-annualizes the total return over the holding period', () => {
    // 10 days held, +5% total → 0.05 / (10/365) = 1.825.
    const apr = computeAnnualizedApr(0.05, openedAt, '2026-10-12T00:00:00.000Z');
    expect(apr).not.toBeNull();
    expect(apr!.indicative).toBe(false);
    expect(apr!.aprRatio).toBeCloseTo(1.825, 3);
  });

  it('is negative when the position lost money', () => {
    const apr = computeAnnualizedApr(-0.02, openedAt, '2027-10-02T00:00:00.000Z');
    expect(apr!.aprRatio).toBeCloseTo(-0.02, 6);
  });

  it('marks sub-hour holdings as indicative and still returns a number', () => {
    // 1 minute held: years tiny → the figure would be astronomically large but flagged.
    const apr = computeAnnualizedApr(0.0001, openedAt, '2026-10-02T00:01:00.000Z');
    expect(apr).not.toBeNull();
    expect(apr!.indicative).toBe(true);
    expect(apr!.aprRatio).toBeGreaterThan(50);
  });

  it('returns null for a zero or backwards holding window', () => {
    expect(computeAnnualizedApr(0.05, openedAt, openedAt)).toBeNull();
    expect(computeAnnualizedApr(0.05, '2026-10-02T01:00:00.000Z', openedAt)).toBeNull();
  });

  it('returns null without a recorded total return', () => {
    expect(computeAnnualizedApr(null, openedAt, '2026-10-12T00:00:00.000Z')).toBeNull();
  });
});
