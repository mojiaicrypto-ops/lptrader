import { describe, expect, it } from 'vitest';
import { buildDrawdownState, buildPortfolioSnapshot, computeBenchmarkMetrics } from '../../src/strategy/nav.ts';
import { createBuiltinRegistry } from '../../src/config/registry.ts';
import { BSC_ADDRESSES, BSC_BSTOCKS } from '../../src/config/builtins.ts';
import type { PortfolioSnapshot } from '../../src/types/portfolio.ts';
import type { TokenAmount } from '../../src/types/token.ts';
import type { TokenId } from '../../src/types/primitives.ts';
import { fromFloat } from '../../src/util/decimal.ts';

const CHAIN = 56;
const NOW = '2026-09-29T12:00:00.000Z';
const WALLET = '0x1111111111111111111111111111111111111111' as const;

const registry = createBuiltinRegistry();

const USDC = registry.requireTokenByAddress(CHAIN, BSC_ADDRESSES.USDC);
// Address lookup, not symbol: the registry has no symbol->token path by design (§8).
const QQQB_ADDRESS = BSC_BSTOCKS.find((token) => token.symbol === 'QQQB')!.address;
const QQQB = registry.requireTokenByAddress(CHAIN, QQQB_ADDRESS);

/** `plain` token amount: ui === raw. */
function amount(tokenId: TokenId, address: `0x${string}`, decimals: number, whole: number): TokenAmount {
  const raw = fromFloat(whole, decimals);
  return { tokenId, address, decimals, raw, ui: raw, uiMultiplier: 10n ** 18n };
}

const usdc = (whole: number) => amount(USDC.id, USDC.address, USDC.decimals, whole);
const qqqb = (whole: number) => amount(QQQB.id, QQQB.address, QQQB.decimals, whole);
const zero = (meta: typeof USDC) => amount(meta.id, meta.address, meta.decimals, 0);

const PRICES = new Map<TokenId, number>([
  [USDC.id, 1],
  [QQQB.id, 740],
]);

/** §3 shape at entry: 3,000 stablecoin reserve + 7,000 in LP. */
function baseInputs(overrides: Record<string, unknown> = {}) {
  return {
    chainId: CHAIN,
    walletAddress: WALLET,
    timestamp: NOW,
    registry,
    prices: PRICES,
    walletBalances: [usdc(3_000)],
    nativeBalanceWei: 0n,
    lpToken0: zero(USDC),
    lpToken1: zero(QQQB),
    unclaimedFeeToken0: zero(USDC),
    unclaimedFeeToken1: zero(QQQB),
    realizedFees: 0,
    gasCost: 0,
    swapCost: 0,
    slippageCost: 0,
    initialNAV: 10_000,
    reserveRatio: 0.3,
    priorPeakNAV: null,
    benchmark: null,
    ...overrides,
  };
}

describe('buildPortfolioSnapshot (§5 NAV)', () => {
  it('sums wallet, LP legs and unclaimed fees', () => {
    const { snapshot } = buildPortfolioSnapshot(
      baseInputs({
        // 3,000 stablecoin + 4,000 in LP as 2,000 USDC + 2.703 QQQB (~2,000 USD)
        walletBalances: [usdc(3_000)],
        lpToken0: usdc(2_000),
        lpToken1: qqqb(2_000 / 740),
        unclaimedFeeToken0: usdc(50),
        unclaimedFeeToken1: zero(QQQB),
      }),
    );

    expect(snapshot.walletStablecoinValue).toBeCloseTo(3_000, 6);
    expect(snapshot.lpPositionValue).toBeCloseTo(4_000, 6);
    expect(snapshot.unclaimedFeeValue).toBeCloseTo(50, 6);
    expect(snapshot.totalNAV).toBeCloseTo(7_050, 6);
  });

  it('does NOT count realized fees a second time (they are already in the wallet reserve)', () => {
    // §64: Profit Vault = realised fees = walletStablecoin - principal. Adding realisedFees to NAV
    // would double count and push NAV above the §66 line, disabling the loss protection.
    const { snapshot } = buildPortfolioSnapshot(
      baseInputs({ walletBalances: [usdc(3_300)], realizedFees: 300 }),
    );
    expect(snapshot.totalNAV).toBeCloseTo(3_300, 6);
    expect(snapshot.realizedFees).toBe(300);
  });

  it('splits the reserve into §64 principal and profit vault', () => {
    const { snapshot } = buildPortfolioSnapshot(
      baseInputs({ walletBalances: [usdc(3_300)], realizedFees: 300 }),
    );
    expect(snapshot.reservePrincipal).toBeCloseTo(3_000, 6);
    expect(snapshot.profitVault).toBeCloseTo(300, 6);
  });

  it('never reports negative profit when the reserve is below principal', () => {
    const { snapshot } = buildPortfolioSnapshot(baseInputs({ walletBalances: [usdc(1_000)] }));
    expect(snapshot.reservePrincipal).toBeCloseTo(1_000, 6);
    expect(snapshot.profitVault).toBe(0);
  });

  it('classifies wallet holdings by token kind, not by symbol', () => {
    const { snapshot } = buildPortfolioSnapshot(
      baseInputs({ walletBalances: [usdc(1_000), qqqb(2)] }),
    );
    expect(snapshot.walletStablecoinValue).toBeCloseTo(1_000, 6);
    expect(snapshot.walletStockTokenValue).toBeCloseTo(1_480, 6);
  });

  it('reports unpriced non-zero holdings instead of silently valuing them at zero', () => {
    const { snapshot, unpricedTokens } = buildPortfolioSnapshot(
      baseInputs({ prices: new Map(), walletBalances: [usdc(1_000)] }),
    );
    expect(unpricedTokens).toContain(USDC.id);
    expect(snapshot.walletStablecoinValue).toBe(0);
  });

  it('ignores zero balances for pricing purposes', () => {
    const { unpricedTokens } = buildPortfolioSnapshot(
      baseInputs({ prices: new Map(), walletBalances: [zero(USDC)] }),
    );
    expect(unpricedTokens).toEqual([]);
  });

  it('computes lpAllocationRatio and reserveRatio against total NAV', () => {
    const { snapshot } = buildPortfolioSnapshot(
      baseInputs({ walletBalances: [usdc(3_000)], lpToken0: usdc(7_000) }),
    );
    expect(snapshot.lpAllocationRatio).toBeCloseTo(0.7, 6);
    expect(snapshot.reserveRatio).toBeCloseTo(0.3, 6);
    expect(snapshot.totalNAV).toBeCloseTo(10_000, 6);
  });

  it('prefers a position-manager override over the leg-by-leg estimate when provided', () => {
    const { snapshot } = buildPortfolioSnapshot(
      baseInputs({ lpToken0: usdc(2_000), lpToken1: qqqb(2), lpPositionValueOverride: 5_000 }),
    );
    expect(snapshot.lpPositionValue).toBe(5_000);
  });

  it('seeds peak NAV from the first snapshot and keeps it on the way down', () => {
    const rising = buildPortfolioSnapshot(baseInputs({ walletBalances: [usdc(12_000)] }));
    expect(rising.snapshot.peakNAV).toBeCloseTo(12_000, 6);

    const falling = buildPortfolioSnapshot(
      baseInputs({ walletBalances: [usdc(9_000)], priorPeakNAV: 12_000 }),
    );
    expect(falling.snapshot.peakNAV).toBeCloseTo(12_000, 6);
  });

  it('values the §6 benchmark from the entry mix, not the current mix', () => {
    const { snapshot } = buildPortfolioSnapshot(
      baseInputs({
        walletBalances: [usdc(3_000)],
        lpToken0: usdc(1_000),
        lpToken1: qqqb(1_000 / 740),
        benchmark: { token0: usdc(1_000), token1: qqqb(4_000 / 740) },
      }),
    );
    // Benchmark stayed 1,000 USDC + ~5.405 QQQB = 1,000 + 4,000
    expect(snapshot.benchmarkNAV).toBeCloseTo(5_000, 6);
  });

  it('handles a wholly empty portfolio without dividing by zero', () => {
    const { snapshot } = buildPortfolioSnapshot(baseInputs({ walletBalances: [zero(USDC)] }));
    expect(snapshot.totalNAV).toBe(0);
    expect(snapshot.lpAllocationRatio).toBe(0);
    expect(snapshot.reserveRatio).toBe(0);
    expect(snapshot.peakNAV).toBe(0);
  });
});

describe('buildDrawdownState (§65-§67)', () => {
  function snapshotAt(nav: number, initial = 10_000, peak = 10_000): PortfolioSnapshot {
    return {
      ...buildPortfolioSnapshot(baseInputs({ walletBalances: [usdc(nav)] })).snapshot,
      initialNAV: initial,
      peakNAV: peak,
      totalNAV: nav,
    };
  }

  it('triggers exactly ON the risk line, not only below it (§66 uses <=)', () => {
    const state = buildDrawdownState(snapshotAt(8_500), 0.15, NOW, 300);
    expect(state.riskOffLineNAV).toBeCloseTo(8_500, 6);
    expect(state.breached).toBe(true);
  });

  it('does not trigger one cent above the line', () => {
    expect(buildDrawdownState(snapshotAt(8_500.01), 0.15, NOW, 300).breached).toBe(false);
  });

  it('triggers below the line', () => {
    expect(buildDrawdownState(snapshotAt(8_499.99), 0.15, NOW, 300).breached).toBe(true);
  });

  it('recomputes the line for a different maxDrawdown', () => {
    const state = buildDrawdownState(snapshotAt(9_000), 0.1, NOW, 300);
    expect(state.riskOffLineNAV).toBeCloseTo(9_000, 6);
    expect(state.breached).toBe(true);
  });

  it('reports both drawdown measures', () => {
    const state = buildDrawdownState(snapshotAt(9_000, 10_000, 12_000), 0.15, NOW, 300);
    expect(state.drawdownFromInitial).toBeCloseTo(0.1, 6);
    expect(state.drawdownFromPeak).toBeCloseTo(0.25, 6);
  });

  it('carries the observation window so a recorded drawdown is self-describing', () => {
    expect(buildDrawdownState(snapshotAt(9_000), 0.15, NOW, 300).windowSeconds).toBe(300);
  });

  it('rejects an out-of-range maxDrawdown instead of guessing', () => {
    expect(() => buildDrawdownState(snapshotAt(9_000), 0, NOW, 300)).toThrow(/out of range/);
    expect(() => buildDrawdownState(snapshotAt(9_000), 1, NOW, 300)).toThrow(/out of range/);
  });

  it('rejects a non-positive observation window', () => {
    expect(() => buildDrawdownState(snapshotAt(9_000), 0.15, NOW, 0)).toThrow(/out of range/);
  });
});

describe('computeBenchmarkMetrics (§6/§7/§90)', () => {
  function snap(over: Partial<PortfolioSnapshot>): PortfolioSnapshot {
    return { ...buildPortfolioSnapshot(baseInputs()).snapshot, ...over };
  }

  it('computes IL as benchmark minus LP value', () => {
    const m = computeBenchmarkMetrics({
      snapshot: snap({ lpPositionValue: 4_500, benchmarkNAV: 5_000, totalNAV: 7_500 }),
      accumulatedFeesUsd: 300,
    });
    expect(m.impermanentLossUsd).toBeCloseTo(500, 6);
    expect(m.lpAlphaUsd).toBeCloseTo(2_500, 6);
  });

  it('computes the §7 fee/IL ratio and its health band', () => {
    const healthy = computeBenchmarkMetrics({
      snapshot: snap({ lpPositionValue: 4_500, benchmarkNAV: 5_000 }),
      accumulatedFeesUsd: 1_200,
    });
    expect(healthy.feeIlRatio).toBeCloseTo(2.4, 6);
    expect(healthy.feeIlHealth).toBe('healthy');

    const acceptable = computeBenchmarkMetrics({
      snapshot: snap({ lpPositionValue: 4_500, benchmarkNAV: 5_000 }),
      accumulatedFeesUsd: 750,
    });
    expect(acceptable.feeIlHealth).toBe('acceptable');

    const warning = computeBenchmarkMetrics({
      snapshot: snap({ lpPositionValue: 4_500, benchmarkNAV: 5_000 }),
      accumulatedFeesUsd: 400,
    });
    expect(warning.feeIlHealth).toBe('warning');
  });

  it('treats exactly 2.0 as acceptable and exactly 1.0 as acceptable (§7 bands are exclusive at the top)', () => {
    const two = computeBenchmarkMetrics({
      snapshot: snap({ lpPositionValue: 4_500, benchmarkNAV: 5_000 }),
      accumulatedFeesUsd: 1_000,
    });
    expect(two.feeIlHealth).toBe('acceptable');

    const one = computeBenchmarkMetrics({
      snapshot: snap({ lpPositionValue: 4_500, benchmarkNAV: 5_000 }),
      accumulatedFeesUsd: 500,
    });
    expect(one.feeIlHealth).toBe('acceptable');
  });

  it('returns null ratio (not Infinity) when there is no IL yet', () => {
    const m = computeBenchmarkMetrics({
      snapshot: snap({ lpPositionValue: 5_000, benchmarkNAV: 5_000 }),
      accumulatedFeesUsd: 100,
    });
    expect(m.feeIlRatio).toBeNull();
    expect(m.feeIlHealth).toBe('unknown');
  });

  it('uses the IL magnitude so a favourable divergence cannot flip the ratio sign', () => {
    // LP outperformed the hold: IL is negative. Dividing by the signed value would give a negative
    // ratio and make a healthy position look like a loss.
    const m = computeBenchmarkMetrics({
      snapshot: snap({ lpPositionValue: 5_500, benchmarkNAV: 5_000 }),
      accumulatedFeesUsd: 300,
    });
    expect(m.impermanentLossUsd).toBeCloseTo(-500, 6);
    expect(m.feeIlRatio).toBeCloseTo(0.6, 6);
    expect(m.feeIlRatio).toBeGreaterThan(0);
  });
});
