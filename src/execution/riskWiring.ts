/**
 * Module 3 · Risk wiring: live position state in, verdict and action out.
 *
 * Named `riskWiring` rather than "...Monitor" on purpose: `portfolioMonitor` already owns the valuation
 * (NAV, reserve ratio, drawdown), and two `*Monitor` modules would make it unclear which one holds the
 * risk rules. This one holds none of them.
 *
 * ## What this module is, and what it deliberately is not
 * It is the **wiring**: it reads the one open position's live state, assembles the inputs `evaluateRisk`
 * needs, and turns the verdict into an action or an alert. It is NOT a second risk engine — the verdicts,
 * thresholds and severity bands all live in `src/strategy/riskManager.ts` (78 tests) and are called, never
 * re-derived. Re-deriving them here is exactly the "essence loss" the architecture forbids (§7.2).
 *
 * ## Why it existed as a gap
 * Measured before this module: `runtime.ts` referenced neither `position` nor `tvlSeries`, and
 * `evaluateRisk` was never called. The risk rules were written and tested but **nothing ran them**, so
 * "automatic risk control" was nominal — a TVL collapse, a depeg or a drawdown would have produced no
 * alert and no action. This is what closes that.
 *
 * ## The three judgements this module must get right
 * 1. **Fail closed on degraded data.** `PortfolioMonitor` reports `complete: false` when any leg is
 *    unpriced; a drawdown verdict derived from a NAV that is known to be a floor would be a claim about a
 *    number we know is wrong. So an incomplete valuation produces no §65/§66 verdict (architecture §5.3).
 * 2. **A risk halt stops, and only a human restarts it** (§6.3). Acting on a verdict may close the
 *    position, but it must never rebuild: the market or the contract already misbehaved once.
 * 3. **Price below range is NOT an exit** (§8.6). At that point the position is nearly all stock token, so
 *    an automatic withdrawal sells at the low and realises the loss. Baseline §51/§53 route it to a human,
 *    and this module's job is to give that human enough context to actually decide.
 */
import type { IsoTimestamp, PoolId, Ratio, UsdAmount } from '../types/primitives.ts';
import type { AlertSeverity } from '../types/notifier.ts';
import {
  pct,
  renderMessage,
  riskHeadline,
  usd,
  type MessageRow,
} from '../notify/messageFormat.ts';
import type { BotState } from '../types/state.ts';
import type { StrategyConfig } from '../types/config.ts';
import type { PoolSnapshot } from '../types/market.ts';
import type { PortfolioSnapshot, Position } from '../types/portfolio.ts';
import {
  RISK_ACTIONS,
  evaluateRisk,
  tvlObservationFrom,
  type EmergencyEvent,
  type MarketDeclineInput,
  type RiskAction,
  type RiskReport,
} from '../strategy/riskManager.ts';
import { buildDrawdownState, buildPortfolioSnapshot } from '../strategy/nav.ts';
import type { AllocationLimits } from '../strategy/allocation.ts';
import type { PortfolioMonitor, MonitorInputs } from './portfolioMonitor.ts';

/**
 * What the monitor needs about the CURRENT position, read from the store plus the chain.
 *
 * `null` means flat. More than one open position is a fault (architecture §8.5) and is reported as such
 * rather than silently reduced to the first.
 */
export interface OpenPositionView {
  readonly record: Position;
  /** The last scan's snapshot for this pool. `null` when the pool is not in the scan (§16 drifts) —
   *  the position still exists on chain and MUST NOT be folded into "no position". */
  readonly pool: PoolSnapshot | null;
  readonly positionTokenId: bigint;
  readonly liquidity: bigint;
  readonly owner: string;
}

export interface RiskActionPlan {
  readonly action: RiskAction;
  readonly severity: AlertSeverity;
  /** State the bot should move to. Advisory: the state machine owns the transition. */
  readonly nextState: BotState;
  /** Human-readable, most severe first (straight from the risk report). */
  readonly reasons: readonly string[];
  readonly report: RiskReport;
  /**
   * True when the action should close the position without asking. False for anything a human must judge.
   */
  readonly autoExit: boolean;
}

export interface RiskWiringDeps {
  readonly monitor: PortfolioMonitor;
  readonly config: StrategyConfig;
  readonly allocationLimits: AllocationLimits;
  /**
   * The one open position, or `null`. Supplied by the caller because "what is open" is a store+chain
   * question; this module must not answer it itself.
   */
  readonly openPosition: () => Promise<OpenPositionView | null>;
  /** §59 history for the current pool — the reason the snapshot table exists. */
  readonly tvlSeries: (poolId: PoolId) => readonly { readonly asOf: IsoTimestamp; readonly tvlUsd: number }[];
  /** §58 conditions observed outside the pool data (contract paused, issuer suspended, …). */
  readonly emergencyEvents?: () => readonly EmergencyEvent[];
  /**
   * The pool's own contribution and how many consecutive rounds it has been negative.
   *
   * Injected because answering it needs the entry baseline and the entry composition's current value —
   * both facts about the position, not about this module's job.
   */
  readonly poolContribution?: (
    open: OpenPositionView | null,
  ) => { readonly contributionUsd: UsdAmount | null; readonly rounds: number };
  /**
   * Has any capital ever been committed to this strategy?
   *
   * Needed to tell two situations apart that otherwise look identical to §66:
   * ```text
   * NAV == 0, nothing ever deposited  → the strategy is idle (a fresh install) — NOT a drawdown
   * NAV == 0, capital was committed   → genuinely wiped out — MUST halt
   * ```
   * Without this, an unfunded wallet satisfies `0 <= initialNAV × 0.85` literally and the bot reports
   * `GLOBAL_RISK_OFF` at `critical` on day zero. Found in the Step 4 live regression.
   *
   * Defaults to "funded" when absent, so the safe reading (do evaluate the line) is the one you get if a
   * caller forgets: an unnecessary alert costs a glance, a suppressed halt costs the account.
   */
  readonly hasCommittedCapital?: () => boolean;
  /**
   * Derived §53 input: did the underlying stock fall, and did the reference NAV fall with it?
   * Absent ⇒ the market-decline domain is not evaluated, which the report surfaces as a missing input
   * rather than as "no decline".
   */
  readonly marketDecline?: (at: IsoTimestamp) => MarketDeclineInput | null;
  readonly now?: () => IsoTimestamp;
}

export interface RiskWiringingRound {
  readonly report: RiskReport;
  readonly plan: RiskActionPlan;
  /** The snapshot the verdict was based on, present only when the valuation was complete. */
  readonly nav?: UsdAmount;
  /**
   * The full valuation, present only when it was complete.
   *
   * Exposed so the operator-facing `/nav` command reports the SAME numbers the risk verdict was computed
   * from. Re-deriving them would create a second formula that could disagree with the one that halts the
   * bot — and the operator would be shown the wrong one.
   */
  readonly snapshot?: PortfolioSnapshot;
  /** Set when the valuation was incomplete, in which case no §65/§66 verdict was produced. */
  readonly valuationProblems?: readonly string[];
}

export class RiskWiring {
  private readonly deps: RiskWiringDeps;

  constructor(deps: RiskWiringDeps) {
    this.deps = deps;
  }

  private now(): IsoTimestamp {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  /**
   * One monitoring round (architecture §5).
   *
   * The order matters: read the position first (because the valuation depends on it), then value, then
   * judge. Judging before valuing would mean evaluating §66 against a NAV we have not computed.
   */
  async round(options: { readonly priorPeakNAV: number | null; readonly realizedFees: number }): Promise<RiskWiringingRound> {
    const at = this.now();
    const open = await this.deps.openPosition();

    // Flat: there is no position to judge, and §59 history for a pool we are not in is not our business.
    // The reserve-side checks still run so a drawdown is noticed even while flat.
    const valuation = await this.value(open, options, at);

    // §pre-funding: an untouched wallet is idle, not breached. Distinguished by whether capital was ever
    // committed, because `initialNAV` is a CONFIGURED intent figure and cannot answer that question.
    const funded = this.deps.hasCommittedCapital?.() ?? true;
    const unfunded = !funded && valuation.snapshot.totalNAV === 0;

    const tvlSeries = open === null ? null : this.deps.tvlSeries(open.record.poolId);

    const report = evaluateRisk(
      {
        asOf: at,
        // Suppressed ONLY for the empty, never-funded case. A funded strategy at zero NAV still gets the
        // verdict — that one is a real wipe-out and must halt.
        drawdown: unfunded ? null : valuation.drawdown,
        reserveRatio: valuation.snapshot.reserveRatio,
        range:
          open === null || open.pool === null || !Number.isFinite(open.pool.currentPrice.value)
            ? null
            : {
                currentPrice: open.pool.currentPrice.value,
                lowerPrice: open.record.lowerPrice,
                upperPrice: open.record.upperPrice,
              },
        tvlSeries: tvlSeries === null ? null : tvlSeries.map((point) => ({ asOf: point.asOf, tvlUsd: point.tvlUsd })),
        emergencyEvents: this.deps.emergencyEvents?.() ?? null,
        marketDecline: this.deps.marketDecline?.(at) ?? null,
        // The pool's OWN contribution, supplied by the composition root: computing it needs the entry
        // baseline and the position's entry composition, neither of which this module owns. Absent when
        // there is no position, which is why it is not reported as a missing input.
        poolContribution: this.deps.poolContribution?.(open) ?? null,
        // `peg` is intentionally NOT supplied here: it needs a trustworthy reference price, and the
        // PortfolioMonitor reports an unusable one as a valuation problem. Passing `null` makes the report
        // say "peg not evaluated" instead of implying "no depeg".
        peg: null,
      },
      this.deps.config,
    );

    // When the drawdown domain is suppressed, say so: an operator seeing no verdict must be able to tell
    // "idle" from "the check is broken".
    // `evaluateRisk` already records `drawdown` as a missing input when it is null, so this only adds the
    // REASON. Pushing the name again produced `missingInputs: [..., 'drawdown', 'drawdown']`, which reads
    // as two separate gaps and would make any "is this domain missing?" check unreliable.
    const withReason = unfunded
      ? {
          ...report,
          alertSeverity:
            // A fresh, unfunded wallet must not page at `critical`. The reserve is 0% only because there is
            // no money yet — an alert that fires on every install is an alert nobody reads.
            report.alertSeverity === 'critical' ? ('info' as const) : report.alertSeverity,
          reasons: [
            `drawdown: the strategy has not been funded yet (NAV 0 and no capital committed), so there is ` +
              'no drawdown to measure — this is idle, not a loss',
            ...report.reasons,
          ],
        }
      : report;

    return {
      report: withReason,
      plan: planFor(withReason, open !== null),
      ...(valuation.snapshot.totalNAV === undefined ? {} : { nav: valuation.snapshot.totalNAV }),
      // Only when the valuation was COMPLETE. A partial snapshot has placeholder values that would read as
      // real measurements on `/nav` — a subset of the portfolio presented as the whole.
      ...(valuation.problems.length === 0 ? { snapshot: valuation.snapshot } : {}),
      ...(valuation.problems.length === 0 ? {} : { valuationProblems: valuation.problems }),
    };
  }

  /**
   * Value the portfolio, and derive §65 drawdown ONLY when the valuation is usable.
   *
   * A `drawdown: null` is the honest answer for an incomplete valuation: `totalNAV` is then a floor rather
   * than the portfolio value, so neither "safe" nor "breached" can be concluded. Measured failure this
   * prevents: an unpriced stablecoin made `totalNAV` collapse to 0 and the §66 line reported `breached`
   * for a healthy portfolio, which would have halted the bot on a fabricated total loss.
   */
  private async value(
    open: OpenPositionView | null,
    options: { readonly priorPeakNAV: number | null; readonly realizedFees: number },
    at: IsoTimestamp,
  ): Promise<{
    readonly snapshot: ReturnType<typeof buildPortfolioSnapshot>['snapshot'];
    readonly drawdown: ReturnType<typeof buildDrawdownState> | null;
    readonly problems: readonly string[];
  }> {
    // §4.2.1: the position is READ LIVE from the chain by the monitor (this module owns no chain
    // client). The scan snapshot enriches it when present; its ABSENCE never folds the position away.
    const livePosition = open === null ? null : await this.deps.monitor.readOpenPosition(open.record);
    const inputs: MonitorInputs = {
      walletAddress: this.deps.monitor.walletAddress(),
      now: at,
      position: livePosition === null ? null : livePosition.position,
      pool: open?.pool ?? null,
      benchmark: null,
      /**
       * The §65/§66 baseline: the equity the operator actually committed, not a configured target.
       *
       * For an OPEN position that is its recorded `entryEquityUsd` — the money really at risk from the
       * moment it was deployed. Falling back to the configured intent figure would put the drawdown line
       * at a number the wallet may never have held (the operator funds manually and in steps), so a breach
       * could fire on a portfolio that never lost anything.
       *
       * When flat there is no position to take a baseline from, and the configured figure is the only
       * available intent — that case is already distinguished by `hasCommittedCapital`.
       */
      initialNAV:
        open?.record.entryEquityUsd ?? this.deps.config.capital.initialStrategyCapitalUsd,
      reserveRatio: this.deps.config.capital.reserveRatio,
      priorPeakNAV: options.priorPeakNAV,
      realizedFees: options.realizedFees,
      gasCost: 0,
      swapCost: 0,
      slippageCost: 0,
    };
    const result = await this.deps.monitor.monitor(inputs);

    // The monitor already produced a drawdown, and it is `null` exactly when the valuation was incomplete.
    // Reusing it keeps one definition of "assessable" rather than two that can drift.
    const drawdown =
      result.drawdown === null
        ? null
        : buildDrawdownState(
            result.snapshot,
            this.deps.config.risk.maxDrawdown,
            at,
            this.deps.config.monitor.portfolioIntervalMinutes * 60,
          );

    return { snapshot: result.snapshot, drawdown, problems: result.problems };
  }

}

/**
 * Turn a verdict into a plan, keeping the §8.6 asymmetry explicit.
 *
 * The one rule that matters most: **an exit decision driven by price leaving the range is never automatic**.
 * Baseline §51 routes `price <= lower` to `RISK_REVIEW` precisely because the position is by then almost
 * entirely stock token — withdrawing there sells at the low and converts an unrealised loss into a realised
 * one, and §53 says a market-wide decline should be held through.
 *
 * Everything catastrophic (depeg beyond the emergency band, a contract emergency, the global drawdown line)
 * DOES exit automatically, because waiting for a human is itself the risk.
 */
export function planFor(report: RiskReport, hasPosition: boolean): RiskActionPlan {
  const nextState = report.recommendedState;
  const autoExit =
    hasPosition &&
    (report.action === RISK_ACTIONS.EMERGENCY_EXIT || report.action === RISK_ACTIONS.EMERGENCY);

  return {
    action: report.action,
    severity: report.alertSeverity,
    nextState,
    reasons: report.reasons,
    report,
    autoExit,
  };
}

/**
 * Operator-facing text for a risk action.
 *
 * Carries the context a human needs to judge, not just the verdict: for a range breach that means whether
 * the STOCK fell with the price (market risk ⇒ hold) or only the token did (token trouble ⇒ act). Deciding
 * without those two numbers is guesswork, which is why §8.6 specifies them.
 */
export function describeRiskAction(
  plan: RiskActionPlan,
  context: {
    readonly currentPrice?: number;
    readonly lowerPrice?: number;
    readonly upperPrice?: number;
    readonly stockPriceChange?: number;
    readonly referenceNavChange?: number;
    readonly deviation?: number | null;
    readonly tvlDropRatio?: number | null;
    readonly reserveRatio?: Ratio;
    readonly nav?: UsdAmount;
  } = {},
): string {
  const rows: MessageRow[] = [];

  if (context.nav !== undefined) rows.push({ label: '总权益', value: usd(context.nav) });

  if (context.reserveRatio !== undefined) {
    rows.push({ label: '储备金', value: `${pct(context.reserveRatio)}（下限 25%）` });
  }

  if (
    context.currentPrice !== undefined &&
    context.lowerPrice !== undefined &&
    context.upperPrice !== undefined
  ) {
    const where =
      context.currentPrice <= context.lowerPrice
        ? '已跌破下限'
        : context.currentPrice >= context.upperPrice
          ? '已涨破上限'
          : '在区间内';
    rows.push({ label: '当前价', value: `${context.currentPrice.toFixed(4)}（${where}）` });
    rows.push({ label: '区间', value: `${context.lowerPrice.toFixed(4)} ~ ${context.upperPrice.toFixed(4)}` });
  }

  // The two numbers that separate "the market moved" from "this token broke". Kept as a pair: either alone
  // cannot answer the question, and they are the whole reason the operator is being asked to decide.
  if (context.stockPriceChange !== undefined || context.referenceNavChange !== undefined) {
    rows.push({ label: '标的股票', value: signedPct(context.stockPriceChange) });
    rows.push({
      label: '参考净值',
      value:
        context.deviation === null || context.deviation === undefined
          ? signedPct(context.referenceNavChange)
          : `${signedPct(context.referenceNavChange)}（偏离 ${pct(context.deviation, 4)}）`,
    });
  }

  if (context.tvlDropRatio !== null && context.tvlDropRatio !== undefined) {
    rows.push({ label: '池子规模', value: `变化 ${signedPct(context.tvlDropRatio)}` });
  }

  /*
   * `plan.reasons` is deliberately NOT forwarded to the operator.
   *
   * Those strings are the engine's diagnostics: precise, stable, and full of clause numbers
   * (`§60 reserve 0.00% < 25.00% — new LP prohibited (no forced rebalance); §105 below the 20.00% warning
   * floor`). They are exactly right for the decision log (§77) and exactly wrong for a phone: an operator
   * cannot act on `§105`, and a message that restates its own conclusion trains the reader to stop reading.
   *
   * They are recorded to the audit trail by the caller before this function runs, so nothing is lost.
   */
  const action = plan.autoExit
    ? '机器人正在自动撤池，无需你操作。'
    : plan.action === RISK_ACTIONS.RISK_REVIEW
      ? '机器人不会自动处理。看完上面的数据后，决定是否发 /exit。'
      : plan.action === RISK_ACTIONS.NO_NEW_CAPITAL
        ? '这是提示，不影响已有仓位。补足储备金后即可开新仓。'
        : plan.action === RISK_ACTIONS.HOLD || plan.action === RISK_ACTIONS.ALERT
          ? undefined
          : '机器人不会自动处理，需要你判断。';

  return renderMessage({
    severity: plan.severity,
    title: riskHeadline(plan.action),
    rows,
    ...(action === undefined ? {} : { action }),
  });
}


/** A percentage that keeps its sign, so a fall reads as a fall. */
function signedPct(value: number | undefined): string {
  if (value === undefined) return '—';
  const formatted = `${(value * 100).toFixed(2)}%`;
  return value > 0 ? `+${formatted}` : formatted;
}

/** Re-exported so the composition root does not have to reach into the strategy layer for the adapter. */
export { tvlObservationFrom };
export type { EmergencyEvent, RiskAction, RiskReport };
