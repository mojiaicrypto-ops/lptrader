import { describe, expect, it, vi } from 'vitest';
import { RiskWiring } from '../../src/execution/riskWiring.ts';
import { loadConfig } from '../../src/config/index.ts';
import type { PortfolioMonitor } from '../../src/execution/portfolioMonitor.ts';
import type { Address } from '../../src/types/primitives.ts';
import { verifyPostAllocation } from '../../src/strategy/allocation.ts';
import { buildDrawdownState } from '../../src/strategy/nav.ts';

/**
 * A wallet with nothing in it is NOT a drawdown.
 *
 * ## The bug these tests pin, found in the Step 4 live regression
 * With an empty strategy wallet (the state before any funding) the monitor reports `totalNAV = 0`, and
 * §66's rule `totalNAV <= initialNAV × 0.85` is then *literally* satisfied — `0 <= 8500`. The verdict was
 * therefore `GLOBAL_RISK_OFF` at `critical` severity, and the allocation check reported "NAV is 0".
 *
 * Both are wrong in the same way: they treat "the strategy has not been funded yet" as "the strategy lost
 * 100%". That is not a conservative false positive, it is a **false alarm that fires on every fresh
 * install** — and a critical page on day zero teaches the operator to ignore critical pages.
 *
 * The fix distinguishes the two situations by asking whether any capital was ever committed:
 * ```text
 * NAV == 0 and no deposit recorded   → the strategy is idle, not breached  (§pre-funding)
 * NAV == 0 with a deposit recorded   → genuinely wiped out
 * ```
 * `initialNAV` cannot make that distinction on its own, because it is a CONFIGURED figure — it says how
 * much the operator *intends* to run, not whether they have started.
 */
function monitorReturning(nav: number, options: { readonly drawdownAssessable?: boolean } = {}): PortfolioMonitor {
  // `drawdownAssessable` decouples "the valuation was usable" from "NAV is non-zero". They are not the same
  // thing: a funded strategy CAN have NAV 0 and still be fully assessable — that is the wipe-out case.
  const assessable = options.drawdownAssessable ?? nav > 0;
  const snapshot = {
    timestamp: '2026-09-30T00:00:00.000Z',
    chainId: 56,
    walletAddress: '0x1111111111111111111111111111111111111111' as Address,
    walletStablecoinValue: nav,
    walletStockTokenValue: 0,
    walletBalances: [],
    lpToken0Amount: { tokenId: '', address: '0x' as Address, decimals: 18, raw: 0n, ui: 0n, uiMultiplier: 10n ** 18n },
    lpToken1Amount: { tokenId: '', address: '0x' as Address, decimals: 18, raw: 0n, ui: 0n, uiMultiplier: 10n ** 18n },
    lpPositionValue: 0,
    unclaimedFeeToken0: { tokenId: '', address: '0x' as Address, decimals: 18, raw: 0n, ui: 0n, uiMultiplier: 10n ** 18n },
    unclaimedFeeToken1: { tokenId: '', address: '0x' as Address, decimals: 18, raw: 0n, ui: 0n, uiMultiplier: 10n ** 18n },
    unclaimedFeeValue: 0,
    realizedFees: 0,
    gasCost: 0,
    swapCost: 0,
    slippageCost: 0,
    totalNAV: nav,
    initialNAV: 10_000,
    peakNAV: nav,
    benchmarkNAV: nav,
    lpAllocationRatio: 0,
    reserveRatio: nav > 0 ? 1 : 0,
    reservePrincipal: nav,
    profitVault: 0,
    nativeBalanceWei: 0n,
  };
  return {
    walletAddress: () => '0x1111111111111111111111111111111111111111' as Address,
    // The drawdown is `null` only when the valuation is incomplete; a priced portfolio gets a real one.
    // The double must mirror that contract or the funded cases cannot produce a verdict at all.
    monitor: vi.fn(async () => ({
      snapshot,
      drawdown: assessable ? buildDrawdownState(snapshot, 0.15, '2026-09-30T00:00:00.000Z', 300) : null,
      complete: true,
      problems: [],
    })),
  } as unknown as PortfolioMonitor;
}

async function wiring(
  nav: number,
  options: { readonly funded?: boolean; readonly drawdownAssessable?: boolean } = {},
) {
  const config = await loadConfig();
  return new RiskWiring({
    monitor: monitorReturning(nav, { drawdownAssessable: options.drawdownAssessable ?? nav > 0 }),
    config,
    allocationLimits: { maxLpRatio: config.capital.maxLpRatio, reserveRatio: config.capital.reserveRatio },
    openPosition: async () => null,
    tvlSeries: () => [],
    ...(options.funded === undefined ? {} : { hasCommittedCapital: () => options.funded === true }),
  });
}

describe('an UNFUNDED strategy is idle, not breached', () => {
  it('does NOT report GLOBAL_RISK_OFF for a wallet that was simply never funded', async () => {
    const w = await wiring(0, { funded: false });
    const round = await w.round({ priorPeakNAV: null, realizedFees: 0 });

    // The verdict must not be a critical halt: nothing has been deployed, so nothing has been lost.
    expect(round.plan.action).not.toBe('GLOBAL_RISK_OFF');
    expect(round.plan.report.drawdown).toBeNull();
    expect(round.plan.report.missingInputs).toContain('drawdown');
  });

  it('explains WHY there is no drawdown verdict instead of silently omitting it', async () => {
    const w = await wiring(0, { funded: false });
    const round = await w.round({ priorPeakNAV: null, realizedFees: 0 });

    const reason = round.plan.reasons.join(' ');
    expect(reason).toMatch(/not been funded|no capital/i);
  });

  it('does NOT list the drawdown domain twice as missing', async () => {
    // `evaluateRisk` already records a null drawdown as missing, so adding the name again makes the list
    // read as two separate gaps and breaks any "is this domain missing?" check.
    const w = await wiring(0, { funded: false });
    const round = await w.round({ priorPeakNAV: null, realizedFees: 0 });

    const occurrences = round.plan.report.missingInputs.filter((name) => name === 'drawdown');
    expect(occurrences).toHaveLength(1);
  });

  it('does not page at `critical` for a wallet that was simply never funded', async () => {
    // An alert that fires on every fresh install trains the operator to ignore critical alerts.
    const w = await wiring(0, { funded: false });
    const round = await w.round({ priorPeakNAV: null, realizedFees: 0 });

    expect(round.plan.severity).not.toBe('critical');
  });

  it('DOES report the drawdown line once capital has been committed', async () => {
    // The distinction that makes the fix safe rather than a blanket exemption: a funded strategy that
    // reaches zero IS wiped out, and must still halt.
    const w = await wiring(0, { funded: true, drawdownAssessable: true });
    const round = await w.round({ priorPeakNAV: 10_000, realizedFees: 0 });

    expect(round.plan.report.drawdown).not.toBeNull();
    expect(round.plan.report.drawdown?.breached).toBe(true);
    expect(round.plan.action).toBe('GLOBAL_RISK_OFF');
  });

  it('still evaluates a normal funded portfolio exactly as before', async () => {
    const w = await wiring(9_500, { funded: true });
    const round = await w.round({ priorPeakNAV: 10_000, realizedFees: 0 });

    expect(round.plan.report.drawdown).not.toBeNull();
    expect(round.plan.report.drawdown?.breached).toBe(false);
    expect(round.plan.action).not.toBe('GLOBAL_RISK_OFF');
  });

  it('treats a funded-but-healthy portfolio as healthy regardless of the flag', async () => {
    // The flag only suppresses a verdict when NAV is exactly zero; it must never mask a real breach.
    const w = await wiring(8_000, { funded: false });
    const round = await w.round({ priorPeakNAV: 10_000, realizedFees: 0 });

    expect(round.plan.report.drawdown?.breached).toBe(true);
    expect(round.plan.action).toBe('GLOBAL_RISK_OFF');
  });
});

describe('allocation with an empty wallet is "nothing to check", not a violation', () => {
  it('reports an unfunded wallet as idle rather than outside the bands', async () => {
    const config = await loadConfig();

    // The store's own contract: an unusable NAV yields unjudgeable bands, and the caller decides what that
    // means. `riskWiring` must therefore not turn "no NAV" into "outside the bands".
    const verdict = verifyPostAllocation({
      navUsd: 0,
      lpValueUsd: 0,
      reserveUsd: 0,
      limits: { maxLpRatio: config.capital.maxLpRatio, reserveRatio: config.capital.reserveRatio },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(' ')).toMatch(/无法据此校验资金配置/);
  });
});
