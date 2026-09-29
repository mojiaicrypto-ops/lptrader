import type { Whitelist } from './registry.ts';
import type { DurationSeconds, IsoTimestamp, Ratio, UsdAmount } from './primitives.ts';

/**
 * §85 StrategyConfig, resolved and validated.
 *
 * All ratios are FRACTIONS (0.70, not 70) and all thresholds are USD doubles. Field names are the
 * camelCased YAML keys of `config/strategy.yaml`; the YAML file is the single source of truth and
 * this type is its typed projection (blank thresholds fall back to the §85 defaults).
 */

export interface CapitalConfig {
  /** §3 max share of NAV that may sit in LP. */
  readonly maxLpRatio: Ratio;
  /** §3/§4 reserve share of NAV. */
  readonly reserveRatio: Ratio;
  /**
   * §68 `InitialStrategyCapital` in USD. Fixed by the user; the bot must never top it up
   * automatically. Also anchors the §65/§66 risk line.
   */
  readonly initialStrategyCapitalUsd: UsdAmount;
}

export interface MonitorConfig {
  /** §46 portfolio monitoring cadence, minutes. */
  readonly portfolioIntervalMinutes: number;
  /** §14 pool scan cadence, minutes. */
  readonly poolScanIntervalMinutes: number;
  /** §89 current-pool health cadence, minutes. */
  readonly poolHealthIntervalMinutes: number;
}

export interface RangeConfig {
  /** §33 `lower = current * lower_ratio`. */
  readonly lowerRatio: Ratio;
  /** §33 `upper = current * upper_ratio`. */
  readonly upperRatio: Ratio;
}

export interface YieldConfig {
  readonly targetNetApr: Ratio;
  readonly warningNetApr: Ratio;
  /** §69 `Expected Net APR < warning_net_apr` for this many hours → UNDERPERFORMING. */
  readonly warningDurationHours: number;
}

/** §16 hard pool filters. */
export interface PoolThresholdConfig {
  readonly minTvlUsd: UsdAmount;
  readonly minAvgDailyVolume7dUsd: UsdAmount;
  readonly minPoolAgeDays: number;
  readonly maxNavDeviation: Ratio;
  readonly maxSwapPriceImpact: Ratio;
}

export interface SwapConfig {
  /** §40 slippage cap enforced inside the atomic call. */
  readonly maxSlippage: Ratio;
  /** §40 price-impact cap — MUST be self-computed before encoding (the SDK cannot enforce it). */
  readonly maxPriceImpact: Ratio;
  /** §41 quote freshness. */
  readonly quoteTtlSeconds: DurationSeconds;
}

/** §30-§32, §70-§72 (Phase 5 consumers, config present from day one). */
export interface SwitchConfig {
  readonly minAprImprovement: Ratio;
  readonly maxBreakEvenDays: number;
  readonly cooldownDays: number;
  readonly maxSwitchCostRatio: Ratio;
}

/** §55/§65 thresholds. `maxDrawdown` is the §66 multiplier (0.15 ⇒ risk line at 85% of NAV). */
export interface RiskConfig {
  readonly maxDrawdown: Ratio;
  readonly pegWarning: Ratio;
  readonly stopNewPosition: Ratio;
  readonly exitReview: Ratio;
  readonly emergencyExit: Ratio;
  /** §59 TVL collapse thresholds. */
  readonly tvlDropReview: Ratio;
  readonly tvlDropEmergency: Ratio;
  /** §60 `reserve < 25%` ⇒ no new LP. */
  readonly minReserveBeforeNewLp: Ratio;
}

export interface FeesConfig {
  /** §61 — always false in V1; present so an accidental true is a config error, not a silent change. */
  readonly autoCompound: boolean;
  readonly minCollectUsd: UsdAmount;
  readonly collectIntervalDays: number;
  /** §63 convert stock-token fees to stablecoin before the reserve. */
  readonly convertStockFeesToStable: boolean;
}

/** Interactive approval policy. `BUILD_POSITION` and `SWITCH_POOL` require a human answer. */
export interface ApprovalsConfig {
  readonly buildPosition: ApprovalPolicy;
  readonly switchPool: ApprovalPolicy;
  /** Everything else (collect / exit / risk operations) stays automatic per §91. */
  readonly others: AutoApprovalPolicy;
  /** Seconds/minutes a request stays answerable; after it the request expires and nothing runs. */
  readonly timeoutMinutes: number;
}

export type ApprovalPolicy = 'confirm';
export type AutoApprovalPolicy = 'auto';

export interface TelegramConfig {
  /** When false the notifier is a no-op and no approval can be granted. */
  readonly enabled: boolean;
}

export interface StrategyConfig {
  readonly capital: CapitalConfig;
  readonly monitor: MonitorConfig;
  readonly range: RangeConfig;
  readonly yield: YieldConfig;
  readonly pool: PoolThresholdConfig;
  readonly swap: SwapConfig;
  readonly switch: SwitchConfig;
  readonly risk: RiskConfig;
  readonly fees: FeesConfig;
  readonly approvals: ApprovalsConfig;
  readonly telegram: TelegramConfig;
  /** §11/§12/§8-§10 whitelists, resolved to addresses. */
  readonly whitelist: Whitelist;
  /** Absolute path of the strategy YAML actually loaded (audit). */
  readonly sourcePath?: string;
  readonly loadedAt: IsoTimestamp;
}
