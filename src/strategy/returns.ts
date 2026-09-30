/**
 * Equity return and LP attribution.
 *
 * ## The product question this answers
 *
 * This is a savings product, so the headline number is one thing:
 *
 * ```text
 * return = (currentEquity - entryEquity) / entryEquity
 * ```
 *
 * Every other metric (IL, fee APR, net APR) is a MEANS of answering a follow-up question — "is this
 * particular pool worth holding, or would the money do better elsewhere?" — and none of them is the
 * product's KPI. Implementing them as the primary output would have made the reporting about the
 * strategy rather than about the operator's money.
 *
 * ## Why attribution still matters
 *
 * Equity alone cannot tell these apart:
 *
 * ```text
 * equity fell 5%           equity rose 5%
 *   (a) the stock fell         (c) the stock rose
 *   (b) the pool structure     (d) the fees earned
 *       cost us
 * ```
 *
 * Case (a) is not a reason to leave the pool — selling out would crystallise the same loss. Case (b) is.
 * So the entry-time STOCK PRICE is recorded alongside the equity, and the difference between
 * "what holding would have produced" and "what the position actually produced" is the pool's own
 * contribution.
 *
 * ## The benchmark is a hypothetical, and is labelled as one
 *
 * `holdEquity` is what the position's entry composition would be worth now if it had been left alone. It
 * is NOT an available choice the operator passed up: nobody would have bought exactly that 70/30 mix and
 * held it. It exists only to size the pool's contribution, and the field names say `hold`, not
 * `benchmark`, to keep that clear at every call site.
 *
 * ## When it refuses to produce a number
 *
 * `null` rather than a plausible-looking figure whenever an input is missing — no entry equity (a
 * position opened before the baseline was recorded), no entry price, or an unreadable current price.
 * A fabricated attribution is worse than none: it would be acted on.
 */
import type { IsoTimestamp, Ratio, UsdAmount } from '../types/primitives.ts';
import type { PoolSnapshot } from '../types/market.ts';

/** The recorded facts about a position's first moment. */
export interface EntryBaseline {
  /** Total equity when the position was opened. `null` when it was not recorded. */
  readonly entryEquityUsd: UsdAmount | null;
  /** Stock price per whole token at entry. */
  readonly entryStockPriceUsd: UsdAmount;
  readonly openedAt: IsoTimestamp;
}

/** What the position is worth now, and the inputs needed to attribute the change. */
export interface EquityNow {
  readonly currentEquityUsd: UsdAmount;
  /** Current stock price per whole token. */
  readonly currentStockPriceUsd: UsdAmount;
  /**
   * The entry composition's value today, if the pool is still the one the position is in.
   *
   * Supplied by the caller from the held token amounts and current prices. `null` when it cannot be
   * valued — the contribution is then unreportable, not zero.
   */
  readonly holdEquityUsd: UsdAmount | null;
  readonly at: IsoTimestamp;
}

export interface ReturnReport {
  /** `(current - entry) / entry`. `null` when there is no baseline to divide by. */
  readonly returnRatio: Ratio | null;
  /** `current - entry`, in USD. */
  readonly returnUsd: UsdAmount | null;
  /**
   * How much of the return came from the stock price moving, holding the entry composition.
   *
   * `null` when the entry price or the current price is unusable.
   */
  readonly marketContributionUsd: UsdAmount | null;
  /**
   * The pool's own contribution: `actual - hold`.
   *
   * Negative means the pool cost more than it earned — the honest form of "fees did not cover the
   * impermanent loss". `null` when the hypothetical cannot be valued.
   */
  readonly poolContributionUsd: UsdAmount | null;
  /** `poolContribution / entryEquity`, as a fraction. */
  readonly poolContributionRatio: Ratio | null;
  /**
   * Fees collected and accrued over the position's life, when the caller knows them.
   *
   * Kept separate from `poolContributionUsd`: a fee-only figure ignores price impact on the position's
   * value, while the contribution figure includes it. Reporting one as the other is the mistake this
   * split exists to prevent.
   */
  readonly feesUsd: UsdAmount | null;
  /** True when a complete attribution could not be produced, and why. */
  readonly incompleteReasons: readonly string[];
}

/**
 * Compute the return and its attribution.
 *
 * `entryEquityUsd === null` yields a `null` return rather than dividing by an assumed figure: a position
 * opened before the baseline existed genuinely has no return to report, and back-filling one from the
 * current wallet would report a different quantity under the same name.
 */
export function computeReturn(baseline: EntryBaseline, now: EquityNow, feesUsd: UsdAmount | null = null): ReturnReport {
  const incomplete: string[] = [];

  let returnRatio: Ratio | null = null;
  let returnUsd: UsdAmount | null = null;
  if (baseline.entryEquityUsd === null) {
    incomplete.push('no entry equity was recorded for this position, so there is no baseline to measure against');
  } else if (baseline.entryEquityUsd <= 0) {
    incomplete.push(`entry equity is ${baseline.entryEquityUsd}, which cannot be a denominator`);
  } else {
    returnUsd = now.currentEquityUsd - baseline.entryEquityUsd;
    returnRatio = returnUsd / baseline.entryEquityUsd;
  }

  // Market contribution: how the whole position would have moved if the stock had simply been held. The
  // entry price is the divisor that makes this a MARKET effect rather than a blend of market and pool.
  let marketContributionUsd: UsdAmount | null = null;
  if (!(baseline.entryStockPriceUsd > 0) || !(now.currentStockPriceUsd > 0)) {
    incomplete.push('entry or current stock price is unusable, so the market effect cannot be separated');
  } else if (baseline.entryEquityUsd !== null) {
    marketContributionUsd =
      baseline.entryEquityUsd * ((now.currentStockPriceUsd - baseline.entryStockPriceUsd) / baseline.entryStockPriceUsd);
  }

  // Pool contribution: actual minus hypothetical. This is the number that answers "is this pool worth
  // holding", and it is only computable when the hypothetical can be valued.
  let poolContributionUsd: UsdAmount | null = null;
  if (now.holdEquityUsd === null) {
    incomplete.push(
      'the entry composition could not be valued at current prices (missing price, or the position is no ' +
        'longer in the pool it was opened in)',
    );
  } else if (baseline.entryEquityUsd !== null) {
    poolContributionUsd = now.currentEquityUsd - now.holdEquityUsd;
  }

  return {
    returnRatio,
    returnUsd,
    marketContributionUsd,
    poolContributionUsd,
    poolContributionRatio:
      poolContributionUsd === null || baseline.entryEquityUsd === null || baseline.entryEquityUsd <= 0
        ? null
        : poolContributionUsd / baseline.entryEquityUsd,
    feesUsd,
    incompleteReasons: incomplete,
  };
}

/**
 * Value the entry composition at current prices — the hypothetical that sizes the pool's contribution.
 *
 * Uses the position's recorded `initialToken0/1` (UI amounts as held at open) valued at today's prices.
 * Returns `null` if either leg cannot be priced: a partial valuation would understate the hypothetical and
 * therefore overstate the pool's contribution, which is the direction that would wrongly justify an exit.
 */
export function valueEntryComposition(input: {
  readonly initialToken0: { readonly ui: bigint; readonly decimals: number };
  readonly initialToken1: { readonly ui: bigint; readonly decimals: number };
  readonly price0Usd: UsdAmount | null;
  readonly price1Usd: UsdAmount | null;
}): UsdAmount | null {
  if (input.price0Usd === null || input.price1Usd === null) return null;
  const amount0 = Number(input.initialToken0.ui) / 10 ** input.initialToken0.decimals;
  const amount1 = Number(input.initialToken1.ui) / 10 ** input.initialToken1.decimals;
  return amount0 * input.price0Usd + amount1 * input.price1Usd;
}

/**
 * Whether the pool's contribution has been negative long enough to act on.
 *
 * A single negative reading is noise: one round can be down because the stock moved between two block
 * reads. The rule requires the condition to PERSIST, which is why the caller supplies the streak rather
 * than the function keeping state — the store is the right place for that, and keeping it here would make
 * this untestable without a clock.
 */
export function isPoolContributionNegative(report: ReturnReport, thresholdUsd = 0): boolean {
  return report.poolContributionUsd !== null && report.poolContributionUsd < -Math.abs(thresholdUsd);
}

/** The current stock price for a pool, or `null` when it cannot be read (never a default). */
export function stockPriceOf(pool: PoolSnapshot | undefined): UsdAmount | null {
  if (pool === undefined) return null;
  const price = pool.stockReferencePrice.value;
  return price > 0 ? price : null;
}
