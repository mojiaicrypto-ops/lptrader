import { describe, expect, it, vi } from 'vitest';
import { PortfolioMonitor } from '../../src/execution/portfolioMonitor.ts';
import { createBuiltinRegistry } from '../../src/config/registry.ts';
import { BSC_ADDRESSES, BSC_BSTOCKS, BSC_DEX_CONTRACTS, KNOWN_BSC_POOLS } from '../../src/config/builtins.ts';
import { createWhitelist } from '../../src/config/index.ts';
import type { ReferencePriceProvider, LpPositionView } from '../../src/types/adapters.ts';
import type { LpPositionRead } from '../../src/chain/positionReader.ts';
import type { PoolSnapshot, Sourced } from '../../src/types/market.ts';
import type { TokenAmount, TokenMeta } from '../../src/types/token.ts';
import { DEX_IDS, type Address, type TokenId } from '../../src/types/primitives.ts';
import { fromFloat } from '../../src/util/decimal.ts';

const CHAIN = 56;
const NOW = '2026-09-29T12:00:00.000Z';
const WALLET = '0x1111111111111111111111111111111111111111' as Address;

const registry = createBuiltinRegistry();
const whitelist = createWhitelist(
  registry.list(),
  [CHAIN],
  [
    { chainId: CHAIN, dex: DEX_IDS.PANCAKESWAP_V3 },
    { chainId: CHAIN, dex: DEX_IDS.UNISWAP_V3 },
  ],
);

const USDC = registry.requireTokenByAddress(CHAIN, BSC_ADDRESSES.USDC);
const QQQB_ADDRESS = BSC_BSTOCKS.find((token) => token.symbol === 'QQQB')!.address;
const QQQB = registry.requireTokenByAddress(CHAIN, QQQB_ADDRESS);
const POOL = KNOWN_BSC_POOLS[1];
if (POOL === undefined) throw new Error('expected the PancakeSwap QQQB pool to be a known pool');

/** QQQB has a live multiplier; USDC does not. The monitor must use each token's own value. */
const QQQB_MULTIPLIER = 1_000_724_838_657_573_033n;

function sourced<T>(value: T, stale = false): Sourced<T> {
  return { value, source: 'onchain', asOf: NOW, stale };
}

function poolSnapshot(over: Partial<PoolSnapshot> = {}): PoolSnapshot {
  return {
    timestamp: NOW,
    chainId: CHAIN,
    dex: POOL.dex,
    poolAddress: POOL.poolAddress as Address,
    poolId: `${CHAIN}:${POOL.dex}:${POOL.poolAddress}`,
    token0: QQQB.address,
    token1: USDC.address,
    token0Id: QQQB.id,
    token1Id: USDC.id,
    feeTier: POOL.feeTier,
    token0Decimals: QQQB.decimals,
    token1Decimals: USDC.decimals,
    tvlUSD: sourced(622_547),
    volume24h: sourced(6_560_000),
    volume7d: sourced(40_000_000),
    fees24h: sourced(656),
    fees7d: sourced(4_000),
    poolAgeDays: 81,
    createdAt: '2026-07-10T07:07:59.000Z',
    currentPrice: sourced(739.63),
    sqrtPriceX96: 2_154_702_184_312_214_094_591_448_544_382n,
    currentTick: 66_064,
    activeLiquidity: 1_556_463_151_563_366_171_503_721n,
    stockReferencePrice: sourced(738.84),
    tokenNAVDeviation: sourced(0.001),
    stockVolatility7d: sourced(0.02),
    stockVolatility30d: sourced(0.025),
    swapImpact1000USD: sourced(0.0002),
    swapImpact3500USD: sourced(0.0006),
    swapImpact5000USD: sourced(0.0009),
    estimatedAPR1d: sourced(0.2),
    estimatedAPR7d: sourced(0.2),
    estimatedAPR30d: sourced(0.2),
    marketDataSource: 'onchain',
    ...over,
  };
}

function position(over: Partial<LpPositionView> = {}): LpPositionRead {
  return {
    poolId: `${CHAIN}:${POOL.dex}:${POOL.poolAddress}`,
    positionTokenId: 4_242n,
    owner: WALLET,
    token0: QQQB.address,
    token1: USDC.address,
    feeTier: POOL.feeTier,
    tickLower: 63_888,
    tickUpper: 66_998,
    liquidity: 1_768_671_767_819_460_977_256n,
    feeGrowthInside0LastX128: 0n,
    feeGrowthInside1LastX128: 0n,
    tokensOwed0Raw: fromFloat(0.5, 18),
    tokensOwed1Raw: fromFloat(120, 18),
    // Provenance fields the reader adds; the monitor relies on them for the DEX/pool identity.
    chainId: CHAIN,
    dex: POOL.dex,
    positionManager: BSC_DEX_CONTRACTS[POOL.dex]!.positionManager as Address,
    confirmedOwner: WALLET,
    ...over,
  };
}

/** A reference provider whose answers the test dictates; every price/degradation case uses it. */
/**
 * A stock reference provider that also answers for stablecoins by default, so the many valuation tests
 * below exercise the SUCCESS path. The dedicated tests above set `stablecoin: null` to reproduce the
 * real composition, where the stock provider knows nothing about USDC.
 */
function referencePrices(
  options: { readonly stock?: number | null; readonly stablecoin?: number | null; readonly stale?: boolean } = {},
): ReferencePriceProvider {
  const stock = options.stock === undefined ? 738.84 : options.stock;
  const stable = options.stablecoin === undefined ? 1 : options.stablecoin;
  const stale = options.stale ?? false;
  return {
    getStockReferencePrice: async (tokenAddress: Address) =>
      tokenAddress.toLowerCase() === QQQB.address
        ? sourced(stock, stale)
        : sourced(stable, stale),
    getMarketStatus: async () => 'open',
    getLatestClose: async () => sourced(stock, stale),
    getIndicativePrice: async () => sourced(stock, stale),
  };
}

function amountOf(meta: { id: TokenId; address: Address; decimals: number }, raw: bigint, multiplier: bigint): TokenAmount {
  return {
    tokenId: meta.id,
    address: meta.address,
    decimals: meta.decimals,
    raw,
    ui: (raw * multiplier) / 10n ** 18n,
    uiMultiplier: multiplier,
  };
}

function monitorWith(
  overrides: {
    readonly referencePrice?: ReferencePriceProvider;
    readonly balances?: readonly TokenAmount[];
    readonly native?: bigint;
    readonly positions?: LpPositionView | null;
    readonly stablecoinPrice?: (token: TokenMeta) => Promise<Sourced<number | null>>;
  } = {},
) {
  const balances = overrides.balances ?? [amountOf(USDC, fromFloat(3_000, 18), 10n ** 18n)];
  const tokenReader = {
    getBalances: vi.fn(async () => balances),
  };
  const positionReader = {
    getPositionView: vi.fn(async () => overrides.positions ?? null),
  };
  const chain = {
    chainId: CHAIN,
    getSignerAddress: () => WALLET,
    getNativeBalance: vi.fn(async () => overrides.native ?? fromFloat(0.05, 18)),
  };
  const monitor = new PortfolioMonitor({
    chain: chain as never,
    tokenReader: tokenReader as never,
    positionReader: positionReader as never,
    referencePrice: overrides.referencePrice ?? referencePrices(),
    ...(overrides.stablecoinPrice === undefined
      ? {}
      : { stablecoinPrice: overrides.stablecoinPrice as never }),
    whitelist,
    maxDrawdown: 0.15,
    windowSeconds: 300,
  });
  return { monitor, tokenReader, positionReader, chain };
}

function inputs(over: Record<string, unknown> = {}) {
  return {
    walletAddress: WALLET,
    now: NOW,
    position: null,
    pool: null,
    benchmark: null,
    initialNAV: 10_000,
    reserveRatio: 0.3,
    priorPeakNAV: null,
    realizedFees: 0,
    gasCost: 0,
    swapCost: 0,
    slippageCost: 0,
    ...over,
  };
}

describe('PortfolioMonitor.walletAddress', () => {
  it('prefers the signer address so a read-only process cannot watch a different wallet', () => {
    const { monitor } = monitorWith();
    expect(monitor.walletAddress().toLowerCase()).toBe(WALLET);
  });

  it('falls back to the configured watch address when there is no signer', () => {
    const { monitor } = monitorWith();
    const readOnly = new PortfolioMonitor({
      chain: { chainId: CHAIN, getSignerAddress: () => null } as never,
      tokenReader: { getBalances: async () => [] } as never,
      positionReader: {} as never,
      referencePrice: referencePrices(),
      whitelist,
      maxDrawdown: 0.15,
      watchAddress: '0x2222222222222222222222222222222222222222',
    });
    expect(readOnly.walletAddress()).toBe('0x2222222222222222222222222222222222222222');
    // The signer-backed one still reports the signer.
    expect(monitor.walletAddress().toLowerCase()).toBe(WALLET);
  });

  it('refuses to guess an address when there is neither a signer nor a configured wallet', () => {
    const monitor = new PortfolioMonitor({
      chain: { chainId: CHAIN, getSignerAddress: () => null } as never,
      tokenReader: {} as never,
      positionReader: {} as never,
      referencePrice: referencePrices(),
      whitelist,
      maxDrawdown: 0.15,
    });
    expect(() => monitor.walletAddress()).toThrow(/no wallet to monitor/);
  });
});

describe('PortfolioMonitor price table', () => {
  it('prices each token from the reference provider rather than assuming 1.0 for stablecoins', async () => {
    const { monitor } = monitorWith({ referencePrice: referencePrices({ stablecoin: 0.985 }) });
    const { prices } = await monitor.buildPriceTable(null);
    expect(prices.get(USDC.id)).toBeCloseTo(0.985, 6);
    expect(prices.get(QQQB.id)).toBeCloseTo(738.84, 6);
  });

  it('reports a depegged stablecoin instead of hiding it behind a hardcoded 1.0', async () => {
    // 1.5% off the peg: the risk layer must be able to see this, so it cannot be normalised away here.
    const { monitor } = monitorWith({ referencePrice: referencePrices({ stablecoin: 0.985 }) });
    const result = await monitor.monitor(inputs());
    expect(result.snapshot.walletStablecoinValue).toBeCloseTo(2_955, 3);
  });

  it('falls back to the pool price for a stock leg with no usable reference, and says so', async () => {
    const { monitor } = monitorWith({ referencePrice: referencePrices({ stock: null }) });
    const { prices, problems } = await monitor.buildPriceTable(poolSnapshot());
    expect(prices.get(QQQB.id)).toBeCloseTo(739.63, 6);
    expect(problems.join(' ')).toMatch(/reference price unusable/);
  });

  it('refuses to invent a price for a stock leg that is not in the pool either', async () => {
    const { monitor } = monitorWith({ referencePrice: referencePrices({ stock: null }) });
    const { prices, problems } = await monitor.buildPriceTable(null);
    expect(prices.has(QQQB.id)).toBe(false);
    expect(problems.join(' ')).toMatch(/QQQB: no usable reference price/);
  });

  it('never falls back to a pool price for a stablecoin (a depeg must stay visible)', async () => {
    const { monitor } = monitorWith({ referencePrice: referencePrices({ stablecoin: null }) });
    const { prices, problems } = await monitor.buildPriceTable(poolSnapshot());
    expect(prices.has(USDC.id)).toBe(false);
    expect(problems.join(' ')).toMatch(/USDC: no usable reference price/);
  });
});

describe('PortfolioMonitor drawdown assessability (§65/§96)', () => {
  it('reports NO drawdown verdict when the valuation is incomplete', async () => {
    // The bug this pins (found in independent review): with an unpriced stablecoin the reserve valued to
    // zero, totalNAV collapsed to 0, and the §66 line reported `breached: true` for a HEALTHY portfolio —
    // the bot would have halted on a fabricated total loss. An incomplete valuation must yield `null`,
    // which is neither "safe" nor "breached", so no caller can act on it.
    const { monitor } = monitorWith({
      referencePrice: referencePrices({ stablecoin: null }),
      balances: [amountOf(USDC, fromFloat(3_000, 18), 10n ** 18n)],
    });
    const result = await monitor.monitor(inputs());

    expect(result.complete).toBe(false);
    expect(result.drawdown).toBeNull();
    // The snapshot is still produced (and its totalNAV is a floor), it just carries no verdict.
    expect(result.snapshot.totalNAV).toBe(0);
    expect(result.problems.join(' ')).toMatch(/USDC: no usable reference price/);
  });

  it('prices stablecoins from the dedicated source, not the stock reference provider', async () => {
    // A stablecoin price source is what makes the reserve count toward NAV at all.
    const { monitor } = monitorWith({
      referencePrice: referencePrices({ stablecoin: null }),
      stablecoinPrice: async () => sourced(0.9995),
      balances: [amountOf(USDC, fromFloat(3_000, 18), 10n ** 18n)],
    });
    const result = await monitor.monitor(inputs());

    expect(result.snapshot.walletStablecoinValue).toBeCloseTo(2_998.5, 3);
    // Complete valuation ⇒ a verdict IS produced. (A reserve-only 2,998 portfolio is genuinely below the
    // 8,500 line, so this asserts assessability, not safety — the point is that a priced portfolio gets a
    // real answer instead of `null`.)
    expect(result.complete).toBe(true);
    expect(result.drawdown).not.toBeNull();
  });

  it('never assumes a stablecoin is worth 1.0 when its own source is unavailable', async () => {
    // Assuming par is what would hide a stablecoin depeg (§58), so an unavailable stablecoin price must
    // degrade the valuation instead of silently normalising to 1.
    const { monitor } = monitorWith({
      referencePrice: referencePrices({ stablecoin: null }),
      stablecoinPrice: async () => sourced(null, true),
      balances: [amountOf(USDC, fromFloat(3_000, 18), 10n ** 18n)],
    });
    const result = await monitor.monitor(inputs());

    expect(result.complete).toBe(false);
    expect(result.snapshot.walletStablecoinValue).toBe(0);
    expect(result.drawdown).toBeNull();
  });

  it('still reports a genuine breach on a complete valuation', async () => {
    // Negative control: the assessability gate must not suppress a real drawdown.
    const { monitor } = monitorWith({
      stablecoinPrice: async () => sourced(1),
      balances: [amountOf(USDC, fromFloat(8_400, 18), 10n ** 18n)],
    });
    const result = await monitor.monitor(inputs({ priorPeakNAV: 10_000 }));

    expect(result.complete).toBe(true);
    expect(result.drawdown?.breached).toBe(true);
  });
});

describe('PortfolioMonitor valuation', () => {
  it('values a flat portfolio from the wallet alone and reports it complete', async () => {
    const { monitor } = monitorWith();
    const result = await monitor.monitor(inputs());

    expect(result.complete).toBe(true);
    expect(result.snapshot.totalNAV).toBeCloseTo(3_000, 6);
    expect(result.snapshot.reserveRatio).toBeCloseTo(1, 6);
    expect(result.snapshot.lpAllocationRatio).toBe(0);
  });

  it('marks a cycle as incomplete when a held balance has no price (§96)', async () => {
    // A held QQQB that cannot be priced must set complete=false rather than contribute zero.
    const { monitor } = monitorWith({
      referencePrice: referencePrices({ stock: null }),
      balances: [amountOf(USDC, fromFloat(1_000, 18), 10n ** 18n), amountOf(QQQB, fromFloat(2, 18), QQQB_MULTIPLIER)],
    });
    const result = await monitor.monitor(inputs({ pool: null }));

    expect(result.complete).toBe(false);
    expect(result.problems.join(' ')).toMatch(/QQQB/);
  });

  it('uses each token\u2019s own uiMultiplier for the LP legs, never a hardcoded 1e18', async () => {
    // The wallet batch carries the live multiplier; the fee leg must reuse exactly that value, so a
    // bStock fee reported at 1e18 would be ~0.07% short.
    const { monitor } = monitorWith({
      balances: [amountOf(USDC, fromFloat(3_000, 18), 10n ** 18n), amountOf(QQQB, 0n, QQQB_MULTIPLIER)],
    });
    const result = await monitor.monitor(
      inputs({ pool: poolSnapshot(), position: position() }),
    );

    const owed = result.snapshot.unclaimedFeeToken0;
    expect(owed.uiMultiplier).toBe(QQQB_MULTIPLIER);
    expect(owed.ui).toBe((owed.raw * QQQB_MULTIPLIER) / 10n ** 18n);
    // ...and it is NOT the naive raw*1e18 value.
    expect(owed.ui).not.toBe(owed.raw);
  });

  it('counts unclaimed fees in NAV (§5) — they are not left out of the portfolio value', async () => {
    const { monitor } = monitorWith({
      balances: [amountOf(USDC, fromFloat(1_000, 18), 10n ** 18n)],
    });
    const withFees = await monitor.monitor(inputs({ pool: poolSnapshot(), position: position() }));
    const withoutFees = await monitor.monitor(
      inputs({ pool: poolSnapshot(), position: position({ tokensOwed0Raw: 0n, tokensOwed1Raw: 0n }) }),
    );

    // Valued at the REFERENCE price (738.84), not the pool price: unclaimed fees are money owed, and
    // the reference NAV is what prices the stock leg everywhere else in the valuation.
    expect(withFees.snapshot.unclaimedFeeValue).toBeCloseTo(0.5 * 738.84 + 120, 2);
    expect(withoutFees.snapshot.unclaimedFeeValue).toBe(0);
  });

  it('distinguishes "cannot value the LP" from "flat" (§96)', async () => {
    // A position with liquidity but no pool price must not read as an empty position.
    const { monitor } = monitorWith();
    const priceTable = new Map();
    expect(monitor.lpPositionValue(position(), null, priceTable)).toBeNull();
    expect(monitor.lpPositionValue(null, null, priceTable)).toBe(0);
    expect(monitor.lpPositionValue(position({ liquidity: 0n }), poolSnapshot(), priceTable)).toBe(0);
  });

  it('treats the position-manager override as authoritative for LP value', async () => {
    const { monitor } = monitorWith();
    const result = await monitor.monitor(inputs({ pool: poolSnapshot(), position: position() }));
    // The value comes from the §37 math at the live tick, so it must be positive and finite.
    expect(result.snapshot.lpPositionValue).toBeGreaterThan(0);
    expect(Number.isFinite(result.snapshot.lpPositionValue)).toBe(true);
  });

  it('derives the §65 drawdown from the same NAV it reports', async () => {
    const { monitor } = monitorWith({
      balances: [amountOf(USDC, fromFloat(8_400, 18), 10n ** 18n)],
    });
    const result = await monitor.monitor(inputs({ priorPeakNAV: 10_000 }));

    expect(result.drawdown).not.toBeNull();
    expect(result.drawdown?.riskOffLineNAV).toBeCloseTo(8_500, 6);
    // 8,400 is below the §66 line, so the strategy must stop.
    expect(result.drawdown?.breached).toBe(true);
    expect(result.drawdown?.windowSeconds).toBe(300);
  });

  it('reports peak NAV as a high-water mark so a recovery does not re-arm the risk line', async () => {
    const { monitor } = monitorWith({
      balances: [amountOf(USDC, fromFloat(9_500, 18), 10n ** 18n)],
    });
    const result = await monitor.monitor(inputs({ priorPeakNAV: 12_000 }));
    expect(result.snapshot.peakNAV).toBeCloseTo(12_000, 6);
  });
});
