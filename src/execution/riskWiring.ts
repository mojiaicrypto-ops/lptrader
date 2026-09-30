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
  readonly pool: PoolSnapshot;
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

    const tvlSeries = open === null ? null : this.deps.tvlSeries(open.pool.poolId);

    const report = evaluateRisk(
      {
        asOf: at,
        // Suppressed ONLY for the empty, never-funded case. A funded strategy at zero NAV still gets the
        // verdict — that one is a real wipe-out and must halt.
        drawdown: unfunded ? null : valuation.drawdown,
        reserveRatio: valuation.snapshot.reserveRatio,
        range:
          open === null || !Number.isFinite(open.pool.currentPrice.value)
            ? null
            : {
                currentPrice: open.pool.currentPrice.value,
                lowerPrice: open.record.lowerPrice,
                upperPrice: open.record.upperPrice,
              },
        tvlSeries: tvlSeries === null ? null : tvlSeries.map((point) => ({ asOf: point.asOf, tvlUsd: point.tvlUsd })),
        emergencyEvents: this.deps.emergencyEvents?.() ?? null,
        marketDecline: this.deps.marketDecline?.(at) ?? null,
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
    const inputs: MonitorInputs = {
      walletAddress: this.deps.monitor.walletAddress(),
      now: at,
      position: null,
      pool: open?.pool ?? null,
      benchmark: null,
      initialNAV: this.deps.config.capital.initialStrategyCapitalUsd,
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
  const lines: string[] = [`${plan.action} (severity ${plan.severity})`];
  for (const reason of plan.reasons.slice(0, 5)) lines.push(`  · ${reason}`);

  if (context.currentPrice !== undefined && context.lowerPrice !== undefined && context.upperPrice !== undefined) {
    const position =
      context.currentPrice <= context.lowerPrice
        ? 'BELOW the lower bound'
        : context.currentPrice >= context.upperPrice
          ? 'ABOVE the upper bound'
          : 'inside the range';
    lines.push(
      '',
      'Range:',
      `  current ${context.currentPrice.toFixed(6)} / lower ${context.lowerPrice.toFixed(6)} / upper ${context.upperPrice.toFixed(6)}`,
      `  price is ${position}`,
    );
  }

  if (context.stockPriceChange !== undefined || context.referenceNavChange !== undefined) {
    // The two numbers that separate "the market fell" from "this token broke".
    lines.push(
      '',
      'Is this a market move or a token problem?',
      `  underlying stock move : ${formatPct(context.stockPriceChange)}`,
      `  reference NAV move    : ${formatPct(context.referenceNavChange)}`,
      context.deviation === null || context.deviation === undefined
        ? '  token/NAV deviation   : unknown (no trustworthy reference)'
        : `  token/NAV deviation   : ${(context.deviation * 100).toFixed(4)}%`,
      '  If both moved together the position is riding a market move (hold); if only the token moved, ' +
        'the token is the problem.',
    );
  }

  if (context.tvlDropRatio !== null && context.tvlDropRatio !== undefined) {
    lines.push('', `Pool TVL changed ${(context.tvlDropRatio * 100).toFixed(2)}% over the window.`);
  }
  if (context.reserveRatio !== undefined) {
    lines.push(`Reserve ratio: ${(context.reserveRatio * 100).toFixed(2)}%`);
  }
  if (context.nav !== undefined) {
    lines.push(`NAV: $${context.nav.toLocaleString('en-US', { maximumFractionDigits: 2 })}`);
  }

  if (!plan.autoExit && plan.action === RISK_ACTIONS.RISK_REVIEW) {
    lines.push(
      '',
      'No automatic action will be taken. Review and use /exit if you decide to close.',
    );
  }
  return lines.join('\n');
}

function formatPct(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return 'unknown';
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(2)}%`;
}

/** Re-exported so the composition root does not have to reach into the strategy layer for the adapter. */
export { tvlObservationFrom };
export type { EmergencyEvent, RiskAction, RiskReport };
