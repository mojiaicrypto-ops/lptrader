import { describe, expect, it } from 'vitest';
import { evaluatePoolContribution, RISK_ACTIONS } from '../../src/strategy/riskManager.ts';
import { loadConfig } from '../../src/config/index.ts';

async function config() {
  return loadConfig();
}

describe('evaluatePoolContribution: the pool\'s own result, once it persists', () => {
  it('reports RISK_REVIEW when the pool has cost money for the required rounds', async () => {
    // The rule this exists for: the position earns less than simply holding the same tokens, and it has
    // done so long enough that it is not one noisy reading.
    const verdict = evaluatePoolContribution({ contributionUsd: -250, rounds: 6 }, await config());
    expect(verdict.action).toBe(RISK_ACTIONS.RISK_REVIEW);
    expect(verdict.persistent).toBe(true);
    expect(verdict.reason).toMatch(/cost \$250\.00/);
    expect(verdict.reason).toMatch(/6 consecutive rounds/);
  });

  it('holds when the negative has NOT persisted long enough', async () => {
    // Without persistence, a single block-to-block wobble would trigger an exit — and the round trip
    // itself costs money, which is what the operator is trying to avoid.
    const verdict = evaluatePoolContribution({ contributionUsd: -250, rounds: 2 }, await config());
    expect(verdict.action).toBe(RISK_ACTIONS.HOLD);
    expect(verdict.persistent).toBe(false);
    expect(verdict.reason).toMatch(/2 of 6 required rounds/);
  });

  it('holds when the pool is contributing positively', async () => {
    const verdict = evaluatePoolContribution({ contributionUsd: 120, rounds: 0 }, await config());
    expect(verdict.action).toBe(RISK_ACTIONS.HOLD);
    expect(verdict.reason).toMatch(/contributed \$120\.00/);
  });

  it('ignores a negative below the configured floor', async () => {
    const verdict = evaluatePoolContribution({ contributionUsd: -0.4, rounds: 99 }, await config());
    expect(verdict.action).toBe(RISK_ACTIONS.HOLD);
    expect(verdict.persistent).toBe(false);
  });

  it('reports insufficient-data — NOT ok — when the contribution cannot be measured', async () => {
    // An unmeasurable contribution is not a healthy one. Reporting `ok` here would let a missing entry
    // baseline read as a clean bill of health, which is the class of bug this project keeps fixing.
    const verdict = evaluatePoolContribution({ contributionUsd: null, rounds: 0 }, await config());
    expect(verdict.status).toBe('insufficient-data');
    expect(verdict.action).toBe(RISK_ACTIONS.HOLD);
    expect(verdict.reason).toMatch(/could not be measured/);
  });

  it('never escalates to an automatic exit', async () => {
    // §67's automatic exit is reserved for conditions where waiting for a human is itself the risk. A
    // pool being unprofitable is a judgement call: the operator may prefer to wait for fees to accrue or
    // for the price to return to range.
    const verdict = evaluatePoolContribution({ contributionUsd: -9_999, rounds: 100 }, await config());
    expect(verdict.action).toBe(RISK_ACTIONS.RISK_REVIEW);
    expect(verdict.action).not.toBe(RISK_ACTIONS.EMERGENCY_EXIT);
  });
});
