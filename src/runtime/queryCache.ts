/**
 * Query data: the last observed state of everything the operator can ask about.
 *
 * ## Why a cache rather than live reads
 *
 * `/pools`, `/nav`, `/risk`, `/position` and `/status` are answered from here, never by reading the chain
 * or running a scan on demand. Two reasons, both operational:
 *
 * 1. **Rate limits.** The data sources are HTTP with per-minute budgets. An operator tapping `/pools`
 *    three times would spend the scan's entire allowance and starve the cadence that actually needs it.
 * 2. **Latency.** Telegram times out long before a fresh scan finishes (measured: ~4 minutes for the
 *    first scan). A command that reads live would appear broken.
 *
 * So the beats publish what they observed and the commands read it. Every entry carries the time it was
 * observed, and stale data says so rather than pretending to be current — the same `Sourced` discipline
 * the rest of the system uses.
 *
 * ## What it deliberately does not hold
 *
 * No chain clients, no stores, no providers. It is a plain container so the cadences can fill it and the
 * handlers can read it without either knowing about the other. That also makes it trivially testable.
 */
import type { AlertSeverity } from '../types/notifier.ts';
import type { BotState } from '../types/state.ts';
import type { IsoTimestamp, PoolId, UsdAmount } from '../types/primitives.ts';
import type { PoolSnapshot } from '../types/market.ts';
import type { ScreenOutcome } from '../data/poolScreener.ts';

/** One observed value, with when it was observed, so a reader can judge freshness. */
export interface Observed<T> {
  readonly value: T;
  readonly at: IsoTimestamp;
}

/** A pool as the operator sees it: the snapshot plus why it is or is not usable. */
export interface PoolView {
  readonly poolId: PoolId;
  readonly dex: string;
  readonly tvlUsd: number;
  readonly avgDailyVolume7dUsd: number;
  readonly poolAgeDays: number;
  /** `null` when the APR could not be computed (§96: unavailable, not zero). */
  readonly estimatedApr7d: number | null;
  /** True when this pool survived the §16 admission-stage filters. */
  readonly admitted: boolean;
  /** The failed conditions, verbatim from the filter — `[]` when admitted. */
  readonly reasons: readonly string[];
  /** §96: some figure was unreadable, so the verdict is incomplete rather than negative. */
  readonly indeterminate: boolean;
}

/** The headline return and its attribution, as shown on `/nav`. */
export interface ReturnView {
  /** `(current - entry) / entry`, as a fraction. `null` when no baseline was recorded. */
  readonly returnRatio: number | null;
  readonly returnUsd: number | null;
  /** The part of the change explained by the stock price moving. */
  readonly marketContributionUsd: number | null;
  /**
   * The pool's own contribution: actual minus "what holding the entry mix would be worth".
   *
   * Negative means the pool cost more than it earned. This is the number that answers "is this pool worth
   * staying in", and it is the honest form of "fees did not cover the impermanent loss".
   */
  readonly poolContributionUsd: number | null;
  readonly poolContributionRatio: number | null;
  readonly feesUsd: number | null;
  /** Why a complete attribution could not be produced. Empty when everything was computable. */
  readonly incompleteReasons: readonly string[];
  /** Consecutive rounds in which the pool's contribution has been negative, for the persistence rule. */
  readonly negativeContributionRounds: number;
}

export interface NavView {
  readonly totalNavUsd: UsdAmount;
  readonly walletUsd: UsdAmount;
  readonly stablecoinUsd: UsdAmount;
  readonly lpValueUsd: UsdAmount;
  readonly unclaimedFeesUsd: UsdAmount;
  readonly reserveRatio: number;
  readonly lpRatio: number;
  readonly drawdown: number;
  /** Present once a position exists and the baseline could be read. */
  readonly returns?: ReturnView;
}

export interface RiskView {
  readonly action: string;
  readonly severity: AlertSeverity;
  readonly reasons: readonly string[];
  readonly navUsd?: UsdAmount;
  /** Set when the valuation was incomplete, so no §65/§66 verdict was produced. */
  readonly valuationProblems?: readonly string[];
}

export interface PositionView {
  readonly poolId: PoolId;
  readonly positionTokenId: string;
  readonly dex: string;
  readonly rangeProgress: number;
  readonly unclaimedFeesUsd: UsdAmount;
  readonly liquidityRaw: string;
  readonly openedAt: IsoTimestamp;
}

export interface StatusView {
  readonly state: BotState;
  readonly readOnly: boolean;
  readonly dryRun: boolean;
  readonly telegramEnabled: boolean;
  readonly cadences: readonly { readonly name: string; readonly intervalMinutes: number }[];
  readonly approvals: string;
}

/**
 * The container. Every field is optional because "we have not observed it yet" is a real state — and on a
 * fresh start it is the ONLY state. A command answered before the first beat must say "not yet measured"
 * rather than print zeros, which would read as a real, alarming measurement.
 */
export class QueryCache {
  private poolsValue: Observed<readonly PoolView[]> | null = null;
  private navValue: Observed<NavView> | null = null;
  private riskValue: Observed<RiskView> | null = null;
  private positionValue: Observed<PositionView> | null = null;
  private statusValue: Observed<StatusView> | null = null;
  /** Most recent screening run, so `/pools` can explain a build refusal from the last attempt. */
  private screenValue: Observed<ScreenOutcome> | null = null;

  setPools(pools: readonly PoolView[], at: IsoTimestamp): void {
    this.poolsValue = { value: pools, at };
  }
  setNav(nav: NavView, at: IsoTimestamp): void {
    this.navValue = { value: nav, at };
  }
  setRisk(risk: RiskView, at: IsoTimestamp): void {
    this.riskValue = { value: risk, at };
  }
  /**
   * `null` records "we looked and there is no position" — distinct from "we have not looked", which is the
   * field being `undefined`. A flat bot and an unobserved bot must not render the same.
   */
  setPosition(position: PositionView | null, at: IsoTimestamp): void {
    this.positionValue = position === null ? null : { value: position, at };
    this.positionObservedAt = position === null ? at : null;
  }
  /** When the last position read happened, including a read that found nothing. */
  positionObservedAt: IsoTimestamp | null = null;
  setStatus(status: StatusView, at: IsoTimestamp): void {
    this.statusValue = { value: status, at };
  }
  setScreen(outcome: ScreenOutcome, at: IsoTimestamp): void {
    this.screenValue = { value: outcome, at };
  }

  get pools(): Observed<readonly PoolView[]> | null {
    return this.poolsValue;
  }
  get nav(): Observed<NavView> | null {
    return this.navValue;
  }
  get risk(): Observed<RiskView> | null {
    return this.riskValue;
  }
  get position(): Observed<PositionView> | null {
    return this.positionValue;
  }
  get status(): Observed<StatusView> | null {
    return this.statusValue;
  }
  get screen(): Observed<ScreenOutcome> | null {
    return this.screenValue;
  }
}

/**
 * Build a `/pools` view from a §16 evaluation and its snapshot.
 *
 * `indeterminate` is separated from `admitted` on purpose: a pool rejected because a figure could not be
 * read is NOT the same as a pool rejected for being unsuitable, and collapsing them is what made an
 * earlier version of this system alert on a healthy market every hour.
 */
export function poolViewFrom(input: {
  readonly snapshot: PoolSnapshot;
  readonly admitted: boolean;
  readonly reasons: readonly string[];
  readonly indeterminate: boolean;
}): PoolView {
  return {
    poolId: input.snapshot.poolId,
    dex: input.snapshot.dex,
    tvlUsd: input.snapshot.tvlUSD.value,
    avgDailyVolume7dUsd: input.snapshot.volume7d.value / 7,
    poolAgeDays: input.snapshot.poolAgeDays,
    estimatedApr7d: input.snapshot.estimatedAPR7d.value,
    admitted: input.admitted,
    reasons: input.reasons,
    indeterminate: input.indeterminate,
  };
}
