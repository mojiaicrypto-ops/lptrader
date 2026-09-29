/**
 * §49-§67 risk assessment — depeg ladder, global drawdown line, TVL collapse, reserve floor,
 * out-of-range handling, boundary watch and the §58 emergency set.
 *
 * This module is deliberately PURE and TOTAL over market data: it reads nothing from the chain,
 * holds no state, and returns a *verdict plus a suggested action* for every question it is asked.
 * Inputs are the already-computed views (`PegAssessment`, `DrawdownState`, a TVL observation
 * series, a range, an explicit emergency-event set) and every *published* threshold comes from
 * `StrategyConfig` — no §55/§59/§60/§66 number is hardcoded in a branch. The only literal ratios
 * here are policy defaults the frozen config layer has no key for (§56's expansion factor, §49's
 * boundary band, §105's reserve warning floor); each is an exported constant with its rationale.
 *
 * Two rules shape almost every branch:
 *
 *   - **Fail closed (§96).** A missing or *unreadable* input is reported as `insufficient-data`,
 *     never as "healthy". A missing reference NAV can never authorise a hard exit; an unreadable
 *     NAV can never read as "the risk line is intact"; a TVL series with no 24h history can be
 *     declared neither collapsed nor safe.
 *   - **Risk First (§1).** The severity ordering below is the product's, not this file's: a global
 *     drawdown breach outranks a depeg review which outranks a boundary warning. `RiskAction` is
 *     a total order via `RISK_ACTION_SEVERITY`, so the composite verdict is deterministic.
 *
 * §56/§57 (the closed-market rule) are hard requirements, not advisory:
 *
 *   - While the US market is not OPEN the §55 bands are *expanded* (§56) so a stale Friday close
 *     cannot be graded against a 1% depeg tolerance — a Saturday 1.2% gap is not a depeg.
 *   - When there is no trustworthy alternative reference (`PegAssessment.hardExitAllowed === false`)
 *     a depeg may only ever *alert*. No amount of deviation produces a forced exit (§57 / V1).
 */

import { MARKET_STATUSES, PEG_LEVELS, type MarketStatus, type PegAssessment, type PegLevel } from '../types/adapters.ts';
import { DATA_SOURCES, type DataSource, type PoolSnapshot } from '../types/market.ts';
import { ALERT_SEVERITIES, type AlertSeverity } from '../types/notifier.ts';
import { BOT_STATES, NO_NEW_CAPITAL_STATES, READ_ONLY_STATES, type BotState } from '../types/state.ts';
import type { DrawdownState } from '../types/portfolio.ts';
import type { CapitalConfig, RiskConfig, StrategyConfig } from '../types/config.ts';
import type { IsoTimestamp, PriceUsd, Ratio, UsdAmount } from '../types/primitives.ts';

// ---------------------------------------------------------------------------------------------
// Actions & severity ordering
// ---------------------------------------------------------------------------------------------

/**
 * Every action this layer can recommend. These are *recommendations*: `riskManager` never sends a
 * transaction, and only two of them are exits (`EXIT_REVIEW` is a review gate, not an exit).
 */
export const RISK_ACTIONS = {
  /** Nothing to do; keep monitoring (§47). */
  HOLD: 'HOLD',
  /** Informational / degraded-data or warning-level notice. Never an exit (§57). */
  ALERT: 'ALERT',
  /** §49: inside the outer 20% band of the range. Alert only — never a trade decision (user ruling C3). */
  BOUNDARY_WATCH: 'BOUNDARY_WATCH',
  /** §53: a broad market decline. Default HOLD, explicitly *not* a sell. */
  MARKET_RISK: 'MARKET_RISK',
  /** §55 2%~3% / §60 reserve floor: no new capital may be committed. */
  NO_NEW_CAPITAL: 'NO_NEW_CAPITAL',
  /** §51/§59/§52: a human-visible review gate; the position is not touched automatically. */
  RISK_REVIEW: 'RISK_REVIEW',
  /** §50: price above the range and the LP has become stablecoin-heavy. Do not chase. */
  OUT_OF_RANGE_UP: 'OUT_OF_RANGE_UP',
  /** §55 3%~5%: the position is a candidate for exit after review, not an automatic exit. */
  EXIT_REVIEW: 'EXIT_REVIEW',
  /** §66: the global drawdown line is breached — §67's six actions apply. */
  GLOBAL_RISK_OFF: 'GLOBAL_RISK_OFF',
  /** §58: an emergency condition is active; the bot is read-only until an operator clears it. */
  EMERGENCY: 'EMERGENCY',
  /** §55 > 5% with a trustworthy reference: a depeg large enough to force an exit. */
  EMERGENCY_EXIT: 'EMERGENCY_EXIT',
} as const;
export type RiskAction = (typeof RISK_ACTIONS)[keyof typeof RISK_ACTIONS];

/**
 * Total order over actions, most severe last. Used to fold independent verdicts into one report.
 * The order is the product's risk priority (§1 `资金安全 > Token 正常 > Liquidity 正常 > ...`),
 * not an alphabetical or numeric accident — change it only with a product decision.
 */
export const RISK_ACTION_SEVERITY: Readonly<Record<RiskAction, number>> = {
  [RISK_ACTIONS.HOLD]: 0,
  [RISK_ACTIONS.ALERT]: 1,
  [RISK_ACTIONS.BOUNDARY_WATCH]: 2,
  [RISK_ACTIONS.MARKET_RISK]: 3,
  [RISK_ACTIONS.NO_NEW_CAPITAL]: 4,
  [RISK_ACTIONS.RISK_REVIEW]: 5,
  [RISK_ACTIONS.OUT_OF_RANGE_UP]: 6,
  [RISK_ACTIONS.EXIT_REVIEW]: 7,
  [RISK_ACTIONS.GLOBAL_RISK_OFF]: 8,
  [RISK_ACTIONS.EMERGENCY]: 9,
  [RISK_ACTIONS.EMERGENCY_EXIT]: 10,
};

/**
 * Ordering of §78 alert severities. A verdict or report may take a *max* over severities (§1 risk
 * priority) but must never quieten one, so this rank is the only way severities are combined.
 */
export const ALERT_SEVERITY_RANK: Readonly<Record<AlertSeverity, number>> = {
  [ALERT_SEVERITIES.INFO]: 0,
  [ALERT_SEVERITIES.WARNING]: 1,
  [ALERT_SEVERITIES.CRITICAL]: 2,
};

const SEVERITY_BY_ACTION: Readonly<Record<RiskAction, AlertSeverity>> = {
  [RISK_ACTIONS.HOLD]: ALERT_SEVERITIES.INFO,
  [RISK_ACTIONS.ALERT]: ALERT_SEVERITIES.WARNING,
  [RISK_ACTIONS.BOUNDARY_WATCH]: ALERT_SEVERITIES.INFO,
  [RISK_ACTIONS.MARKET_RISK]: ALERT_SEVERITIES.WARNING,
  [RISK_ACTIONS.NO_NEW_CAPITAL]: ALERT_SEVERITIES.WARNING,
  [RISK_ACTIONS.RISK_REVIEW]: ALERT_SEVERITIES.WARNING,
  [RISK_ACTIONS.OUT_OF_RANGE_UP]: ALERT_SEVERITIES.WARNING,
  [RISK_ACTIONS.EXIT_REVIEW]: ALERT_SEVERITIES.CRITICAL,
  [RISK_ACTIONS.GLOBAL_RISK_OFF]: ALERT_SEVERITIES.CRITICAL,
  [RISK_ACTIONS.EMERGENCY]: ALERT_SEVERITIES.CRITICAL,
  [RISK_ACTIONS.EMERGENCY_EXIT]: ALERT_SEVERITIES.CRITICAL,
};

/** Alert severity for an action's default grade. A verdict may escalate this for its own context
 *  (e.g. a reserve below the §105 floor is `critical` while the action stays `NO_NEW_CAPITAL`),
 *  but it must never be quieter than the base — `alertSeverityFor` is the floor, not the ceiling. */
export function alertSeverityFor(action: RiskAction): AlertSeverity {
  return SEVERITY_BY_ACTION[action];
}

// ---------------------------------------------------------------------------------------------
// Shared guards
// ---------------------------------------------------------------------------------------------

function isPositiveFinite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** Percentage rendering for `reason` strings, so an operator can read them without arithmetic. */
function pct(value: number, digits = 2): string {
  return `${(value * 100).toFixed(digits)}%`;
}

// ---------------------------------------------------------------------------------------------
// §54-§57 — depeg scale
// ---------------------------------------------------------------------------------------------

/** §56 policy knob: how much the §55 bands widen while the reference market is not OPEN. */
export const CLOSED_MARKET_THRESHOLD_EXPANSION = 2;

/** §55 bands actually applied, after any §56 expansion. */
export interface PegThresholds {
  readonly warning: Ratio;
  readonly stopNewCapital: Ratio;
  readonly exitReview: Ratio;
  readonly emergencyExit: Ratio;
}

/** The four §55 bands, read from config (never hardcoded). */
export function pegThresholdsFrom(risk: RiskConfig): PegThresholds {
  return {
    warning: risk.pegWarning,
    stopNewCapital: risk.stopNewPosition,
    exitReview: risk.exitReview,
    emergencyExit: risk.emergencyExit,
  };
}

/**
 * §54 `deviation = abs(onchainTokenPrice / referenceNAV - 1)`.
 *
 * Returns `null` — never `0` — when either price is unusable: a zero/negative/NaN reference is the
 * exact situation where a "no deviation" answer would be a lie, and downstream §57 handling keys
 * off `null`.
 */
export function computePegDeviation(
  onchainPrice: PriceUsd,
  referenceNav: PriceUsd,
): Ratio | null {
  if (!isPositiveFinite(onchainPrice) || !isPositiveFinite(referenceNav)) return null;
  return Math.abs(onchainPrice / referenceNav - 1);
}

/**
 * §55 ladder, applied verbatim to the bands:
 *
 * ```text
 * < 1%      NORMAL
 * 1% ~ 2%   WARNING
 * 2% ~ 3%   STOP_NEW_CAPITAL
 * 3% ~ 5%   EXIT_REVIEW
 * > 5%      EMERGENCY_EXIT
 * ```
 *
 * Each band is inclusive at its lower edge and exclusive at its upper edge, except the last
 * published bound: `3% ~ 5%` is inclusive at 5% and `> 5%` is strict, so a deviation of exactly
 * 5% is `EXIT_REVIEW` while 5% + ε is `EMERGENCY_EXIT`. Equality therefore always lands on the
 * *less* aggressive band, which is why §58/§107 also state the trigger as `> 5%`.
 */
export function classifyPegLevel(deviation: Ratio, thresholds: PegThresholds): PegLevel {
  if (!Number.isFinite(deviation) || deviation < 0) {
    throw new Error(`unusable peg deviation: ${String(deviation)}`);
  }
  if (deviation < thresholds.warning) return PEG_LEVELS.NORMAL;
  if (deviation < thresholds.stopNewCapital) return PEG_LEVELS.WARNING;
  if (deviation < thresholds.exitReview) return PEG_LEVELS.STOP_NEW_CAPITAL;
  if (deviation <= thresholds.emergencyExit) return PEG_LEVELS.EXIT_REVIEW;
  return PEG_LEVELS.EMERGENCY_EXIT;
}

/** The action a §55 level maps to when a hard exit is permitted. */
const PEG_LEVEL_ACTION: Readonly<Record<PegLevel, RiskAction>> = {
  [PEG_LEVELS.NORMAL]: RISK_ACTIONS.HOLD,
  [PEG_LEVELS.WARNING]: RISK_ACTIONS.ALERT,
  [PEG_LEVELS.STOP_NEW_CAPITAL]: RISK_ACTIONS.NO_NEW_CAPITAL,
  [PEG_LEVELS.EXIT_REVIEW]: RISK_ACTIONS.EXIT_REVIEW,
  [PEG_LEVELS.EMERGENCY_EXIT]: RISK_ACTIONS.EMERGENCY_EXIT,
};

/** §56 expansion multiplier for a market status: only a confirmed `OPEN` keeps the bands as configured. */
export function thresholdExpansionFor(status: MarketStatus, expansion = CLOSED_MARKET_THRESHOLD_EXPANSION): number {
  if (status === MARKET_STATUSES.OPEN) return 1;
  if (!Number.isFinite(expansion) || expansion < 1) {
    throw new Error(`unusable threshold expansion: ${String(expansion)}`);
  }
  return expansion;
}

export interface PegRiskOptions {
  /**
   * §56 override for how far the bands widen while the market is not OPEN (default 2). Set to `1`
   * to isolate the §57 rule from the §56 rule in tests.
   */
  readonly closedMarketThresholdExpansion?: number;
  /**
   * §57 override for `PegAssessment.hardExitAllowed`. Only ever used to *narrow* the exit
   * permission: a caller may pass `false` to suppress the hard exit, but never widen it beyond
   * what the assessment allowed (`true` is ignored when the assessment already says no).
   */
  readonly disallowHardExit?: boolean;
}

export interface PegRiskVerdict {
  /** §55 level after any §56 expansion; `null` when there is no usable reference at all. */
  readonly level: PegLevel | null;
  /** §55 level at the configured (unexpanded) bands — the operator-readable "raw" grade. */
  readonly rawLevel: PegLevel | null;
  readonly deviation: Ratio | null;
  readonly marketStatus: MarketStatus;
  readonly status: 'ok' | 'insufficient-data';
  /** §57: `true` only when a forced exit may actually be executed for this assessment. */
  readonly hardExitPermitted: boolean;
  readonly action: RiskAction;
  readonly alertSeverity: AlertSeverity;
  readonly thresholds: PegThresholds;
  readonly expanded: boolean;
  readonly reason: string;
}

function expandThresholds(thresholds: PegThresholds, factor: number): PegThresholds {
  if (factor === 1) return thresholds;
  return {
    warning: thresholds.warning * factor,
    stopNewCapital: thresholds.stopNewCapital * factor,
    exitReview: thresholds.exitReview * factor,
    emergencyExit: thresholds.emergencyExit * factor,
  };
}

/**
 * §55-§57 depeg verdict for one stock token.
 *
 * `assessment.hardExitAllowed` is the single source of truth for §57: when it is `false` (closed
 * market with no reliable alternative reference) the verdict may still *report* an emergency-grade
 * deviation, but its action is capped at `ALERT` and `hardExitPermitted` is `false`. That is the
 * "big depeg on a Saturday ⇒ phone alarm, no forced liquidation" behaviour, and it is asserted by
 * the test suite.
 */
export function evaluatePegRisk(
  assessment: PegAssessment,
  risk: RiskConfig,
  options: PegRiskOptions = {},
): PegRiskVerdict {
  const configured = pegThresholdsFrom(risk);
  const expansion = thresholdExpansionFor(
    assessment.marketStatus,
    options.closedMarketThresholdExpansion ?? CLOSED_MARKET_THRESHOLD_EXPANSION,
  );
  const applied = expandThresholds(configured, expansion);
  const expanded = expansion !== 1;

  // §57 permission: usable only when the assessment grants it AND the caller did not revoke it.
  const referenceUsable = assessment.hardExitAllowed && options.disallowHardExit !== true;

  const deviation = assessment.deviation;
  // An unreadable deviation is a data outage (or a source that lied about being usable) — treat it
  // exactly like a missing reference rather than throwing and stopping the monitor.
  if (deviation === null || !Number.isFinite(deviation) || deviation < 0) {
    const reason =
      `§57 no usable reference NAV/deviation for ${assessment.tokenId} (deviation=` +
      `${String(deviation)}, market=${assessment.marketStatus}, source=${assessment.reason}) — ` +
      `deviation unknowable, hard depeg exit disabled, alert only`;
    return {
      level: null,
      rawLevel: null,
      deviation: null,
      marketStatus: assessment.marketStatus,
      status: 'insufficient-data',
      hardExitPermitted: false,
      action: RISK_ACTIONS.ALERT,
      alertSeverity: ALERT_SEVERITIES.WARNING,
      thresholds: applied,
      expanded,
      reason,
    };
  }

  const level = classifyPegLevel(deviation, applied);
  const rawLevel = classifyPegLevel(deviation, configured);
  const action = PEG_LEVEL_ACTION[level];

  // §57 gate: while no trustworthy reference exists, *no* depeg grade may close the position —
  // neither `EXIT_REVIEW` nor a forced `EMERGENCY_EXIT`. Both collapse to a loud alert; grades
  // that only constrain new capital (`NO_NEW_CAPITAL` and below) never touch the position and
  // survive untouched. §56/§57 are hard requirements here, not advisory.
  const exitGrade = action === RISK_ACTIONS.EXIT_REVIEW || action === RISK_ACTIONS.EMERGENCY_EXIT;
  if (exitGrade && !referenceUsable) {
    const reason =
      `§57 depeg ${pct(deviation)} (level ${level}) but hard exit is disabled ` +
      `(market=${assessment.marketStatus}, hardExitAllowed=${String(assessment.hardExitAllowed)}) — ` +
      `critical alert only, NO forced exit; ${assessment.reason}`;
    return {
      level,
      rawLevel,
      deviation,
      marketStatus: assessment.marketStatus,
      status: 'ok',
      hardExitPermitted: false,
      action: RISK_ACTIONS.ALERT,
      alertSeverity: ALERT_SEVERITIES.CRITICAL,
      thresholds: applied,
      expanded,
      reason,
    };
  }

  const parts = [
    `§55 deviation=${pct(deviation)} → ${level}`,
    expanded
      ? `§56 market=${assessment.marketStatus}: bands expanded ×${expansion} ` +
        `(warning ${pct(applied.warning)}, exit ${pct(applied.exitReview)}, emergency ${pct(applied.emergencyExit)}); ` +
        `configured bands would grade ${rawLevel}`
      : `market=${assessment.marketStatus}`,
  ];
  if (action === RISK_ACTIONS.EMERGENCY_EXIT) {
    parts.push('hard exit permitted (trustworthy reference available)');
  }

  return {
    level,
    rawLevel,
    deviation,
    marketStatus: assessment.marketStatus,
    status: 'ok',
    // `hardExitPermitted` means "this verdict authorises a forced exit" — not merely "the
    // reference was usable" — so a consumer can never read a review grade as an exit order.
    hardExitPermitted: action === RISK_ACTIONS.EMERGENCY_EXIT,
    action,
    alertSeverity: alertSeverityFor(action),
    thresholds: applied,
    expanded,
    reason: parts.join('; '),
  };
}

// ---------------------------------------------------------------------------------------------
// §65-§67 — global drawdown
// ---------------------------------------------------------------------------------------------

/** §67's six actions, in baseline order. Emitted verbatim when the risk line is breached. */
export const GLOBAL_RISK_OFF_ACTIONS = [
  'STOP_NEW_POSITIONS',
  'STOP_ADDING_LIQUIDITY',
  'REMOVE_ACTIVE_LIQUIDITY',
  'COLLECT_FEES',
  'RECORD_ASSETS',
  'SEND_CRITICAL_ALERT',
] as const;
export type GlobalRiskOffAction = (typeof GLOBAL_RISK_OFF_ACTIONS)[number];

export interface DrawdownVerdict {
  /** `insufficient-data` ⇒ the NAV could not be read; never read that as "safe". */
  readonly status: 'ok' | 'insufficient-data';
  readonly breached: boolean;
  readonly initialNAV: UsdAmount;
  readonly currentNAV: UsdAmount;
  readonly peakNAV: UsdAmount;
  /** `initialNAV * (1 - maxDrawdown)` — §66's line, recomputed here from config. */
  readonly riskOffLineNAV: UsdAmount;
  readonly drawdownFromInitial: Ratio;
  readonly drawdownFromPeak: Ratio;
  /** §67's checklist; empty when the line is intact. */
  readonly requiredActions: readonly GlobalRiskOffAction[];
  readonly action: RiskAction;
  readonly alertSeverity: AlertSeverity;
  /** What `buildDrawdownState` (nav.ts) independently concluded; disagreement fails closed. */
  readonly stateFlaggedBreach: boolean;
  readonly reason: string;
}

/**
 * §65/§66 global drawdown line.
 *
 * `TotalNAV <= InitialNAV × (1 − max_drawdown)` ⇒ `GLOBAL_RISK_OFF`, and the comparison is
 * **inclusive**: with the §85 defaults (`InitialNAV = 10000`, `max_drawdown = 0.15`) a NAV of
 * exactly `$8500` breaches. The line is recomputed from config rather than trusted from the
 * snapshot, and the state's own `breached` flag is OR-ed in — two independent opinions that
 * disagree resolve to "breached" (§96 fail closed), never to "safe".
 *
 * An unreadable NAV (NaN / ±∞) is *not* a breach and *not* a pass: a `NaN` NAV makes every
 * comparison false, which is exactly how a broken read would otherwise be reported as "risk line
 * intact". It returns `insufficient-data` with `RISK_REVIEW` — no new capital, no automatic
 * liquidity removal, critical alert — so the operator sees it and nothing moves on bad data.
 */
export function evaluateDrawdown(state: DrawdownState, risk: RiskConfig): DrawdownVerdict {
  if (!Number.isFinite(risk.maxDrawdown) || risk.maxDrawdown <= 0 || risk.maxDrawdown >= 1) {
    throw new Error(`unusable maxDrawdown: ${String(risk.maxDrawdown)}`);
  }

  const usable = Number.isFinite(state.initialNAV) && Number.isFinite(state.currentNAV);
  if (!usable) {
    return {
      status: 'insufficient-data',
      breached: false,
      initialNAV: state.initialNAV,
      currentNAV: state.currentNAV,
      peakNAV: state.peakNAV,
      riskOffLineNAV: Number.NaN,
      drawdownFromInitial: Number.NaN,
      drawdownFromPeak: Number.NaN,
      requiredActions: [],
      action: RISK_ACTIONS.RISK_REVIEW,
      alertSeverity: ALERT_SEVERITIES.CRITICAL,
      stateFlaggedBreach: state.breached === true,
      reason:
        `§65 NAV unreadable (initialNAV=${String(state.initialNAV)}, currentNAV=${String(state.currentNAV)}) ` +
        `— drawdown line cannot be evaluated (fail closed: no new capital, no auto liquidity removal)`,
    };
  }

  const riskOffLineNAV = state.initialNAV * (1 - risk.maxDrawdown);
  const breached = state.currentNAV <= riskOffLineNAV || state.breached === true;
  const drawdownFromInitial =
    state.initialNAV > 0 ? 1 - state.currentNAV / state.initialNAV : 0;
  const drawdownFromPeak = state.peakNAV > 0 ? 1 - state.currentNAV / state.peakNAV : 0;

  const reason = breached
    ? `§66 GLOBAL_RISK_OFF: NAV $${state.currentNAV.toFixed(2)} <= risk line ` +
      `$${riskOffLineNAV.toFixed(2)} (initial $${state.initialNAV.toFixed(2)} × (1 − ${risk.maxDrawdown})) ` +
      `— drawdownFromInitial=${pct(drawdownFromInitial)}${
        state.breached && state.currentNAV > riskOffLineNAV ? ' (state flagged breach independently)' : ''
      }`
    : `§65 risk line intact: NAV $${state.currentNAV.toFixed(2)} > $${riskOffLineNAV.toFixed(2)} ` +
      `— drawdownFromInitial=${pct(drawdownFromInitial)} (limit ${pct(risk.maxDrawdown)})`;

  return {
    status: 'ok',
    breached,
    initialNAV: state.initialNAV,
    currentNAV: state.currentNAV,
    peakNAV: state.peakNAV,
    riskOffLineNAV,
    drawdownFromInitial,
    drawdownFromPeak,
    requiredActions: breached ? GLOBAL_RISK_OFF_ACTIONS : [],
    action: breached ? RISK_ACTIONS.GLOBAL_RISK_OFF : RISK_ACTIONS.HOLD,
    alertSeverity: breached ? ALERT_SEVERITIES.CRITICAL : ALERT_SEVERITIES.INFO,
    stateFlaggedBreach: state.breached === true,
    reason,
  };
}

// ---------------------------------------------------------------------------------------------
// §59 — TVL collapse
// ---------------------------------------------------------------------------------------------

/** One historical TVL reading. The series is what makes a 24h drop measurable at all. */
export interface TvlObservation {
  readonly asOf: IsoTimestamp;
  readonly tvlUsd: UsdAmount;
  /** Where the figure came from, for the audit trail (§59 is only as good as its source). */
  readonly source?: DataSource;
}

/**
 * Adapt `PoolSnapshot.tvlUSD` into a §59 observation — the wiring point for the pool scanner.
 *
 * A `stale` / `unavailable` / non-finite / negative figure yields `null`, which the caller records
 * as a *gap* rather than as a zero: a zero would read as a 100% collapse, and skipping the reading
 * entirely simply leaves the window short, which `evaluateTvlCollapse` already reports as
 * `insufficient-data` (fail closed).
 */
export function tvlObservationFrom(
  snapshot: Pick<PoolSnapshot, 'timestamp' | 'tvlUSD'>,
): TvlObservation | null {
  const { value, stale, source } = snapshot.tvlUSD;
  if (stale || source === DATA_SOURCES.UNAVAILABLE) return null;
  if (!Number.isFinite(value) || value < 0) return null;
  return { asOf: snapshot.timestamp, tvlUsd: value, source };
}

export interface TvlCollapseOptions {
  /** Look-back window for the drop; §59 states 24h. */
  readonly windowHours?: number;
}

export type TvlCollapseStatus = 'ok' | 'review' | 'emergency' | 'insufficient-data';

export interface TvlCollapseVerdict {
  readonly status: TvlCollapseStatus;
  readonly action: RiskAction;
  readonly alertSeverity: AlertSeverity;
  /** `(baseline - latest) / baseline`; `null` when the series cannot support the comparison. */
  readonly dropRatio: Ratio | null;
  readonly latestTvlUsd: UsdAmount | null;
  readonly baselineTvlUsd: UsdAmount | null;
  readonly baselineAsOf: IsoTimestamp | null;
  readonly windowHours: number;
  /** True when the verdict is `insufficient-data` — the caller must NOT read that as safe. */
  readonly failClosed: boolean;
  readonly reason: string;
}

/**
 * §59 TVL collapse: `24h Drop > 50% → RISK_REVIEW`, `> 70% → EMERGENCY`.
 *
 * Both bounds are **strict** (`>`), exactly as the baseline and §58 write them, so a drop of
 * exactly 50% is `ok` and exactly 70% is `review`; the configured thresholds carry the same
 * semantics.
 *
 * With no observation at least one window old there is nothing to compare against, so the verdict
 * is `insufficient-data` with `failClosed: true` — a fresh process with one TVL reading must never
 * be told "no collapse". Note that the caller still does not act on it (action `ALERT`), which
 * keeps the bot running while it accumulates the first 24h of history.
 */
export function evaluateTvlCollapse(
  series: readonly TvlObservation[],
  risk: RiskConfig,
  options: TvlCollapseOptions = {},
): TvlCollapseVerdict {
  const windowHours = options.windowHours ?? 24;
  if (!Number.isFinite(windowHours) || windowHours <= 0) {
    throw new Error(`unusable TVL window: ${String(windowHours)}`);
  }

  const usable = series
    .filter((o) => Number.isFinite(o.tvlUsd) && Number.isFinite(Date.parse(o.asOf)))
    .slice()
    .sort((a, b) => Date.parse(a.asOf) - Date.parse(b.asOf));

  if (usable.length === 0) {
    return {
      status: 'insufficient-data',
      action: RISK_ACTIONS.ALERT,
      alertSeverity: ALERT_SEVERITIES.WARNING,
      dropRatio: null,
      latestTvlUsd: null,
      baselineTvlUsd: null,
      baselineAsOf: null,
      windowHours,
      failClosed: true,
      reason: `§59 no usable TVL observation — collapse status unknowable (fail closed, not "safe")`,
    };
  }

  const latest = usable[usable.length - 1];
  if (latest === undefined) {
    // Unreachable: `usable.length > 0` was just checked. Kept for `noUncheckedIndexedAccess`.
    throw new Error('unreachable: empty TVL series after length check');
  }

  const cutoff = Date.parse(latest.asOf) - windowHours * 3_600_000;
  const baseline = [...usable].filter((o) => Date.parse(o.asOf) <= cutoff).pop();

  if (baseline === undefined) {
    return {
      status: 'insufficient-data',
      action: RISK_ACTIONS.ALERT,
      alertSeverity: ALERT_SEVERITIES.WARNING,
      dropRatio: null,
      latestTvlUsd: latest.tvlUsd,
      baselineTvlUsd: null,
      baselineAsOf: null,
      windowHours,
      failClosed: true,
      reason:
        `§59 TVL series covers less than ${windowHours}h (oldest ${usable[0]?.asOf ?? 'n/a'}, ` +
        `latest ${latest.asOf}) — 24h drop unknowable (fail closed, not "safe")`,
    };
  }

  if (!(baseline.tvlUsd > 0)) {
    return {
      status: 'insufficient-data',
      action: RISK_ACTIONS.ALERT,
      alertSeverity: ALERT_SEVERITIES.WARNING,
      dropRatio: null,
      latestTvlUsd: latest.tvlUsd,
      baselineTvlUsd: baseline.tvlUsd,
      baselineAsOf: baseline.asOf,
      windowHours,
      failClosed: true,
      reason:
        `§59 baseline TVL $${String(baseline.tvlUsd)} is not a usable denominator ` +
        `(asOf ${baseline.asOf}) — drop unknowable (fail closed)`,
    };
  }

  const dropRatio = (baseline.tvlUsd - latest.tvlUsd) / baseline.tvlUsd;

  let status: TvlCollapseStatus = 'ok';
  let action: RiskAction = RISK_ACTIONS.HOLD;
  if (dropRatio > risk.tvlDropEmergency) {
    status = 'emergency';
    action = RISK_ACTIONS.EMERGENCY;
  } else if (dropRatio > risk.tvlDropReview) {
    status = 'review';
    action = RISK_ACTIONS.RISK_REVIEW;
  }

  return {
    status,
    action,
    alertSeverity: alertSeverityFor(action),
    dropRatio,
    latestTvlUsd: latest.tvlUsd,
    baselineTvlUsd: baseline.tvlUsd,
    baselineAsOf: baseline.asOf,
    windowHours,
    failClosed: false,
    reason:
      `§59 TVL ${windowHours}h drop ${pct(dropRatio)} ` +
      `($${baseline.tvlUsd.toFixed(2)} @ ${baseline.asOf} → $${latest.tvlUsd.toFixed(2)} @ ${latest.asOf}) ` +
      `→ ${status} (review > ${pct(risk.tvlDropReview)}, emergency > ${pct(risk.tvlDropEmergency)}; ` +
      `both strict)`,
  };
}

// ---------------------------------------------------------------------------------------------
// §60 / §104-§105 — reserve ratio
// ---------------------------------------------------------------------------------------------

/** §105's reserve band has no config key, so it travels as an explicit, documented default. */
export const DEFAULT_RESERVE_WARNING_RATIO = 0.2;

export interface ReserveThresholds {
  /** §60 `Reserve < 25%` ⇒ no new LP. From `StrategyConfig.risk.minReserveBeforeNewLp`. */
  readonly minReserveBeforeNewLp: Ratio;
  /** §3/§104 target reserve share. From `StrategyConfig.capital.reserveRatio` (0.30). */
  readonly targetReserve: Ratio;
  /** §105 warning floor. */
  readonly warningReserve: Ratio;
}

/** The exact config fields §60 reads (narrow, so a test never has to build a whole config). */
export interface ReserveConfigInput {
  readonly risk: Pick<RiskConfig, 'minReserveBeforeNewLp'>;
  readonly capital: Pick<CapitalConfig, 'reserveRatio'>;
}

export function reserveThresholdsFrom(config: ReserveConfigInput): ReserveThresholds {
  return {
    minReserveBeforeNewLp: config.risk.minReserveBeforeNewLp,
    targetReserve: config.capital.reserveRatio,
    warningReserve: DEFAULT_RESERVE_WARNING_RATIO,
  };
}

export interface ReserveVerdict {
  /** `insufficient-data` ⇒ the reserve ratio could not be read; new capital is refused. */
  readonly status: 'ok' | 'insufficient-data';
  readonly reserveRatio: Ratio;
  /** §60: `< minReserveBeforeNewLp` — the caller must refuse to open or add LP. */
  readonly newLpBlocked: boolean;
  /** §60: never implies a forced rebalance; it only stops new capital. */
  readonly forceRebalance: false;
  readonly action: RiskAction;
  readonly alertSeverity: AlertSeverity;
  readonly reason: string;
}

/**
 * §60 reserve monitoring.
 *
 * `>= 30%` is normal (natural drift is tolerated), `25% ~ 30%` is still allowed to add LP but is
 * below target, and `< 25%` blocks new LP. §105 puts `20% ~ 25%` at warning level, so below 20%
 * is critical. Boundary semantics: exactly 25% is *allowed* (the rule is `< 25%`), exactly 30% is
 * normal, exactly 20% is still warning — a lower-inclusive band on each edge.
 *
 * An unreadable ratio fails closed: no new LP, critical alert, still no forced rebalance (the
 * §60 rule constrains capital, never the existing position).
 */
export function evaluateReserve(
  reserveRatio: Ratio,
  thresholds: ReserveThresholds,
): ReserveVerdict {
  if (!Number.isFinite(reserveRatio)) {
    return {
      status: 'insufficient-data',
      reserveRatio,
      newLpBlocked: true,
      forceRebalance: false,
      action: RISK_ACTIONS.NO_NEW_CAPITAL,
      alertSeverity: ALERT_SEVERITIES.CRITICAL,
      reason:
        `§60 reserve ratio unreadable (${String(reserveRatio)}) — new LP prohibited until the ` +
        `ratio is known (fail closed; no forced rebalance)`,
    };
  }

  const newLpBlocked = reserveRatio < thresholds.minReserveBeforeNewLp;

  if (newLpBlocked) {
    const critical = reserveRatio < thresholds.warningReserve;
    return {
      status: 'ok',
      reserveRatio,
      newLpBlocked: true,
      forceRebalance: false,
      action: RISK_ACTIONS.NO_NEW_CAPITAL,
      alertSeverity: critical ? ALERT_SEVERITIES.CRITICAL : ALERT_SEVERITIES.WARNING,
      reason:
        `§60 reserve ${pct(reserveRatio)} < ${pct(thresholds.minReserveBeforeNewLp)} — ` +
        `new LP prohibited (no forced rebalance)` +
        (critical ? `; §105 below the ${pct(thresholds.warningReserve)} warning floor` : ''),
    };
  }

  if (reserveRatio < thresholds.targetReserve) {
    return {
      status: 'ok',
      reserveRatio,
      newLpBlocked: false,
      forceRebalance: false,
      action: RISK_ACTIONS.ALERT,
      alertSeverity: ALERT_SEVERITIES.WARNING,
      reason:
        `§60 reserve ${pct(reserveRatio)} is between ${pct(thresholds.minReserveBeforeNewLp)} and the ` +
        `${pct(thresholds.targetReserve)} target — new LP still allowed, natural drift tolerated`,
    };
  }

  return {
    status: 'ok',
    reserveRatio,
    newLpBlocked: false,
    forceRebalance: false,
    action: RISK_ACTIONS.HOLD,
    alertSeverity: ALERT_SEVERITIES.INFO,
    reason: `§60 reserve ${pct(reserveRatio)} >= ${pct(thresholds.targetReserve)} — normal`,
  };
}

// ---------------------------------------------------------------------------------------------
// §49-§52 — range position, boundary watch, out-of-range
// ---------------------------------------------------------------------------------------------

/** §49's boundary band. Not configurable in §85; exposed so callers can pin it explicitly. */
export const DEFAULT_BOUNDARY_BAND = { lower: 0.2, upper: 0.8 } as const;

export interface RangeBounds {
  readonly currentPrice: PriceUsd;
  readonly lowerPrice: PriceUsd;
  readonly upperPrice: PriceUsd;
}

export interface RangeRiskOptions {
  readonly band?: { readonly lower: number; readonly upper: number };
}

export type RangePositionStatus = 'none' | 'up' | 'down';

/** §50's four follow-ups, in baseline order. */
export const OUT_OF_RANGE_UP_FOLLOW_UPS = [
  'DO_NOT_CHASE_UP',
  'RECORD_POSITION',
  'WAIT_FOR_STABILIZATION',
  'RERUN_POOL_SCANNER',
] as const;
export type OutOfRangeUpFollowUp = (typeof OUT_OF_RANGE_UP_FOLLOW_UPS)[number];

/** §52's review checklist for the lower-bound case. */
export const LOWER_RANGE_REVIEW_CHECKS = [
  'UNDERLYING_STOCK_TREND',
  'TOKEN_NAV_DEVIATION',
  'ISSUER_STATUS',
  'REDEMPTION_STATUS',
  'POOL_TVL',
  'ONCHAIN_LIQUIDITY',
] as const;
export type LowerRangeReviewCheck = (typeof LOWER_RANGE_REVIEW_CHECKS)[number];

export interface RangeRiskVerdict {
  /** `insufficient-data` ⇒ a price could not be read; the position state is unknown. */
  readonly status: 'ok' | 'insufficient-data';
  readonly action: RiskAction;
  readonly outOfRange: RangePositionStatus;
  readonly boundaryWatch: boolean;
  /** §49 `(Current − Lower) / (Upper − Lower)`. */
  readonly rangeProgress: Ratio;
  readonly alertSeverity: AlertSeverity;
  readonly followUps: readonly OutOfRangeUpFollowUp[];
  readonly reviewChecks: readonly LowerRangeReviewCheck[];
  /** §50 suggests 12-24h of waiting before re-evaluating; `null` when in range. */
  readonly waitHours: { readonly min: number; readonly max: number } | null;
  readonly rescanRequired: boolean;
  /** §51: the lower-bound path never sells automatically. */
  readonly noAutoSell: boolean;
  /** §49: `BOUNDARY_WATCH` never participates in a trade decision (user ruling C3). */
  readonly alertOnly: boolean;
  readonly reason: string;
}

/**
 * §49-§52 range classification.
 *
 * Ordering matters: the out-of-range tests come first because they are *state*, not a warning —
 * being above the range means the LP is already effectively stablecoin, and the baseline forbids
 * chasing that move (§50.1). Only then is the §49 progress band evaluated.
 *
 * Boundary semantics follow the baseline's own operators: `price >= upper` and `price <= lower`
 * are inclusive, and `> 0.80` / `< 0.20` are strict, so exactly-0.80 progress is not a watch.
 *
 * `lowerPrice >= upperPrice` is a programming error (the range comes from `PositionPlan`, which
 * guarantees `lower < upper`) *and* nonsense as a market reading — it throws rather than being
 * silently mapped onto a risk verdict an operator might mistake for real. An unreadable price is
 * different: it is a data outage, so it fails closed with `insufficient-data`.
 */
export function evaluateRangeRisk(bounds: RangeBounds, options: RangeRiskOptions = {}): RangeRiskVerdict {
  const { currentPrice, lowerPrice, upperPrice } = bounds;

  if (!Number.isFinite(currentPrice) || !Number.isFinite(lowerPrice) || !Number.isFinite(upperPrice)) {
    return {
      status: 'insufficient-data',
      action: RISK_ACTIONS.RISK_REVIEW,
      outOfRange: 'none',
      boundaryWatch: false,
      rangeProgress: Number.NaN,
      alertSeverity: ALERT_SEVERITIES.CRITICAL,
      followUps: [],
      reviewChecks: [],
      waitHours: null,
      rescanRequired: false,
      noAutoSell: true,
      alertOnly: false,
      reason:
        `§49 range state unknowable (current=${String(currentPrice)} lower=${String(lowerPrice)} ` +
        `upper=${String(upperPrice)}) — RISK_REVIEW, no automatic position change`,
    };
  }

  if (!(upperPrice > lowerPrice)) {
    throw new Error(
      `inverted range: lower=${lowerPrice} upper=${upperPrice} (expected lower < upper)`,
    );
  }

  const band = options.band ?? DEFAULT_BOUNDARY_BAND;
  const rangeProgress = (currentPrice - lowerPrice) / (upperPrice - lowerPrice);

  if (currentPrice >= upperPrice) {
    return {
      status: 'ok',
      action: RISK_ACTIONS.OUT_OF_RANGE_UP,
      outOfRange: 'up',
      boundaryWatch: false,
      rangeProgress,
      alertSeverity: ALERT_SEVERITIES.WARNING,
      followUps: OUT_OF_RANGE_UP_FOLLOW_UPS,
      reviewChecks: [],
      waitHours: { min: 12, max: 24 },
      rescanRequired: true,
      noAutoSell: false,
      alertOnly: false,
      reason:
        `§50 price ${currentPrice} >= upper ${upperPrice} (progress ${pct(rangeProgress)}) — ` +
        `OUT_OF_RANGE_UP: the LP is stablecoin-heavy; do NOT chase up, record the position, ` +
        `wait 12-24h for stabilisation and re-run the pool scanner`,
    };
  }

  if (currentPrice <= lowerPrice) {
    return {
      status: 'ok',
      action: RISK_ACTIONS.RISK_REVIEW,
      outOfRange: 'down',
      boundaryWatch: false,
      rangeProgress,
      alertSeverity: ALERT_SEVERITIES.WARNING,
      followUps: [],
      reviewChecks: LOWER_RANGE_REVIEW_CHECKS,
      waitHours: null,
      rescanRequired: false,
      noAutoSell: true,
      alertOnly: false,
      reason:
        `§51 price ${currentPrice} <= lower ${lowerPrice} (progress ${pct(rangeProgress)}) — ` +
        `RISK_REVIEW: the LP is stock-token-heavy; §52 review required, NO automatic sell`,
    };
  }

  const boundaryWatch = rangeProgress > band.upper || rangeProgress < band.lower;
  if (boundaryWatch) {
    return {
      status: 'ok',
      action: RISK_ACTIONS.BOUNDARY_WATCH,
      outOfRange: 'none',
      boundaryWatch: true,
      rangeProgress,
      alertSeverity: ALERT_SEVERITIES.INFO,
      followUps: [],
      reviewChecks: [],
      waitHours: null,
      rescanRequired: false,
      noAutoSell: false,
      alertOnly: true,
      reason:
        `§49 rangeProgress ${pct(rangeProgress)} outside [${pct(band.lower)}, ${pct(band.upper)}] ` +
        `— BOUNDARY_WATCH: alert only, never a trade decision (no mid-range rebalance, §48)`,
    };
  }

  return {
    status: 'ok',
    action: RISK_ACTIONS.HOLD,
    outOfRange: 'none',
    boundaryWatch: false,
    rangeProgress,
    alertSeverity: ALERT_SEVERITIES.INFO,
    followUps: [],
    reviewChecks: [],
    waitHours: null,
    rescanRequired: false,
    noAutoSell: false,
    alertOnly: false,
    reason:
      `§49 rangeProgress ${pct(rangeProgress)} inside [${pct(band.lower)}, ${pct(band.upper)}] ` +
      `(price ${currentPrice} in [${lowerPrice}, ${upperPrice}]) — in range`,
  };
}

// ---------------------------------------------------------------------------------------------
// §58 — emergency conditions
// ---------------------------------------------------------------------------------------------

/**
 * §58's emergency list. The baseline writes nine lines (the assignment's "8 类" counts the TVL
 * drop separately, since §59 also owns it); all nine are represented here so an operator event can
 * never be silently dropped for lack of a code.
 */
export const EMERGENCY_CONDITIONS = {
  TOKEN_CONTRACT_PAUSED: 'TOKEN_CONTRACT_PAUSED',
  ISSUER_REDEMPTION_SUSPENDED: 'ISSUER_REDEMPTION_SUSPENDED',
  DEX_POOL_LIQUIDITY_COLLAPSE: 'DEX_POOL_LIQUIDITY_COLLAPSE',
  TVL_DROP_OVER_50PCT: 'TVL_DROP_OVER_50PCT',
  UNEXPECTED_CONTRACT_UPGRADE: 'UNEXPECTED_CONTRACT_UPGRADE',
  STABLECOIN_DEPEG: 'STABLECOIN_DEPEG',
  STOCK_TOKEN_DEPEG_OVER_5PCT: 'STOCK_TOKEN_DEPEG_OVER_5PCT',
  ORACLE_FAILURE: 'ORACLE_FAILURE',
  CONTRACT_SECURITY_ALERT: 'CONTRACT_SECURITY_ALERT',
} as const;
export type EmergencyCondition = (typeof EMERGENCY_CONDITIONS)[keyof typeof EMERGENCY_CONDITIONS];

/**
 * One detected emergency condition.
 *
 * These are never *inferred* from numbers in this file: a caller (chain watcher, issuer status
 * feed, oracle health probe, TVL monitor or the operator) must assert the condition explicitly and
 * say what it saw. Guessing an emergency from a side-effect would either miss a real one or stop
 * the strategy on a data glitch.
 */
export interface EmergencyEvent {
  readonly condition: EmergencyCondition;
  readonly detectedAt: IsoTimestamp;
  readonly detail: string;
  /** Optional provenance for the audit trail (`DecisionLog.detail`, §77). */
  readonly source?: string;
  readonly evidence?: Readonly<Record<string, unknown>>;
}

export interface EmergencyVerdict {
  readonly active: boolean;
  readonly conditions: readonly EmergencyCondition[];
  readonly events: readonly EmergencyEvent[];
  readonly action: RiskAction;
  readonly alertSeverity: AlertSeverity;
  /** §58/§44: the bot is read-only in `EMERGENCY`; no transaction may be sent. */
  readonly readOnly: true;
  readonly noNewCapital: true;
  readonly requiresManualClear: true;
  readonly reason: string;
}

/**
 * §58 emergency evaluation over an explicit event set.
 *
 * A single matching event is enough: the list is a set of *sufficient* conditions, and each one
 * independently puts the bot in `EMERGENCY` (§44), which is read-only until an operator clears it.
 * Duplicate conditions are collapsed but every event is preserved for the audit log.
 */
export function evaluateEmergency(events: readonly EmergencyEvent[]): EmergencyVerdict {
  const known = new Set<string>(Object.values(EMERGENCY_CONDITIONS));
  const unknown = events.filter((e) => !known.has(e.condition));

  const active = events.length > 0;
  const conditions = [...new Set(events.map((e) => e.condition))];
  const detailLines = events.map((e) => `${e.condition}: ${e.detail} (${e.detectedAt})`);

  if (!active) {
    return {
      active: false,
      conditions: [],
      events: [],
      action: RISK_ACTIONS.HOLD,
      alertSeverity: ALERT_SEVERITIES.INFO,
      readOnly: true,
      noNewCapital: true,
      requiresManualClear: true,
      reason: '§58 no emergency condition asserted',
    };
  }

  return {
    active: true,
    conditions,
    events,
    action: RISK_ACTIONS.EMERGENCY,
    alertSeverity: ALERT_SEVERITIES.CRITICAL,
    readOnly: true,
    noNewCapital: true,
    requiresManualClear: true,
    reason:
      `§58 EMERGENCY from ${conditions.length} condition(s): ${conditions.join(', ')} — ` +
      `${detailLines.join(' | ')}` +
      (unknown.length > 0 ? `; unrecognised codes preserved: ${unknown.map((e) => e.condition).join(', ')}` : ''),
  };
}

// ---------------------------------------------------------------------------------------------
// §53 — ordinary market decline
// ---------------------------------------------------------------------------------------------

export interface MarketDeclineInput {
  /** Signed relative change of the stock token price over the window, e.g. `-0.08`. */
  readonly stockPriceChange: Ratio | null;
  /** Signed relative change of the underlying reference NAV over the same window. */
  readonly referenceNavChange: Ratio | null;
  /** Current §54 token/NAV deviation, when a reference NAV is available. */
  readonly tokenDeviation: Ratio | null;
  readonly asOf: IsoTimestamp;
}

export interface MarketDeclineVerdict {
  readonly action: RiskAction;
  readonly status: 'ok' | 'insufficient-data';
  readonly marketDecline: boolean;
  /** §53's default is HOLD: a broad decline is not a reason to sell. */
  readonly hold: boolean;
  readonly alertSeverity: AlertSeverity;
  readonly reason: string;
}

/**
 * §53 ordinary market decline:
 *
 * ```text
 * Stock Token Price ↓ 且 Underlying NAV 同步 ↓ 且 Token/NAV 正常 → MARKET_RISK，默认 HOLD
 * ```
 *
 * All three legs must hold. If the reference NAV did *not* follow the price down while the token
 * still tracks NAV, the move is unexplained and escalates to `RISK_REVIEW`; if the token is
 * already deviating, §53 does not apply at all and the §55 ladder owns the decision.
 *
 * A missing change figure is `insufficient-data` (never "no decline"), though the recommended
 * action is still `HOLD` — doing nothing is the safe response to an unreadable market.
 */
export function evaluateMarketDecline(
  input: MarketDeclineInput,
  risk: RiskConfig,
): MarketDeclineVerdict {
  const { stockPriceChange, referenceNavChange, tokenDeviation } = input;

  if (stockPriceChange === null || !Number.isFinite(stockPriceChange)) {
    return {
      action: RISK_ACTIONS.HOLD,
      status: 'insufficient-data',
      marketDecline: false,
      hold: true,
      alertSeverity: ALERT_SEVERITIES.WARNING,
      reason: `§53 stock price change unavailable (${String(stockPriceChange)}) — decline status unknowable, HOLD`,
    };
  }

  if (stockPriceChange >= 0) {
    return {
      action: RISK_ACTIONS.HOLD,
      status: 'ok',
      marketDecline: false,
      hold: true,
      alertSeverity: ALERT_SEVERITIES.INFO,
      reason: `§53 stock price change ${pct(stockPriceChange)} is not a decline — ${
        tokenDeviation === null ? 'no deviation signal' : `deviation ${pct(tokenDeviation)}`
      }`,
    };
  }

  // §53's third leg: without a deviation reading we cannot confirm "Token/NAV 正常", and we also
  // cannot rule out that this *is* a depeg — so we neither sell nor call it an ordinary decline.
  if (tokenDeviation === null || !Number.isFinite(tokenDeviation)) {
    return {
      action: RISK_ACTIONS.HOLD,
      status: 'insufficient-data',
      marketDecline: true,
      hold: true,
      alertSeverity: ALERT_SEVERITIES.WARNING,
      reason:
        `§53 price ${pct(stockPriceChange)} fell but token/NAV deviation is unavailable ` +
        `(${String(tokenDeviation)}) — cannot confirm this is an ordinary market decline, HOLD`,
    };
  }

  // A depeg takes precedence over the §53 market path.
  if (tokenDeviation >= risk.pegWarning) {
    return {
      action: RISK_ACTIONS.RISK_REVIEW,
      status: 'ok',
      marketDecline: true,
      hold: false,
      alertSeverity: ALERT_SEVERITIES.WARNING,
      reason:
        `§53 does not apply: price ${pct(stockPriceChange)} down but token/NAV deviation ` +
        `${pct(tokenDeviation)} >= ${pct(risk.pegWarning)} — this is a §54 depeg, not a market decline`,
    };
  }

  if (referenceNavChange === null || !Number.isFinite(referenceNavChange)) {
    return {
      action: RISK_ACTIONS.HOLD,
      status: 'insufficient-data',
      marketDecline: true,
      hold: true,
      alertSeverity: ALERT_SEVERITIES.WARNING,
      reason:
        `§53 price ${pct(stockPriceChange)} down but reference NAV change unavailable ` +
        `(${String(referenceNavChange)}) — cannot confirm the decline is market-wide, HOLD`,
    };
  }

  if (referenceNavChange < 0) {
    return {
      action: RISK_ACTIONS.MARKET_RISK,
      status: 'ok',
      marketDecline: true,
      hold: true,
      alertSeverity: ALERT_SEVERITIES.WARNING,
      reason:
        `§53 market decline: stock price ${pct(stockPriceChange)} and reference NAV ` +
        `${pct(referenceNavChange)} fell together, token/NAV deviation ${pct(tokenDeviation)} ` +
        `is normal — MARKET_RISK, default HOLD (no sell)`,
    };
  }

  return {
    action: RISK_ACTIONS.RISK_REVIEW,
    status: 'ok',
    marketDecline: true,
    hold: false,
    alertSeverity: ALERT_SEVERITIES.WARNING,
    reason:
      `§53 stock price ${pct(stockPriceChange)} fell while reference NAV ${pct(referenceNavChange)} ` +
      `did not follow — divergence is unexplained, RISK_REVIEW (§52 checklist)`,
  };
}

// ---------------------------------------------------------------------------------------------
// Composite
// ---------------------------------------------------------------------------------------------

export interface RiskInput {
  readonly asOf: IsoTimestamp;
  readonly peg?: PegAssessment | null;
  readonly drawdown?: DrawdownState | null;
  readonly tvlSeries?: readonly TvlObservation[] | null;
  readonly reserveRatio?: Ratio | null;
  readonly range?: RangeBounds | null;
  readonly emergencyEvents?: readonly EmergencyEvent[] | null;
  readonly marketDecline?: MarketDeclineInput | null;
}

export interface RiskReport {
  readonly asOf: IsoTimestamp;
  /** The single most severe action across every domain evaluated. */
  readonly action: RiskAction;
  readonly alertSeverity: AlertSeverity;
  /** §44 state this report suggests; advisory — the state machine owns the transition (§96). */
  readonly recommendedState: BotState;
  /** §44 `READ_ONLY_STATES` membership for `recommendedState`. */
  readonly readOnly: boolean;
  /** §44 `NO_NEW_CAPITAL_STATES` membership for `recommendedState`. */
  readonly noNewCapital: boolean;
  readonly hardExitPermitted: boolean;
  /** Human-readable reasons, most severe first — ready for `DecisionLog.reason` (§77). */
  readonly reasons: readonly string[];
  /** Domains that were not supplied at all (informational; absent ≠ healthy). */
  readonly missingInputs: readonly string[];
  /**
   * §96: domains that WERE supplied but could not be evaluated (unreadable NAV, no reference NAV,
   * a TVL series too short for a 24h comparison). `true` ⇒ the report is incomplete, so the caller
   * must not treat a `HOLD` as a clean bill of health.
   */
  readonly dataDegraded: boolean;
  readonly degradedDomains: readonly string[];
  readonly peg: PegRiskVerdict | null;
  readonly drawdown: DrawdownVerdict | null;
  readonly tvl: TvlCollapseVerdict | null;
  readonly reserve: ReserveVerdict | null;
  readonly range: RangeRiskVerdict | null;
  readonly emergency: EmergencyVerdict | null;
  readonly marketDecline: MarketDeclineVerdict | null;
  /** §54 deviation for `DecisionLog.tokenDeviation`. */
  readonly tokenDeviation: Ratio | null;
  /** §5 NAV for `DecisionLog.totalNAV`. */
  readonly totalNav: UsdAmount | null;
  /** Suggested actions for the downstream executor, derived from the verdicts above. */
  readonly suggestedActions: readonly string[];
}

const ACTION_TO_STATE: Readonly<Record<RiskAction, BotState>> = {
  [RISK_ACTIONS.HOLD]: BOT_STATES.MONITOR,
  [RISK_ACTIONS.ALERT]: BOT_STATES.MONITOR,
  [RISK_ACTIONS.BOUNDARY_WATCH]: BOT_STATES.MONITOR,
  [RISK_ACTIONS.MARKET_RISK]: BOT_STATES.MONITOR,
  [RISK_ACTIONS.NO_NEW_CAPITAL]: BOT_STATES.MONITOR,
  [RISK_ACTIONS.RISK_REVIEW]: BOT_STATES.RISK_REVIEW,
  [RISK_ACTIONS.OUT_OF_RANGE_UP]: BOT_STATES.OUT_OF_RANGE,
  [RISK_ACTIONS.EXIT_REVIEW]: BOT_STATES.RISK_REVIEW,
  [RISK_ACTIONS.GLOBAL_RISK_OFF]: BOT_STATES.GLOBAL_RISK_OFF,
  [RISK_ACTIONS.EMERGENCY]: BOT_STATES.EMERGENCY,
  [RISK_ACTIONS.EMERGENCY_EXIT]: BOT_STATES.EXIT_POSITION,
};

/**
 * Evaluate every risk domain that has data and fold them into one report.
 *
 * The domains are independent by design — a TVL collapse and a depeg are detected by different
 * feeds — so each verdict keeps its own reason string and the report picks the most severe action.
 * Nothing is inferred: an input that is `null`/absent is listed in `missingInputs` rather than
 * being treated as healthy, and the domains that *did* run carry their own fail-closed verdicts
 * (a TVL series without history reports `insufficient-data`).
 *
 * Thresholds come from `StrategyConfig` (`risk`, `capital.reserveRatio`); this file hardcodes none
 * of them.
 */
export function evaluateRisk(input: RiskInput, config: StrategyConfig): RiskReport {
  const missingInputs: string[] = [];
  const reasons: string[] = [];
  const verdicts: Array<{ action: RiskAction; severity: AlertSeverity; reason: string }> = [];

  const peg =
    input.peg === undefined || input.peg === null
      ? (missingInputs.push('peg'), null)
      : evaluatePegRisk(input.peg, config.risk);

  const drawdown =
    input.drawdown === undefined || input.drawdown === null
      ? (missingInputs.push('drawdown'), null)
      : evaluateDrawdown(input.drawdown, config.risk);

  const tvl =
    input.tvlSeries === undefined || input.tvlSeries === null
      ? (missingInputs.push('tvlSeries'), null)
      : evaluateTvlCollapse(input.tvlSeries, config.risk);

  const reserve =
    input.reserveRatio === undefined || input.reserveRatio === null
      ? (missingInputs.push('reserveRatio'), null)
      : evaluateReserve(input.reserveRatio, reserveThresholdsFrom(config));

  const range =
    input.range === undefined || input.range === null
      ? (missingInputs.push('range'), null)
      : evaluateRangeRisk(input.range);

  const emergency =
    input.emergencyEvents === undefined || input.emergencyEvents === null
      ? (missingInputs.push('emergencyEvents'), null)
      : evaluateEmergency(input.emergencyEvents);

  const marketDecline =
    input.marketDecline === undefined || input.marketDecline === null
      ? (missingInputs.push('marketDecline'), null)
      : evaluateMarketDecline(input.marketDecline, config.risk);

  for (const verdict of [peg, drawdown, tvl, reserve, range, emergency, marketDecline]) {
    if (verdict !== null) verdicts.push({ action: verdict.action, severity: verdict.alertSeverity, reason: verdict.reason });
  }

  const degradedDomains = (
    [
      ['peg', peg?.status],
      ['drawdown', drawdown?.status],
      ['tvl', tvl?.status],
      ['reserve', reserve?.status],
      ['range', range?.status],
      ['marketDecline', marketDecline?.status],
    ] as const
  )
    .filter(([, status]) => status === 'insufficient-data')
    .map(([domain]) => domain);

  verdicts.sort((a, b) => RISK_ACTION_SEVERITY[b.action] - RISK_ACTION_SEVERITY[a.action]);

  const worst = verdicts[0];
  const action = worst?.action ?? RISK_ACTIONS.HOLD;
  // The report's severity is a MAX over the domains, not the base grade of the worst action: a
  // §57-capped depeg keeps its `critical` alert while its action stays a mere `ALERT` (§1: never
  // report a quieter alarm than a domain actually raised).
  const alertSeverity = verdicts.reduce<AlertSeverity>(
    (max, verdict) =>
      ALERT_SEVERITY_RANK[verdict.severity] > ALERT_SEVERITY_RANK[max] ? verdict.severity : max,
    alertSeverityFor(action),
  );
  for (const verdict of verdicts) {
    if (verdict.action !== RISK_ACTIONS.HOLD) reasons.push(`${verdict.action}: ${verdict.reason}`);
  }
  if (reasons.length === 0) {
    reasons.push(worst?.reason ?? 'no risk domain supplied a verdict — nothing evaluated');
  }

  const recommendedState = ACTION_TO_STATE[action];

  return {
    asOf: input.asOf,
    action,
    alertSeverity,
    recommendedState,
    readOnly: READ_ONLY_STATES.includes(recommendedState),
    noNewCapital: NO_NEW_CAPITAL_STATES.includes(recommendedState),
    hardExitPermitted: peg?.hardExitPermitted ?? false,
    reasons,
    missingInputs,
    dataDegraded: degradedDomains.length > 0,
    degradedDomains,
    peg,
    drawdown,
    tvl,
    reserve,
    range,
    emergency,
    marketDecline,
    tokenDeviation: peg?.deviation ?? input.marketDecline?.tokenDeviation ?? null,
    totalNav: drawdown?.currentNAV ?? null,
    suggestedActions: drawdown?.requiredActions.length
      ? [...drawdown.requiredActions]
      : range?.followUps
        ? [...range.followUps]
        : [],
  };
}

/** Convenience: §54 deviation + §55 grading for a raw on-chain price / reference pair. */
export function gradePegDeviation(
  onchainPrice: PriceUsd,
  referenceNav: PriceUsd,
  risk: RiskConfig,
): { readonly deviation: Ratio | null; readonly level: PegLevel | null } {
  const deviation = computePegDeviation(onchainPrice, referenceNav);
  return {
    deviation,
    level: deviation === null ? null : classifyPegLevel(deviation, pegThresholdsFrom(risk)),
  };
}
