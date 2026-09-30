/**
 * §3/§4 capital-allocation enforcement.
 *
 * ## What this module is for
 * The user funds the strategy **manually and incrementally**, and does not want the bot topping itself
 * up (§68). So the bot's whole responsibility on this axis is the opposite of clever: **allocate exactly
 * the configured proportions, and refuse to exceed them.** That is what this module does, and it is the
 * only place the `max_lp_ratio` / `reserve_ratio` arithmetic happens.
 *
 * ## Why a dedicated module rather than a check inside the executor
 * The two limits are enforced at different moments and must agree:
 *   - **sizing** (`lpBudgetUsd`) — how much NAV may be committed to LP. Runs before a plan is built.
 *   - **verification** (`verifyPostAllocation`) — did the resulting allocation actually stay inside the
 *     bands? Runs after, on observed balances rather than on intent.
 * Keeping both here means a change to the rule cannot be applied to one and not the other, and means the
 * numbers are testable without a chain.
 *
 * ## The ratios are targets, and the naive "+/- tolerance" reading is wrong
 * §3 sets a target split (70/30). The reserve must not *fall* below `reserve_ratio`, and LP must not
 * *exceed* `max_lp_ratio`. Those are the two hard directions, because breaching them is what puts risk on
 * the table. A reserve *above* its target is not a violation — it is simply un-deployed capital, and
 * §4 expressly forbids auto-deploying it. Reporting an oversized reserve as a failure would train an
 * operator to ignore the check.
 *
 * `maxLpRatio + reserveRatio <= 1` is validated at config load, so the two bands cannot overlap.
 */
import type { CapitalConfig } from '../types/config.ts';
import type { Ratio, UsdAmount } from '../types/primitives.ts';

/**
 * USD for a human-readable refusal reason.
 *
 * `toFixed` alone yields `$8000.00`, which reads badly in an alert and, more importantly, invites
 * misreading a five-figure sum. Grouping is presentation only — every comparison in this module is done
 * on the raw numbers, so this never touches a decision.
 */
function usd(value: number): string {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Reasons an allocation is refused. Machine-readable so the decision log can carry the code. */
export const ALLOCATION_REFUSALS = {
  LP_EXCEEDS_MAX: 'lp_exceeds_max_ratio',
  RESERVE_BELOW_MIN: 'reserve_below_min_ratio',
  NAV_UNUSABLE: 'nav_unusable',
  CAPITAL_NOT_POSITIVE: 'capital_not_positive',
} as const;
export type AllocationRefusal = (typeof ALLOCATION_REFUSALS)[keyof typeof ALLOCATION_REFUSALS];

export interface AllocationLimits {
  /** §3 `max_lp_ratio` (0.70). */
  readonly maxLpRatio: Ratio;
  /** §3/§4 `reserve_ratio` (0.30) — a floor, not a target to be spent down. */
  readonly reserveRatio: Ratio;
}

export interface AllocationCheck {
  readonly ok: boolean;
  readonly reason?: string;
  readonly refusal?: AllocationRefusal;
}

/** The §3 limits, read from config so no constant is restated anywhere else. */
export function allocationLimitsFrom(config: Pick<CapitalConfig, 'maxLpRatio' | 'reserveRatio'>): AllocationLimits {
  if (!Number.isFinite(config.maxLpRatio) || config.maxLpRatio <= 0 || config.maxLpRatio > 1) {
    throw new Error(`max_lp_ratio must be in (0, 1], got ${String(config.maxLpRatio)}`);
  }
  if (!Number.isFinite(config.reserveRatio) || config.reserveRatio < 0 || config.reserveRatio >= 1) {
    throw new Error(`reserve_ratio must be in [0, 1), got ${String(config.reserveRatio)}`);
  }
  if (config.maxLpRatio + config.reserveRatio > 1 + 1e-9) {
    throw new Error(
      `max_lp_ratio (${config.maxLpRatio}) + reserve_ratio (${config.reserveRatio}) exceeds 1; the bands ` +
        'would overlap and no allocation could satisfy both',
    );
  }
  return { maxLpRatio: config.maxLpRatio, reserveRatio: config.reserveRatio };
}

/**
 * The maximum USD that may sit in LP given this NAV — `NAV × max_lp_ratio`.
 *
 * This is the number a build must be sized from. It is deliberately a *cap* rather than a target: the
 * user adds capital manually, so the bot never has to decide to deploy more, only to refuse to deploy too
 * much.
 */
export function lpBudgetUsd(navUsd: UsdAmount, limits: AllocationLimits): number {
  if (!Number.isFinite(navUsd) || navUsd <= 0) return 0;
  return navUsd * limits.maxLpRatio;
}

/** The reserve floor in USD — `NAV × reserve_ratio`. Never spent down automatically (§4). */
export function reserveFloorUsd(navUsd: UsdAmount, limits: AllocationLimits): number {
  if (!Number.isFinite(navUsd) || navUsd <= 0) return 0;
  return navUsd * limits.reserveRatio;
}

/**
 * May this build proceed, and for how much?
 *
 * `requestedUsd` is the LP capital the caller intends to commit. The check is that the **resulting**
 * allocation stays inside the bands — not merely that the request is below the cap, which would let two
 * successive builds each pass individually while together breaching the ratio.
 */
export function checkBuildAllocation(params: {
  readonly navUsd: UsdAmount;
  readonly currentLpValueUsd: UsdAmount;
  readonly requestedUsd: UsdAmount;
  readonly limits: AllocationLimits;
}): AllocationCheck {
  const { navUsd, currentLpValueUsd, requestedUsd, limits } = params;

  if (!Number.isFinite(navUsd) || navUsd <= 0) {
    return {
      ok: false,
      refusal: ALLOCATION_REFUSALS.NAV_UNUSABLE,
      reason: `NAV is ${String(navUsd)}; an allocation cannot be computed from an unusable NAV (§96)`,
    };
  }
  if (!Number.isFinite(requestedUsd) || requestedUsd <= 0) {
    return {
      ok: false,
      refusal: ALLOCATION_REFUSALS.CAPITAL_NOT_POSITIVE,
      reason: `requested LP capital is ${String(requestedUsd)}; nothing to allocate`,
    };
  }

  const cap = lpBudgetUsd(navUsd, limits);
  const resultingLp = currentLpValueUsd + requestedUsd;
  if (resultingLp > cap * (1 + 1e-9)) {
    return {
      ok: false,
      refusal: ALLOCATION_REFUSALS.LP_EXCEEDS_MAX,
      reason:
        `LP would become ${usd(resultingLp)} of a ${usd(navUsd)} NAV ` +
        `(${((resultingLp / navUsd) * 100).toFixed(2)}%), exceeding max_lp_ratio ` +
        `${(limits.maxLpRatio * 100).toFixed(2)}% (${usd(cap)})`,
    };
  }

  // The reserve is what is left of NAV once LP is committed. Computed against the RESULTING state, so a
  // sequence of builds cannot walk the reserve below its floor one compliant step at a time.
  const resultingReserve = navUsd - resultingLp;
  const floor = reserveFloorUsd(navUsd, limits);
  if (resultingReserve < floor * (1 - 1e-9)) {
    return {
      ok: false,
      refusal: ALLOCATION_REFUSALS.RESERVE_BELOW_MIN,
      reason:
        `reserve would become ${usd(resultingReserve)} of a ${usd(navUsd)} NAV ` +
        `(${((resultingReserve / navUsd) * 100).toFixed(2)}%), below reserve_ratio ` +
        `${(limits.reserveRatio * 100).toFixed(2)}% (${usd(floor)})`,
    };
  }

  return { ok: true };
}

/** One band's outcome after the fact, evaluated on OBSERVED balances rather than on intent. */
export interface AllocationObservation {
  readonly ratio: Ratio;
  readonly target: Ratio;
  readonly withinBand: boolean;
  readonly note: string;
}

export interface AllocationVerification {
  readonly ok: boolean;
  readonly lp: AllocationObservation;
  readonly reserve: AllocationObservation;
  readonly problems: readonly string[];
}

/**
 * Verify the allocation a portfolio snapshot actually shows (§3/§60).
 *
 * Asymmetric on purpose, matching the limits:
 *   - LP **above** `max_lp_ratio` → violation. The whole point of the cap.
 *   - reserve **below** `reserve_ratio` → violation (§60 additionally blocks new LP at a stricter level).
 *   - LP below its cap, or reserve above its target → fine. Un-deployed capital is not a fault, and §4
 *     forbids deploying it automatically.
 */
export function verifyPostAllocation(params: {
  readonly navUsd: UsdAmount;
  readonly lpValueUsd: UsdAmount;
  readonly reserveUsd: UsdAmount;
  readonly limits: AllocationLimits;
}): AllocationVerification {
  const { navUsd, lpValueUsd, reserveUsd, limits } = params;
  const problems: string[] = [];

  if (!Number.isFinite(navUsd) || navUsd <= 0) {
    const unusable = (target: Ratio): AllocationObservation => ({
      ratio: 0,
      target,
      withinBand: false,
      note: 'NAV unusable — the ratio cannot be judged (§96)',
    });
    return {
      ok: false,
      lp: unusable(limits.maxLpRatio),
      reserve: unusable(limits.reserveRatio),
      problems: [`NAV is ${String(navUsd)}; allocation cannot be verified`],
    };
  }

  const lpRatio = lpValueUsd / navUsd;
  const reserveRatio = reserveUsd / navUsd;
  const lpWithin = lpRatio <= limits.maxLpRatio * (1 + 1e-9);
  const reserveWithin = reserveRatio >= limits.reserveRatio * (1 - 1e-9);

  if (!lpWithin) {
    problems.push(
      `LP allocation ${(lpRatio * 100).toFixed(2)}% exceeds max_lp_ratio ` +
        `${(limits.maxLpRatio * 100).toFixed(2)}%`,
    );
  }
  if (!reserveWithin) {
    problems.push(
      `reserve ${(reserveRatio * 100).toFixed(2)}% is below reserve_ratio ` +
        `${(limits.reserveRatio * 100).toFixed(2)}% (§60 blocks new LP below 25%)`,
    );
  }

  return {
    ok: lpWithin && reserveWithin,
    lp: {
      ratio: lpRatio,
      target: limits.maxLpRatio,
      withinBand: lpWithin,
      note: lpWithin
        ? lpRatio < limits.maxLpRatio
          ? `below the cap: ${usd(lpBudgetUsd(navUsd, limits) - lpValueUsd)} of headroom (not auto-deployed, §68)`
          : 'exactly at the cap'
        : 'OVER the cap',
    },
    reserve: {
      ratio: reserveRatio,
      target: limits.reserveRatio,
      withinBand: reserveWithin,
      note: reserveWithin ? 'at or above the floor' : 'BELOW the floor',
    },
    problems,
  };
}
