/**
 * §6.4 rebuild policy: may the bot re-open a position immediately after closing one?
 *
 * ## Why this is not the §28–§32 switching rules
 *
 * The baseline's switching gates (`new APR ≥ current + 8pp`, `breakEven ≤ 14 days`, 7-day cooldown) exist
 * to stop the BOT from churning on its own initiative — they are a restraint on autonomous trading.
 *
 * A manual `/exit` is a different thing entirely: the operator has decided. Applying those gates here
 * would let the software overrule its owner, and would also make `/exit` unusable in exactly the case it
 * exists for — the operator sees a problem the rules do not model. §32 says so explicitly: risk events are
 * exempt from the cooldown.
 *
 * What DOES apply is the cost ceiling. Closing and immediately re-opening pays two swaps, two gas fees and
 * the realized IL; if that round-trip costs more than the position is worth relative to its size, the
 * honest answer is "flat is better than churning" — which is a fact about cost, not a policy preference
 * imposed on the operator.
 *
 * ## The asymmetry, stated plainly
 *
 * A manual exit is ALWAYS allowed. Only the automatic REBUILD is gated. Refusing the exit itself would
 * trap capital in a position the operator wants out of, which is strictly worse than whatever the
 * round-trip costs.
 */
import type { Ratio, UsdAmount, IsoTimestamp } from '../types/primitives.ts';
import type { SwitchConfig } from '../types/config.ts';

export interface RebuildRequest {
  /** Value being redeployed, i.e. what came back from the exit. */
  readonly proceedsUsd: UsdAmount;
  /** §30 estimate: swaps + gas + realized IL for closing and re-opening. */
  readonly roundTripCostUsd: UsdAmount;
  readonly now: IsoTimestamp;
  /** When the previous position was closed, for the cooldown check. `null` when unknown. */
  readonly lastSwitchAt?: IsoTimestamp | null;
  /**
   * True when the exit was forced by a risk condition (§55/§58/§59/§66).
   *
   * Risk events bypass the cooldown entirely (§32) — the position is being closed BECAUSE holding it is
   * unsafe, and waiting seven days to redeploy would leave the capital idle for no reason.
   */
  readonly riskDriven?: boolean;
}

export interface RebuildDecision {
  readonly allowed: boolean;
  readonly reason: string;
  /** §30 as a fraction of proceeds, so the operator can see the comparison rather than the verdict alone. */
  readonly costRatio: Ratio;
}

/**
 * Decide whether the automatic rebuild may proceed.
 *
 * Returns `allowed: true` with a reason in the ordinary case, so the caller can log why it proceeded and
 * not only why it refused.
 */
export function decideRebuild(
  request: RebuildRequest,
  config: SwitchConfig,
): RebuildDecision {
  if (request.proceedsUsd <= 0) {
    return {
      allowed: false,
      reason: 'nothing came back from the exit, so there is no capital to redeploy',
      costRatio: 0,
    };
  }

  const costRatio = request.roundTripCostUsd / request.proceedsUsd;

  // §32: a risk-driven exit is exempt. Checked BEFORE the cooldown so a forced exit is never held back by
  // a timer that is measuring a completely different (yield-chasing) behaviour.
  if (request.riskDriven !== true && request.lastSwitchAt != null) {
    const elapsedDays = (Date.parse(request.now) - Date.parse(request.lastSwitchAt)) / 86_400_000;
    if (elapsedDays < config.cooldownDays) {
      return {
        allowed: false,
        costRatio,
        reason:
          `a position was opened ${elapsedDays.toFixed(1)} days ago and the cooldown is ` +
          `${config.cooldownDays} days. This is the anti-churn rule, not a judgement on the pool — ` +
          'send /start to build anyway.',
      };
    }
  }

  if (costRatio > config.maxSwitchCostRatio) {
    return {
      allowed: false,
      costRatio,
      reason:
        `re-opening would cost ${(costRatio * 100).toFixed(2)}% of the proceeds ` +
        `(${request.roundTripCostUsd.toFixed(2)} of ${request.proceedsUsd.toFixed(2)}), above the ` +
        `${(config.maxSwitchCostRatio * 100).toFixed(2)}% ceiling. Staying flat preserves more value than ` +
        'the round trip would. Send /start to override.',
    };
  }

  return {
    allowed: true,
    costRatio,
    reason:
      `round-trip cost is ${(costRatio * 100).toFixed(2)}% of the proceeds, within the ` +
      `${(config.maxSwitchCostRatio * 100).toFixed(2)}% ceiling`,
  };
}
