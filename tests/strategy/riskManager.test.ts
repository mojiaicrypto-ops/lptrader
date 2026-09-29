/**
 * §49-§67 risk layer acceptance tests (Plan T10 / §108 Risk group).
 *
 * Every published threshold is exercised **exactly at its boundary**, because that is where the
 * baseline's `>` vs `>=` wording decides the outcome and where an off-by-one in a comparison would
 * otherwise go unnoticed:
 *
 *   §55  1% / 2% / 3% / 5% depeg bands   §65-§66 NAV == initial × 0.85
 *   §59  TVL 24h drop 50% / 70%          §60  reserve 25% / 30% / 20%
 *   §49  rangeProgress 0.20 / 0.80       §50-§51 price == upper / == lower
 *
 * The two behavioural requirements that are *not* about numbers are tested separately:
 *   - closed market + large depeg ⇒ critical alert, never a forced exit (§56/§57);
 *   - price down with the underlying NAV down too ⇒ MARKET_RISK + HOLD, not a sell (§53).
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.ts';
import {
  MARKET_STATUSES,
  PEG_LEVELS,
  type MarketStatus,
  type PegAssessment,
  type PegLevel,
} from '../../src/types/adapters.ts';
import { DATA_SOURCES, type DataSource, type PoolSnapshot } from '../../src/types/market.ts';
import { ALERT_SEVERITIES, type AlertSeverity } from '../../src/types/notifier.ts';
import { BOT_STATES } from '../../src/types/state.ts';
import type { RiskConfig, StrategyConfig } from '../../src/types/config.ts';
import type { DrawdownState } from '../../src/types/portfolio.ts';
import type { IsoTimestamp } from '../../src/types/primitives.ts';
import {
  CLOSED_MARKET_THRESHOLD_EXPANSION,
  EMERGENCY_CONDITIONS,
  GLOBAL_RISK_OFF_ACTIONS,
  LOWER_RANGE_REVIEW_CHECKS,
  OUT_OF_RANGE_UP_FOLLOW_UPS,
  RISK_ACTIONS,
  RISK_ACTION_SEVERITY,
  alertSeverityFor,
  classifyPegLevel,
  computePegDeviation,
  evaluateDrawdown,
  evaluateEmergency,
  evaluateMarketDecline,
  evaluatePegRisk,
  evaluateRangeRisk,
  evaluateReserve,
  evaluateRisk,
  evaluateTvlCollapse,
  gradePegDeviation,
  pegThresholdsFrom,
  reserveThresholdsFrom,
  tvlObservationFrom,
  type EmergencyEvent,
  type RiskReport,
  type TvlObservation,
} from '../../src/strategy/riskManager.ts';

const NOW: IsoTimestamp = '2026-09-29T21:00:00.000Z';
const TOKEN = '56:0xqqqb';

/** §85 default risk thresholds, stated literally so a schema default change cannot silently move a test. */
const RISK: RiskConfig = {
  maxDrawdown: 0.15,
  pegWarning: 0.01,
  stopNewPosition: 0.02,
  exitReview: 0.03,
  emergencyExit: 0.05,
  tvlDropReview: 0.5,
  tvlDropEmergency: 0.7,
  minReserveBeforeNewLp: 0.25,
};

function pegAssessment(overrides: Partial<PegAssessment> = {}): PegAssessment {
  return {
    tokenId: TOKEN,
    deviation: 0,
    marketStatus: MARKET_STATUSES.OPEN,
    level: PEG_LEVELS.NORMAL,
    hardExitAllowed: true,
    reason: 'binance-index reference available',
    asOf: NOW,
    ...overrides,
  };
}

function drawdown(overrides: Partial<DrawdownState> = {}): DrawdownState {
  return {
    initialNAV: 10_000,
    peakNAV: 10_400,
    currentNAV: 9_000,
    drawdownFromPeak: 0.1346153846153846,
    drawdownFromInitial: 0.1,
    riskOffLineNAV: 8_500,
    breached: false,
    asOf: NOW,
    windowSeconds: 86_400,
    ...overrides,
  };
}

function tvlSeries(latest: number, baseline = 1_000_000, hours = 24): readonly TvlObservation[] {
  const latestMs = Date.parse(NOW);
  return [
    { asOf: new Date(latestMs - hours * 3_600_000).toISOString(), tvlUsd: baseline },
    { asOf: NOW, tvlUsd: latest },
  ];
}

async function builtinConfig(): Promise<StrategyConfig> {
  return loadConfig({ useBuiltinsOnly: true });
}

// -------------------------------------------------------------------------------------------
// §54-§55 — deviation and the five-band ladder
// -------------------------------------------------------------------------------------------

describe('§54 computePegDeviation', () => {
  it('is |onchain / referenceNAV − 1| and null — never 0 — for unusable inputs (§96)', () => {
    expect(computePegDeviation(100, 100)).toBe(0);
    expect(computePegDeviation(101, 100)).toBeCloseTo(0.01, 12);
    expect(computePegDeviation(99, 100)).toBeCloseTo(0.01, 12);
    expect(computePegDeviation(96, 100)).toBeCloseTo(0.04, 12);
    expect(gradePegDeviation(101, 100, RISK)).toEqual({ deviation: expect.any(Number), level: PEG_LEVELS.WARNING });

    for (const [onchain, reference] of [
      [100, 0],
      [100, -1],
      [0, 100],
      [Number.NaN, 100],
      [100, Number.NaN],
      [100, Number.POSITIVE_INFINITY],
    ] as const) {
      expect(computePegDeviation(onchain, reference)).toBeNull();
    }
  });
});

describe('§55 depeg ladder — every band boundary exactly', () => {
  const t = pegThresholdsFrom(RISK);

  it('grades <1% NORMAL and 1% exactly WARNING', () => {
    expect(classifyPegLevel(0, t)).toBe(PEG_LEVELS.NORMAL);
    expect(classifyPegLevel(0.0099, t)).toBe(PEG_LEVELS.NORMAL);
    // boundary: the 1% edge belongs to the upper band
    expect(classifyPegLevel(0.01, t)).toBe(PEG_LEVELS.WARNING);
  });

  it('grades 2% exactly STOP_NEW_CAPITAL and just below it WARNING', () => {
    expect(classifyPegLevel(0.0199, t)).toBe(PEG_LEVELS.WARNING);
    expect(classifyPegLevel(0.02, t)).toBe(PEG_LEVELS.STOP_NEW_CAPITAL);
  });

  it('grades 3% exactly EXIT_REVIEW and just below it STOP_NEW_CAPITAL', () => {
    expect(classifyPegLevel(0.0299, t)).toBe(PEG_LEVELS.STOP_NEW_CAPITAL);
    expect(classifyPegLevel(0.03, t)).toBe(PEG_LEVELS.EXIT_REVIEW);
  });

  it('grades 5% exactly EXIT_REVIEW and above it EMERGENCY_EXIT (baseline writes both as "3–5%" and ">5%")', () => {
    expect(classifyPegLevel(0.05, t)).toBe(PEG_LEVELS.EXIT_REVIEW);
    expect(classifyPegLevel(0.0500001, t)).toBe(PEG_LEVELS.EMERGENCY_EXIT);
    expect(classifyPegLevel(0.9, t)).toBe(PEG_LEVELS.EMERGENCY_EXIT);
  });

  it('reads the bands from config, not from a hardcoded 1/2/3/5%', () => {
    const widened: RiskConfig = {
      ...RISK,
      pegWarning: 0.02,
      stopNewPosition: 0.04,
      exitReview: 0.06,
      emergencyExit: 0.1,
    };
    const w = pegThresholdsFrom(widened);
    expect(w).toEqual({ warning: 0.02, stopNewCapital: 0.04, exitReview: 0.06, emergencyExit: 0.1 });
    expect(classifyPegLevel(0.01, w)).toBe(PEG_LEVELS.NORMAL);
    expect(classifyPegLevel(0.03, w)).toBe(PEG_LEVELS.WARNING);
    expect(classifyPegLevel(0.05, w)).toBe(PEG_LEVELS.STOP_NEW_CAPITAL);
    expect(classifyPegLevel(0.08, w)).toBe(PEG_LEVELS.EXIT_REVIEW);
    expect(classifyPegLevel(0.1, w)).toBe(PEG_LEVELS.EXIT_REVIEW);
    expect(classifyPegLevel(0.11, w)).toBe(PEG_LEVELS.EMERGENCY_EXIT);
  });

  it('maps each level to its action, with a critical alert from EXIT_REVIEW up (§107)', () => {
    const cases = [
      [0.005, RISK_ACTIONS.HOLD, ALERT_SEVERITIES.INFO],
      [0.015, RISK_ACTIONS.ALERT, ALERT_SEVERITIES.WARNING],
      [0.025, RISK_ACTIONS.NO_NEW_CAPITAL, ALERT_SEVERITIES.WARNING],
      [0.04, RISK_ACTIONS.EXIT_REVIEW, ALERT_SEVERITIES.CRITICAL],
      [0.06, RISK_ACTIONS.EMERGENCY_EXIT, ALERT_SEVERITIES.CRITICAL],
    ] as const;

    for (const [deviation, action, severity] of cases) {
      const verdict = evaluatePegRisk(pegAssessment({ deviation }), RISK);
      expect({ deviation, action: verdict.action, severity: verdict.alertSeverity }).toEqual({
        deviation,
        action,
        severity,
      });
      expect(verdict.reason.length).toBeGreaterThan(0);
      expect(verdict.hardExitPermitted).toBe(action === RISK_ACTIONS.EMERGENCY_EXIT);
    }
  });

  it('reports insufficient-data — not "safe" — when there is no reference NAV', () => {
    const verdict = evaluatePegRisk(pegAssessment({ deviation: null }), RISK);
    expect(verdict.status).toBe('insufficient-data');
    expect(verdict.level).toBeNull();
    expect(verdict.deviation).toBeNull();
    expect(verdict.hardExitPermitted).toBe(false);
    expect(verdict.action).toBe(RISK_ACTIONS.ALERT);
    expect(verdict.reason).toContain('no usable reference NAV');
  });

  it('treats an unreadable deviation as insufficient data rather than throwing', () => {
    for (const deviation of [Number.NaN, Number.POSITIVE_INFINITY, -0.01]) {
      const verdict = evaluatePegRisk(pegAssessment({ deviation }), RISK);
      expect(verdict.status).toBe('insufficient-data');
      expect(verdict.deviation).toBeNull();
      expect(verdict.hardExitPermitted).toBe(false);
      expect(verdict.action).toBe(RISK_ACTIONS.ALERT);
    }
  });
});

// -------------------------------------------------------------------------------------------
// §56-§57 — closed market: expanded thresholds, alerts only
// -------------------------------------------------------------------------------------------

describe('§56 expanded thresholds while the reference market is not OPEN', () => {
  it.each([MARKET_STATUSES.CLOSED, MARKET_STATUSES.WEEKEND, MARKET_STATUSES.HOLIDAY, MARKET_STATUSES.UNKNOWN])(
    'widens the bands for marketStatus=%s',
    (status: MarketStatus) => {
      const factor = CLOSED_MARKET_THRESHOLD_EXPANSION;
      expect(factor).toBe(2);

      const verdict = evaluatePegRisk(pegAssessment({ deviation: 0.012, marketStatus: status }), RISK);

      // 1.2% would be WARNING at the configured bands, but a stale Friday close must not be
      // graded against a 1% tolerance on a weekend (§56 rationale).
      expect(verdict.rawLevel).toBe(PEG_LEVELS.WARNING);
      expect(verdict.level).toBe(PEG_LEVELS.NORMAL);
      expect(verdict.expanded).toBe(true);
      expect(verdict.action).toBe(RISK_ACTIONS.HOLD);
      expect(verdict.thresholds.warning).toBeCloseTo(0.02, 12);
      expect(verdict.thresholds.emergencyExit).toBeCloseTo(0.1, 12);
      expect(verdict.reason).toContain('bands expanded');
    },
  );

  it('leaves the bands untouched when the market is confirmed OPEN', () => {
    const verdict = evaluatePegRisk(pegAssessment({ deviation: 0.012, marketStatus: MARKET_STATUSES.OPEN }), RISK);
    expect(verdict.expanded).toBe(false);
    expect(verdict.level).toBe(PEG_LEVELS.WARNING);
    expect(verdict.thresholds.warning).toBe(RISK.pegWarning);
  });

  it('isolates §56 from §57 when the expansion is pinned to 1', () => {
    const verdict = evaluatePegRisk(pegAssessment({ deviation: 0.012, marketStatus: MARKET_STATUSES.WEEKEND }), RISK, {
      closedMarketThresholdExpansion: 1,
    });
    expect(verdict.expanded).toBe(false);
    expect(verdict.level).toBe(PEG_LEVELS.WARNING);
    expect(verdict.action).toBe(RISK_ACTIONS.ALERT);
  });

  it('grades exactly at each widened band boundary: 2% / 4% / 6% / 10%', () => {
    const weekend = (deviation: number): PegLevel =>
      evaluatePegRisk(
        pegAssessment({ deviation, marketStatus: MARKET_STATUSES.WEEKEND, hardExitAllowed: false }),
        RISK,
      ).level as PegLevel;

    expect(weekend(0.0199)).toBe(PEG_LEVELS.NORMAL);
    expect(weekend(0.02)).toBe(PEG_LEVELS.WARNING);
    expect(weekend(0.0399)).toBe(PEG_LEVELS.WARNING);
    expect(weekend(0.04)).toBe(PEG_LEVELS.STOP_NEW_CAPITAL);
    expect(weekend(0.0599)).toBe(PEG_LEVELS.STOP_NEW_CAPITAL);
    expect(weekend(0.06)).toBe(PEG_LEVELS.EXIT_REVIEW);
    expect(weekend(0.1)).toBe(PEG_LEVELS.EXIT_REVIEW);
    expect(weekend(0.1000001)).toBe(PEG_LEVELS.EMERGENCY_EXIT);
  });
});

describe('§57 closed market + large depeg ⇒ alert only, NEVER a forced exit', () => {
  it('degrades a 6% depeg on a closed market to a critical alert', () => {
    const verdict = evaluatePegRisk(
      pegAssessment({
        deviation: 0.06,
        marketStatus: MARKET_STATUSES.CLOSED,
        hardExitAllowed: false,
        reason: 'closed market, no alternative reference (indicative unavailable)',
      }),
      RISK,
    );

    expect(verdict.status).toBe('ok');
    expect(verdict.deviation).toBeCloseTo(0.06, 12);
    // The severity grade is still reported honestly: at the configured bands 6% is an emergency,
    // while the §56-expanded bands grade it EXIT_REVIEW. Either way it is exit-grade...
    expect(verdict.level).toBe(PEG_LEVELS.EXIT_REVIEW);
    expect(verdict.rawLevel).toBe(PEG_LEVELS.EMERGENCY_EXIT);
    // ...but the action must not be an exit, and the alert must be critical.
    expect(verdict.action).not.toBe(RISK_ACTIONS.EMERGENCY_EXIT);
    expect(verdict.action).not.toBe(RISK_ACTIONS.EXIT_REVIEW);
    expect(verdict.action).toBe(RISK_ACTIONS.ALERT);
    expect(verdict.alertSeverity).toBe(ALERT_SEVERITIES.CRITICAL);
    expect(verdict.hardExitPermitted).toBe(false);
    expect(verdict.reason).toContain('NO forced exit');
    expect(verdict.reason).toContain('hard exit is disabled');
  });

  it('does not close the position even for a deviation past the expanded emergency band', () => {
    const verdict = evaluatePegRisk(
      pegAssessment({ deviation: 0.2, marketStatus: MARKET_STATUSES.WEEKEND, hardExitAllowed: false }),
      RISK,
    );
    expect(verdict.level).toBe(PEG_LEVELS.EMERGENCY_EXIT);
    expect(verdict.action).toBe(RISK_ACTIONS.ALERT);
    expect(verdict.hardExitPermitted).toBe(false);
  });

  it('still alerts critically for any exit-grade size — no exit, no matter the deviation', () => {
    for (const deviation of [0.061, 0.2, 0.9]) {
      const verdict = evaluatePegRisk(
        pegAssessment({ deviation, marketStatus: MARKET_STATUSES.WEEKEND, hardExitAllowed: false }),
        RISK,
      );
      expect(verdict.action).toBe(RISK_ACTIONS.ALERT);
      expect(verdict.alertSeverity).toBe(ALERT_SEVERITIES.CRITICAL);
      expect([RISK_ACTIONS.EMERGENCY_EXIT, RISK_ACTIONS.EXIT_REVIEW]).not.toContain(verdict.action);
    }
  });

  it('permits the hard exit for the same deviation when the reference IS trustworthy', () => {
    const open = evaluatePegRisk(pegAssessment({ deviation: 0.06, marketStatus: MARKET_STATUSES.OPEN }), RISK);
    expect(open.action).toBe(RISK_ACTIONS.EMERGENCY_EXIT);
    expect(open.hardExitPermitted).toBe(true);
    expect(open.alertSeverity).toBe(ALERT_SEVERITIES.CRITICAL);

    // A caller may always narrow the permission, never widen it.
    const narrowed = evaluatePegRisk(
      pegAssessment({ deviation: 0.06, marketStatus: MARKET_STATUSES.OPEN }),
      RISK,
      { disallowHardExit: true },
    );
    expect(narrowed.action).toBe(RISK_ACTIONS.ALERT);
    expect(narrowed.hardExitPermitted).toBe(false);
  });

  it('does not resurrect the exit when a caller tries to widen a closed-market assessment', () => {
    const verdict = evaluatePegRisk(
      pegAssessment({ deviation: 0.06, marketStatus: MARKET_STATUSES.CLOSED, hardExitAllowed: false }),
      RISK,
      { disallowHardExit: false },
    );
    expect(verdict.hardExitPermitted).toBe(false);
    expect(verdict.action).toBe(RISK_ACTIONS.ALERT);
  });
});

// -------------------------------------------------------------------------------------------
// §65-§67 — global drawdown line
// -------------------------------------------------------------------------------------------

describe('§65-§67 global drawdown', () => {
  it('triggers at exactly the risk line: NAV == initial × (1 − max_drawdown) is INCLUSIVE', () => {
    const verdict = evaluateDrawdown(drawdown({ currentNAV: 8_500 }), RISK);
    expect(verdict.riskOffLineNAV).toBe(8_500);
    expect(verdict.breached).toBe(true);
    expect(verdict.action).toBe(RISK_ACTIONS.GLOBAL_RISK_OFF);
    expect(verdict.alertSeverity).toBe(ALERT_SEVERITIES.CRITICAL);
    expect(verdict.reason).toContain('GLOBAL_RISK_OFF');
  });

  it('does not trigger one cent above the line, and triggers one cent below', () => {
    expect(evaluateDrawdown(drawdown({ currentNAV: 8_500.01 }), RISK).breached).toBe(false);
    expect(evaluateDrawdown(drawdown({ currentNAV: 8_500.01 }), RISK).action).toBe(RISK_ACTIONS.HOLD);
    expect(evaluateDrawdown(drawdown({ currentNAV: 8_499.99 }), RISK).breached).toBe(true);
  });

  it('emits §67 six actions in baseline order, and none when intact', () => {
    expect(GLOBAL_RISK_OFF_ACTIONS).toEqual([
      'STOP_NEW_POSITIONS',
      'STOP_ADDING_LIQUIDITY',
      'REMOVE_ACTIVE_LIQUIDITY',
      'COLLECT_FEES',
      'RECORD_ASSETS',
      'SEND_CRITICAL_ALERT',
    ]);
    expect(evaluateDrawdown(drawdown({ currentNAV: 8_500 }), RISK).requiredActions).toEqual(
      GLOBAL_RISK_OFF_ACTIONS,
    );
    expect(evaluateDrawdown(drawdown({ currentNAV: 9_500 }), RISK).requiredActions).toEqual([]);
  });

  it('fails closed when the NAV and the supplied state disagree', () => {
    // NAV is above the line but the state flagged a breach ⇒ breach (never "safe").
    const stateFlagged = evaluateDrawdown(drawdown({ currentNAV: 10_000, breached: true }), RISK);
    expect(stateFlagged.breached).toBe(true);
    expect(stateFlagged.stateFlaggedBreach).toBe(true);

    // NAV computes a breach even though the caller's flag said otherwise ⇒ breach.
    const computed = evaluateDrawdown(drawdown({ currentNAV: 8_400, breached: false }), RISK);
    expect(computed.breached).toBe(true);
    expect(computed.stateFlaggedBreach).toBe(false);
    expect(computed.reason).toContain('GLOBAL_RISK_OFF');
  });

  it('fails closed on an unreadable NAV instead of reporting the risk line intact', () => {
    for (const nav of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const verdict = evaluateDrawdown(drawdown({ currentNAV: nav }), RISK);
      expect(verdict.status).toBe('insufficient-data');
      expect(verdict.breached).toBe(false);
      // No new capital, critical alert, but no §67 liquidity removal on bad data.
      expect(verdict.action).toBe(RISK_ACTIONS.RISK_REVIEW);
      expect(verdict.alertSeverity).toBe(ALERT_SEVERITIES.CRITICAL);
      expect(verdict.requiredActions).toEqual([]);
      expect(verdict.reason).toContain('unreadable');

      const badInitial = evaluateDrawdown(drawdown({ initialNAV: Number.NaN }), RISK);
      expect(badInitial.status).toBe('insufficient-data');
    }
  });

  it('reads max_drawdown from config', () => {
    const strict: RiskConfig = { ...RISK, maxDrawdown: 0.1 };
    expect(evaluateDrawdown(drawdown({ currentNAV: 9_000 }), strict).breached).toBe(true);
    expect(evaluateDrawdown(drawdown({ currentNAV: 9_000 }), strict).riskOffLineNAV).toBe(9_000);
    expect(evaluateDrawdown(drawdown({ currentNAV: 9_000.01 }), strict).breached).toBe(false);
  });
});

// -------------------------------------------------------------------------------------------
// §59 — TVL collapse
// -------------------------------------------------------------------------------------------

describe('§59 TVL collapse', () => {
  it('treats exactly 50% as NOT a collapse and just above it as RISK_REVIEW', () => {
    const atThreshold = evaluateTvlCollapse(tvlSeries(500_000), RISK);
    expect(atThreshold.dropRatio).toBe(0.5);
    expect(atThreshold.status).toBe('ok');
    expect(atThreshold.action).toBe(RISK_ACTIONS.HOLD);

    const above = evaluateTvlCollapse(tvlSeries(499_999), RISK);
    expect(above.dropRatio).toBeCloseTo(0.500001, 12);
    expect(above.status).toBe('review');
    expect(above.action).toBe(RISK_ACTIONS.RISK_REVIEW);
    expect(above.alertSeverity).toBe(ALERT_SEVERITIES.WARNING);
  });

  it('treats exactly 70% as RISK_REVIEW and just above it as EMERGENCY', () => {
    const atThreshold = evaluateTvlCollapse(tvlSeries(300_000), RISK);
    expect(atThreshold.dropRatio).toBe(0.7);
    expect(atThreshold.status).toBe('review');
    expect(atThreshold.action).toBe(RISK_ACTIONS.RISK_REVIEW);

    const above = evaluateTvlCollapse(tvlSeries(299_999), RISK);
    expect(above.dropRatio).toBeGreaterThan(0.7);
    expect(above.status).toBe('emergency');
    expect(above.action).toBe(RISK_ACTIONS.EMERGENCY);
    expect(above.alertSeverity).toBe(ALERT_SEVERITIES.CRITICAL);
  });

  it('reports insufficient-data instead of a default-safe verdict when history is missing', () => {
    const empty = evaluateTvlCollapse([], RISK);
    expect(empty.status).toBe('insufficient-data');
    expect(empty.failClosed).toBe(true);
    expect(empty.dropRatio).toBeNull();

    const single = evaluateTvlCollapse([{ asOf: NOW, tvlUsd: 1_000_000 }], RISK);
    expect(single.status).toBe('insufficient-data');
    expect(single.failClosed).toBe(true);
    expect(single.action).toBe(RISK_ACTIONS.ALERT);

    // Two readings only 6h apart cannot answer a 24h question.
    const tooShort = evaluateTvlCollapse(tvlSeries(100_000, 1_000_000, 6), RISK);
    expect(tooShort.status).toBe('insufficient-data');
    expect(tooShort.dropRatio).toBeNull();
    expect(tooShort.reason).toContain('less than 24h');

    // A zero baseline is not a usable denominator.
    const zeroBaseline = evaluateTvlCollapse(tvlSeries(0, 0), RISK);
    expect(zeroBaseline.status).toBe('insufficient-data');
    expect(zeroBaseline.failClosed).toBe(true);
  });

  it('uses the baseline at (or before) the window boundary, not just the previous reading', () => {
    const latestMs = Date.parse(NOW);
    const series: readonly TvlObservation[] = [
      { asOf: new Date(latestMs - 48 * 3_600_000).toISOString(), tvlUsd: 2_000_000 },
      { asOf: new Date(latestMs - 25 * 3_600_000).toISOString(), tvlUsd: 1_000_000 },
      { asOf: new Date(latestMs - 1 * 3_600_000).toISOString(), tvlUsd: 900_000 },
      { asOf: NOW, tvlUsd: 400_000 },
    ];
    const verdict = evaluateTvlCollapse(series, RISK);
    // Against the 25h-old reading the drop is 60% (review); against the 1h-old reading it is only 55%.
    expect(verdict.baselineAsOf).toBe(new Date(latestMs - 25 * 3_600_000).toISOString());
    expect(verdict.dropRatio).toBeCloseTo(0.6, 12);
    expect(verdict.status).toBe('review');
  });

  it('reads both TVL thresholds from config', () => {
    const strict: RiskConfig = { ...RISK, tvlDropReview: 0.1, tvlDropEmergency: 0.2 };
    expect(evaluateTvlCollapse(tvlSeries(900_000), strict).status).toBe('ok');
    expect(evaluateTvlCollapse(tvlSeries(899_000), strict).status).toBe('review');
    expect(evaluateTvlCollapse(tvlSeries(799_000), strict).status).toBe('emergency');
  });

  it('drops stale / unavailable / non-finite readings instead of recording a fake 100% collapse', () => {
    const sourced = (
      value: number,
      stale = false,
      source: DataSource = DATA_SOURCES.GECKOTERMINAL,
    ): Pick<PoolSnapshot, 'timestamp' | 'tvlUSD'> => ({
      timestamp: NOW,
      tvlUSD: { value, source, asOf: NOW, stale },
    });

    expect(tvlObservationFrom(sourced(1_000_000))).toEqual({
      asOf: NOW,
      tvlUsd: 1_000_000,
      source: DATA_SOURCES.GECKOTERMINAL,
    });
    expect(tvlObservationFrom(sourced(1_000_000, true))).toBeNull();
    expect(tvlObservationFrom(sourced(1_000_000, false, DATA_SOURCES.UNAVAILABLE))).toBeNull();
    expect(tvlObservationFrom(sourced(Number.NaN))).toBeNull();
    expect(tvlObservationFrom(sourced(-1))).toBeNull();

    // The gap is what the caller must record: the series just stays short ⇒ insufficient-data.
    const series = [tvlObservationFrom(sourced(1_000_000, true))].filter(
      (o): o is TvlObservation => o !== null,
    );
    expect(evaluateTvlCollapse(series, RISK).status).toBe('insufficient-data');
  });
});

// -------------------------------------------------------------------------------------------
// §60 / §104-§105 — reserve ratio
// -------------------------------------------------------------------------------------------

const RESERVE = reserveThresholdsFrom({ risk: RISK, capital: { reserveRatio: 0.3 } });

describe('§60 reserve monitoring', () => {
  it('blocks new LP below 25% but exactly 25% is allowed, and never forces a rebalance', () => {
    const below = evaluateReserve(0.2499, RESERVE);
    expect(below.newLpBlocked).toBe(true);
    expect(below.action).toBe(RISK_ACTIONS.NO_NEW_CAPITAL);
    expect(below.alertSeverity).toBe(ALERT_SEVERITIES.WARNING);
    expect(below.forceRebalance).toBe(false);
    expect(below.reason).toContain('new LP prohibited');

    // boundary: the rule is `< 25%`, so 25% itself still permits new LP.
    const atThreshold = evaluateReserve(0.25, RESERVE);
    expect(atThreshold.newLpBlocked).toBe(false);
    expect(atThreshold.action).toBe(RISK_ACTIONS.ALERT);
    expect(atThreshold.reason).toContain('new LP still allowed');
  });

  it('treats 30% as normal and 29.99% as a below-target warning', () => {
    expect(evaluateReserve(0.3, RESERVE).action).toBe(RISK_ACTIONS.HOLD);
    expect(evaluateReserve(0.3, RESERVE).reason).toContain('normal');
    expect(evaluateReserve(0.2999, RESERVE).action).toBe(RISK_ACTIONS.ALERT);
    expect(evaluateReserve(0.9, RESERVE).action).toBe(RISK_ACTIONS.HOLD);
  });

  it('escalates to critical below the §105 20% warning floor, with 20% itself still warning', () => {
    const atFloor = evaluateReserve(0.2, RESERVE);
    expect(atFloor.newLpBlocked).toBe(true);
    expect(atFloor.alertSeverity).toBe(ALERT_SEVERITIES.WARNING);

    const belowFloor = evaluateReserve(0.1999, RESERVE);
    expect(belowFloor.alertSeverity).toBe(ALERT_SEVERITIES.CRITICAL);
    expect(belowFloor.reason).toContain('warning floor');
  });

  it('reads the 25% floor from config', () => {
    const other = reserveThresholdsFrom({
      risk: { ...RISK, minReserveBeforeNewLp: 0.4 },
      capital: { reserveRatio: 0.3 },
    });
    expect(evaluateReserve(0.35, other).newLpBlocked).toBe(true);
    expect(evaluateReserve(0.4, other).newLpBlocked).toBe(false);
  });

  it('refuses new LP when the ratio is unreadable, without forcing a rebalance', () => {
    const verdict = evaluateReserve(Number.NaN, RESERVE);
    expect(verdict.status).toBe('insufficient-data');
    expect(verdict.newLpBlocked).toBe(true);
    expect(verdict.forceRebalance).toBe(false);
    expect(verdict.action).toBe(RISK_ACTIONS.NO_NEW_CAPITAL);
    expect(verdict.alertSeverity).toBe(ALERT_SEVERITIES.CRITICAL);
  });
});

// -------------------------------------------------------------------------------------------
// §49-§52 — boundary watch and out-of-range
// -------------------------------------------------------------------------------------------

const RANGE = { lowerPrice: 100, upperPrice: 200 } as const;

describe('§49 near boundary', () => {
  it('does not watch at exactly 0.80 progress, watches just above it', () => {
    expect(evaluateRangeRisk({ ...RANGE, currentPrice: 180 }).rangeProgress).toBe(0.8);
    const atThreshold = evaluateRangeRisk({ ...RANGE, currentPrice: 180 });
    expect(atThreshold.boundaryWatch).toBe(false);
    expect(atThreshold.action).toBe(RISK_ACTIONS.HOLD);

    const above = evaluateRangeRisk({ ...RANGE, currentPrice: 180.01 });
    expect(above.rangeProgress).toBeGreaterThan(0.8);
    expect(above.boundaryWatch).toBe(true);
    expect(above.action).toBe(RISK_ACTIONS.BOUNDARY_WATCH);
    expect(above.alertSeverity).toBe(ALERT_SEVERITIES.INFO);
  });

  it('does not watch at exactly 0.20 progress, watches just below it', () => {
    const atThreshold = evaluateRangeRisk({ ...RANGE, currentPrice: 120 });
    expect(atThreshold.rangeProgress).toBe(0.2);
    expect(atThreshold.boundaryWatch).toBe(false);

    const below = evaluateRangeRisk({ ...RANGE, currentPrice: 119.99 });
    expect(below.rangeProgress).toBeLessThan(0.2);
    expect(below.action).toBe(RISK_ACTIONS.BOUNDARY_WATCH);
  });

  it('is alert-only: BOUNDARY_WATCH never participates in a trade decision (user ruling C3)', () => {
    const watch = evaluateRangeRisk({ ...RANGE, currentPrice: 199 });
    expect(watch.alertOnly).toBe(true);
    expect(watch.rescanRequired).toBe(false);
    expect(watch.noAutoSell).toBe(false);
    expect(watch.followUps).toEqual([]);
    expect(watch.waitHours).toBeNull();
    expect(watch.reason).toContain('alert only');
  });

  it('derives progress as (Current − Lower) / (Upper − Lower)', () => {
    expect(evaluateRangeRisk({ ...RANGE, currentPrice: 150 }).rangeProgress).toBe(0.5);
    expect(evaluateRangeRisk({ ...RANGE, currentPrice: 175 }).rangeProgress).toBe(0.75);
    expect(evaluateRangeRisk({ lowerPrice: 630, upperPrice: 860, currentPrice: 740 }).rangeProgress).toBeCloseTo(
      (740 - 630) / (860 - 630),
      12,
    );
  });
});

describe('§50-§51 out of range', () => {
  it('treats price == upper as OUT_OF_RANGE_UP and forbids chasing (§50)', () => {
    const atUpper = evaluateRangeRisk({ ...RANGE, currentPrice: 200 });
    expect(atUpper.outOfRange).toBe('up');
    expect(atUpper.action).toBe(RISK_ACTIONS.OUT_OF_RANGE_UP);
    expect(atUpper.followUps).toEqual([...OUT_OF_RANGE_UP_FOLLOW_UPS]);
    expect(atUpper.followUps[0]).toBe('DO_NOT_CHASE_UP');
    expect(atUpper.waitHours).toEqual({ min: 12, max: 24 });
    expect(atUpper.rescanRequired).toBe(true);
    expect(atUpper.boundaryWatch).toBe(false);
    expect(atUpper.reason).toContain('do NOT chase up');

    expect(evaluateRangeRisk({ ...RANGE, currentPrice: 250 }).action).toBe(RISK_ACTIONS.OUT_OF_RANGE_UP);
  });

  it('treats price == lower as RISK_REVIEW with no automatic sell (§51-§52)', () => {
    const atLower = evaluateRangeRisk({ ...RANGE, currentPrice: 100 });
    expect(atLower.outOfRange).toBe('down');
    expect(atLower.action).toBe(RISK_ACTIONS.RISK_REVIEW);
    expect(atLower.noAutoSell).toBe(true);
    expect(atLower.reviewChecks).toEqual([...LOWER_RANGE_REVIEW_CHECKS]);
    expect(atLower.reason).toContain('NO automatic sell');
    expect(atLower.waitHours).toBeNull();

    const below = evaluateRangeRisk({ ...RANGE, currentPrice: 80 });
    expect(below.action).toBe(RISK_ACTIONS.RISK_REVIEW);
    expect(below.outOfRange).toBe('down');
  });

  it('does not invent a verdict for an inverted range (a caller bug, not a market state)', () => {
    expect(() => evaluateRangeRisk({ lowerPrice: 200, upperPrice: 100, currentPrice: 150 })).toThrow(
      /inverted range/,
    );
    expect(() => evaluateRangeRisk({ lowerPrice: 100, upperPrice: 100, currentPrice: 100 })).toThrow(
      /inverted range/,
    );
  });

  it('fails closed into RISK_REVIEW when a price is unreadable', () => {
    const verdict = evaluateRangeRisk({ ...RANGE, currentPrice: Number.NaN });
    expect(verdict.status).toBe('insufficient-data');
    expect(verdict.action).toBe(RISK_ACTIONS.RISK_REVIEW);
    expect(verdict.alertSeverity).toBe(ALERT_SEVERITIES.CRITICAL);
    expect(verdict.outOfRange).toBe('none');
    expect(verdict.noAutoSell).toBe(true);
    expect(verdict.reason).toContain('unknowable');
  });
});

// -------------------------------------------------------------------------------------------
// §58 — emergency conditions
// -------------------------------------------------------------------------------------------

describe('§58 emergency triggers', () => {
  const allConditions = Object.values(EMERGENCY_CONDITIONS);

  it('covers the full baseline list', () => {
    expect(allConditions).toEqual([
      'TOKEN_CONTRACT_PAUSED',
      'ISSUER_REDEMPTION_SUSPENDED',
      'DEX_POOL_LIQUIDITY_COLLAPSE',
      'TVL_DROP_OVER_50PCT',
      'UNEXPECTED_CONTRACT_UPGRADE',
      'STABLECOIN_DEPEG',
      'STOCK_TOKEN_DEPEG_OVER_5PCT',
      'ORACLE_FAILURE',
      'CONTRACT_SECURITY_ALERT',
    ]);
  });

  it.each(allConditions)('each condition independently triggers EMERGENCY: %s', (condition) => {
    const event: EmergencyEvent = {
      condition,
      detectedAt: NOW,
      detail: `${condition} observed on chain`,
      source: 'test',
    };
    const verdict = evaluateEmergency([event]);
    expect(verdict.active).toBe(true);
    expect(verdict.conditions).toEqual([condition]);
    expect(verdict.action).toBe(RISK_ACTIONS.EMERGENCY);
    expect(verdict.alertSeverity).toBe(ALERT_SEVERITIES.CRITICAL);
    expect(verdict.readOnly).toBe(true);
    expect(verdict.noNewCapital).toBe(true);
    expect(verdict.requiresManualClear).toBe(true);
    expect(verdict.reason).toContain(condition);
  });

  it('stays inactive with no asserted condition — an emergency is never guessed', () => {
    const verdict = evaluateEmergency([]);
    expect(verdict.active).toBe(false);
    expect(verdict.action).toBe(RISK_ACTIONS.HOLD);
    expect(verdict.conditions).toEqual([]);
    expect(verdict.reason).toContain('no emergency condition');
  });

  it('collapses duplicates but preserves every event for the audit log', () => {
    const events: readonly EmergencyEvent[] = [
      { condition: EMERGENCY_CONDITIONS.ORACLE_FAILURE, detectedAt: NOW, detail: 'first' },
      { condition: EMERGENCY_CONDITIONS.ORACLE_FAILURE, detectedAt: NOW, detail: 'second' },
      { condition: EMERGENCY_CONDITIONS.STABLECOIN_DEPEG, detectedAt: NOW, detail: 'usdc 0.97' },
    ];
    const verdict = evaluateEmergency(events);
    expect(verdict.conditions).toEqual([
      EMERGENCY_CONDITIONS.ORACLE_FAILURE,
      EMERGENCY_CONDITIONS.STABLECOIN_DEPEG,
    ]);
    expect(verdict.events).toHaveLength(3);
    expect(verdict.reason).toContain('usdc 0.97');
  });
});

// -------------------------------------------------------------------------------------------
// §53 — ordinary market decline
// -------------------------------------------------------------------------------------------

describe('§53 ordinary market decline ⇒ MARKET_RISK, default HOLD', () => {
  it('holds (does not sell) when price and reference NAV fall together with a normal peg', () => {
    const verdict = evaluateMarketDecline(
      { stockPriceChange: -0.08, referenceNavChange: -0.081, tokenDeviation: 0.004, asOf: NOW },
      RISK,
    );
    expect(verdict.marketDecline).toBe(true);
    expect(verdict.action).toBe(RISK_ACTIONS.MARKET_RISK);
    expect(verdict.hold).toBe(true);
    expect(verdict.status).toBe('ok');
    expect(verdict.action).not.toBe(RISK_ACTIONS.EXIT_REVIEW);
    expect(verdict.reason).toContain('default HOLD');
  });

  it('holds at the full §53 boundary: 6% depeg on a closed market is still not a sell here', () => {
    // Same shape as the closed-market depeg test: the §53 verdict never authorises a sell either.
    const verdict = evaluateMarketDecline(
      { stockPriceChange: -0.12, referenceNavChange: -0.12, tokenDeviation: 0.06, asOf: NOW },
      RISK,
    );
    expect(verdict.action).toBe(RISK_ACTIONS.RISK_REVIEW);
    expect(verdict.hold).toBe(false);
  });

  it('is not a market decline when the price rose', () => {
    const verdict = evaluateMarketDecline(
      { stockPriceChange: 0.03, referenceNavChange: 0.03, tokenDeviation: 0.002, asOf: NOW },
      RISK,
    );
    expect(verdict.marketDecline).toBe(false);
    expect(verdict.action).toBe(RISK_ACTIONS.HOLD);
  });

  it('scales the peg leg at the configured warning threshold', () => {
    const atThreshold = evaluateMarketDecline(
      { stockPriceChange: -0.05, referenceNavChange: -0.05, tokenDeviation: RISK.pegWarning, asOf: NOW },
      RISK,
    );
    expect(atThreshold.action).toBe(RISK_ACTIONS.RISK_REVIEW);
    expect(atThreshold.reason).toContain('depeg');

    const belowThreshold = evaluateMarketDecline(
      { stockPriceChange: -0.05, referenceNavChange: -0.05, tokenDeviation: 0.0099, asOf: NOW },
      RISK,
    );
    expect(belowThreshold.action).toBe(RISK_ACTIONS.MARKET_RISK);
  });

  it('flags unexplained divergence and unreadable inputs without pretending to know', () => {
    const divergence = evaluateMarketDecline(
      { stockPriceChange: -0.05, referenceNavChange: 0.01, tokenDeviation: 0.002, asOf: NOW },
      RISK,
    );
    expect(divergence.action).toBe(RISK_ACTIONS.RISK_REVIEW);
    expect(divergence.reason).toContain('did not follow');

    const noNav = evaluateMarketDecline(
      { stockPriceChange: -0.05, referenceNavChange: null, tokenDeviation: 0.002, asOf: NOW },
      RISK,
    );
    expect(noNav.status).toBe('insufficient-data');
    expect(noNav.action).toBe(RISK_ACTIONS.HOLD);

    const noPrice = evaluateMarketDecline(
      { stockPriceChange: null, referenceNavChange: -0.05, tokenDeviation: null, asOf: NOW },
      RISK,
    );
    expect(noPrice.status).toBe('insufficient-data');
    expect(noPrice.action).toBe(RISK_ACTIONS.HOLD);
  });

  it('never calls a decline ordinary when the peg leg cannot be verified', () => {
    // Without a deviation reading we cannot check "Token/NAV 正常" *or* rule out a depeg, so the
    // verdict is degraded — HOLD (nothing moves) but explicitly incomplete.
    for (const deviation of [null, Number.NaN]) {
      const verdict = evaluateMarketDecline(
        { stockPriceChange: -0.06, referenceNavChange: -0.06, tokenDeviation: deviation, asOf: NOW },
        RISK,
      );
      expect(verdict.status).toBe('insufficient-data');
      expect(verdict.action).toBe(RISK_ACTIONS.HOLD);
      expect(verdict.hold).toBe(true);
      expect(verdict.alertSeverity).toBe(ALERT_SEVERITIES.WARNING);
      expect(verdict.reason).toContain('cannot confirm');
    }
  });
});

// -------------------------------------------------------------------------------------------
// Composite report
// -------------------------------------------------------------------------------------------

describe('composite evaluateRisk', () => {
  it('picks the most severe domain and reports §67 actions + read-only state for a breach', async () => {
    const config = await builtinConfig();
    const report = evaluateRisk(
      {
        asOf: NOW,
        peg: pegAssessment({ deviation: 0.015 }),
        drawdown: drawdown({ currentNAV: 8_500 }),
        tvlSeries: tvlSeries(400_000),
        reserveRatio: 0.22,
        range: { ...RANGE, currentPrice: 150 },
        emergencyEvents: [],
        marketDecline: { stockPriceChange: 0.01, referenceNavChange: 0.01, tokenDeviation: 0.015, asOf: NOW },
      },
      config,
    );

    expect(report.action).toBe(RISK_ACTIONS.GLOBAL_RISK_OFF);
    expect(report.recommendedState).toBe(BOT_STATES.GLOBAL_RISK_OFF);
    expect(report.readOnly).toBe(true);
    expect(report.noNewCapital).toBe(true);
    expect(report.suggestedActions).toEqual(GLOBAL_RISK_OFF_ACTIONS);
    expect(report.totalNav).toBe(8_500);
    expect(report.tokenDeviation).toBe(0.015);
    expect(report.missingInputs).toEqual([]);
    // Every non-HOLD domain contributes a reason for the §77 DecisionLog.
    expect(report.reasons.length).toBeGreaterThanOrEqual(4);
    expect(report.reasons.every((r) => r.length > 0)).toBe(true);
  });

  it('lets an emergency outrank everything and keeps the exit permission honest', async () => {
    const config = await builtinConfig();
    const report = evaluateRisk(
      {
        asOf: NOW,
        peg: pegAssessment({
          deviation: 0.08,
          marketStatus: MARKET_STATUSES.WEEKEND,
          hardExitAllowed: false,
        }),
        drawdown: drawdown({ currentNAV: 8_000 }),
        emergencyEvents: [
          { condition: EMERGENCY_CONDITIONS.CONTRACT_SECURITY_ALERT, detectedAt: NOW, detail: 'proxy upgrade' },
        ],
      },
      config,
    );

    expect(report.action).toBe(RISK_ACTIONS.EMERGENCY);
    expect(report.recommendedState).toBe(BOT_STATES.EMERGENCY);
    expect(report.readOnly).toBe(true);
    expect(report.alertSeverity).toBe(ALERT_SEVERITIES.CRITICAL);
    // §57 still governs the depeg sub-verdict: the weekend 8% deviation may only alert.
    expect(report.hardExitPermitted).toBe(false);
    expect(report.peg?.action).toBe(RISK_ACTIONS.ALERT);
    expect(report.reasons.some((r) => r.startsWith(RISK_ACTIONS.EMERGENCY))).toBe(true);
  });

  it('never escalates a closed-market depeg to an exit, even as the worst standalone verdict', async () => {
    const config = await builtinConfig();
    const report = evaluateRisk(
      {
        asOf: NOW,
        peg: pegAssessment({
          deviation: 0.06,
          marketStatus: MARKET_STATUSES.CLOSED,
          hardExitAllowed: false,
        }),
      },
      config,
    );

    expect(report.action).not.toBe(RISK_ACTIONS.EMERGENCY_EXIT);
    expect(report.action).toBe(RISK_ACTIONS.ALERT);
    // The alarm must not be flattened to the base grade of ALERT — §57 caps the ACTION, not the
    // severity (§1: an operator must still be woken).
    expect(report.alertSeverity).toBe(ALERT_SEVERITIES.CRITICAL);
    expect(report.hardExitPermitted).toBe(false);
    expect(report.recommendedState).toBe(BOT_STATES.MONITOR);
    expect(report.readOnly).toBe(false);
  });

  it('takes the maximum alert severity across domains instead of the worst action base grade', async () => {
    const config = await builtinConfig();
    // Worst action is ALERT (base grade warning) but the reserve domain raised critical.
    const report = evaluateRisk(
      {
        asOf: NOW,
        reserveRatio: 0.1,
        range: { ...RANGE, currentPrice: 199 },
      },
      config,
    );
    expect(report.action).toBe(RISK_ACTIONS.NO_NEW_CAPITAL);
    expect(report.alertSeverity).toBe(ALERT_SEVERITIES.CRITICAL);
    expect(report.reserve?.alertSeverity).toBe(ALERT_SEVERITIES.CRITICAL);
  });

  it('reports missing domains instead of treating them as healthy, and holds safely', async () => {
    const config = await builtinConfig();
    const report = evaluateRisk({ asOf: NOW }, config);

    expect(report.missingInputs).toEqual([
      'peg',
      'drawdown',
      'tvlSeries',
      'reserveRatio',
      'range',
      'emergencyEvents',
      'marketDecline',
    ]);
    expect(report.action).toBe(RISK_ACTIONS.HOLD);
    expect(report.reasons).toHaveLength(1);
    expect(report.tokenDeviation).toBeNull();
    expect(report.totalNav).toBeNull();
  });

  it('classifies an in-range, on-peg portfolio as HOLD/MONITOR', async () => {
    const config = await builtinConfig();
    const report = evaluateRisk(
      {
        asOf: NOW,
        peg: pegAssessment({ deviation: 0.003 }),
        drawdown: drawdown({ currentNAV: 10_100 }),
        tvlSeries: tvlSeries(980_000),
        reserveRatio: 0.32,
        range: { ...RANGE, currentPrice: 150 },
        emergencyEvents: [],
        marketDecline: { stockPriceChange: 0.005, referenceNavChange: 0.005, tokenDeviation: 0.003, asOf: NOW },
      },
      config,
    );

    expect(report.action).toBe(RISK_ACTIONS.HOLD);
    expect(report.recommendedState).toBe(BOT_STATES.MONITOR);
    expect(report.readOnly).toBe(false);
    expect(report.noNewCapital).toBe(false);
  });

  it('keeps the §57 alert when a TVL verdict is fail-closed but not severe', async () => {
    const config = await builtinConfig();
    const report = evaluateRisk({ asOf: NOW, tvlSeries: [{ asOf: NOW, tvlUsd: 900_000 }] }, config);

    expect(report.tvl?.status).toBe('insufficient-data');
    expect(report.tvl?.failClosed).toBe(true);
    expect(report.action).toBe(RISK_ACTIONS.ALERT);
    expect(report.dataDegraded).toBe(true);
    expect(report.degradedDomains).toEqual(['tvl']);
  });

  it('flags a fully readable report as not degraded', async () => {
    const config = await builtinConfig();
    const report = evaluateRisk(
      {
        asOf: NOW,
        peg: pegAssessment({ deviation: 0.002 }),
        drawdown: drawdown({ currentNAV: 9_900 }),
        tvlSeries: tvlSeries(990_000),
        reserveRatio: 0.31,
        range: { ...RANGE, currentPrice: 150 },
        emergencyEvents: [],
        marketDecline: { stockPriceChange: 0.01, referenceNavChange: 0.01, tokenDeviation: 0.002, asOf: NOW },
      },
      config,
    );
    expect(report.dataDegraded).toBe(false);
    expect(report.degradedDomains).toEqual([]);
  });

  it('never reports a degraded HOLD as a clean bill of health', async () => {
    const config = await builtinConfig();
    const report = evaluateRisk(
      {
        asOf: NOW,
        peg: pegAssessment({ deviation: null }),
        drawdown: drawdown({ currentNAV: Number.NaN }),
        reserveRatio: 0.4,
        range: { ...RANGE, currentPrice: Number.NaN },
      },
      config,
    );
    expect(report.dataDegraded).toBe(true);
    expect(report.degradedDomains).toEqual(['peg', 'drawdown', 'range']);
    // The worst degraded domain is not a HOLD, so the bot does not act as if all is well.
    expect(report.action).not.toBe(RISK_ACTIONS.HOLD);
    expect(report.noNewCapital).toBe(true);
  });

  it('lets an emergency outrank a §53 market-decline HOLD', async () => {
    const config = await builtinConfig();
    const report = evaluateRisk(
      {
        asOf: NOW,
        marketDecline: {
          stockPriceChange: -0.09,
          referenceNavChange: -0.09,
          tokenDeviation: 0.003,
          asOf: NOW,
        },
        emergencyEvents: [
          {
            condition: EMERGENCY_CONDITIONS.ISSUER_REDEMPTION_SUSPENDED,
            detectedAt: NOW,
            detail: 'issuer halted redemptions',
          },
        ],
      },
      config,
    );
    expect(report.marketDecline?.action).toBe(RISK_ACTIONS.MARKET_RISK);
    expect(report.marketDecline?.hold).toBe(true);
    expect(report.action).toBe(RISK_ACTIONS.EMERGENCY);
    expect(report.recommendedState).toBe(BOT_STATES.EMERGENCY);
    expect(report.dataDegraded).toBe(false);
  });

  it('uses config thresholds end to end, not the schema defaults', async () => {
    const config = await builtinConfig();
    const tightened: StrategyConfig = {
      ...config,
      risk: { ...config.risk, pegWarning: 0.2 },
    };
    const report = evaluateRisk(
      { asOf: NOW, peg: pegAssessment({ deviation: 0.15 }) },
      tightened,
    );
    expect(report.peg?.level).toBe(PEG_LEVELS.NORMAL);
    expect(report.action).toBe(RISK_ACTIONS.HOLD);
  });
});

// -------------------------------------------------------------------------------------------
// Invariants that must hold for every verdict this module can return
// -------------------------------------------------------------------------------------------

describe('verdict invariants', () => {
  it('orders actions by the documented severity rank', () => {
    expect(RISK_ACTION_SEVERITY[RISK_ACTIONS.EMERGENCY_EXIT]).toBeGreaterThan(
      RISK_ACTION_SEVERITY[RISK_ACTIONS.EMERGENCY],
    );
    expect(RISK_ACTION_SEVERITY[RISK_ACTIONS.EMERGENCY]).toBeGreaterThan(
      RISK_ACTION_SEVERITY[RISK_ACTIONS.GLOBAL_RISK_OFF],
    );
    expect(RISK_ACTION_SEVERITY[RISK_ACTIONS.GLOBAL_RISK_OFF]).toBeGreaterThan(
      RISK_ACTION_SEVERITY[RISK_ACTIONS.EXIT_REVIEW],
    );
    expect(RISK_ACTION_SEVERITY[RISK_ACTIONS.EXIT_REVIEW]).toBeGreaterThan(
      RISK_ACTION_SEVERITY[RISK_ACTIONS.RISK_REVIEW],
    );
    expect(RISK_ACTION_SEVERITY[RISK_ACTIONS.HOLD]).toBe(0);

    const verdicts = [
      evaluatePegRisk(pegAssessment({ deviation: 0.015 }), RISK),
      evaluateDrawdown(drawdown({ currentNAV: 8_000 }), RISK),
      evaluateTvlCollapse(tvlSeries(100_000), RISK),
      evaluateReserve(0.1, RESERVE),
      evaluateRangeRisk({ ...RANGE, currentPrice: 300 }),
      evaluateEmergency([]),
      evaluateMarketDecline(
        { stockPriceChange: -0.1, referenceNavChange: -0.1, tokenDeviation: null, asOf: NOW },
        RISK,
      ),
    ];
    const rank: Readonly<Record<string, number>> = {
      [ALERT_SEVERITIES.INFO]: 0,
      [ALERT_SEVERITIES.WARNING]: 1,
      [ALERT_SEVERITIES.CRITICAL]: 2,
    };
    const rankOf = (severity: AlertSeverity): number => rank[severity] ?? 0;
    for (const verdict of verdicts) {
      expect(verdict.reason.length).toBeGreaterThan(0);
      // A verdict may escalate the alert for its own context, never quieten it.
      expect(rankOf(verdict.alertSeverity)).toBeGreaterThanOrEqual(rankOf(alertSeverityFor(verdict.action)));
      if (verdict.action !== RISK_ACTIONS.HOLD) {
        expect(rankOf(verdict.alertSeverity)).toBeGreaterThanOrEqual(rankOf(ALERT_SEVERITIES.WARNING));
      }
    }
  });

  it('marks every domain that can only alert as non-actionable downstream', () => {
    // §49 boundary watch and §60 below-target reserve must never look like an exit.
    expect(evaluateRangeRisk({ ...RANGE, currentPrice: 199 }).action).toBe(RISK_ACTIONS.BOUNDARY_WATCH);
    expect(evaluateReserve(0.28, RESERVE).action).toBe(RISK_ACTIONS.ALERT);
    // §57 blocks the position-closing path whenever the reference is closed, at any deviation.
    // Grades below the exit band carve out only capital (`NO_NEW_CAPITAL`) or nothing at all.
    for (const [deviation, expected] of [
      [0.051, RISK_ACTIONS.NO_NEW_CAPITAL],
      [0.081, RISK_ACTIONS.ALERT],
      [0.2, RISK_ACTIONS.ALERT],
      [1, RISK_ACTIONS.ALERT],
    ] as const) {
      const verdict = evaluatePegRisk(
        pegAssessment({ deviation, marketStatus: MARKET_STATUSES.HOLIDAY, hardExitAllowed: false }),
        RISK,
      );
      expect([RISK_ACTIONS.EXIT_REVIEW, RISK_ACTIONS.EMERGENCY_EXIT]).not.toContain(verdict.action);
      expect(verdict.hardExitPermitted).toBe(false);
      expect(verdict.action).toBe(expected);
    }
    // 3.1% on a holiday: below the §56-expanded stop-new-capital band (4%), so it is not even a
    // capital warning — but still never an exit.
    const mild = evaluatePegRisk(
      pegAssessment({ deviation: 0.031, marketStatus: MARKET_STATUSES.HOLIDAY, hardExitAllowed: false }),
      RISK,
    );
    expect(mild.level).toBe(PEG_LEVELS.WARNING);
    expect(mild.action).toBe(RISK_ACTIONS.ALERT);
  });

  it('exposes §44 states, not strings, for the state machine', async () => {
    const config = await builtinConfig();
    const report: RiskReport = evaluateRisk({ asOf: NOW, drawdown: drawdown({ currentNAV: 8_000 }) }, config);
    expect(report.recommendedState).toBe(BOT_STATES.GLOBAL_RISK_OFF);
    expect(new Set(Object.values(BOT_STATES)).has(report.recommendedState)).toBe(true);
  });
});
