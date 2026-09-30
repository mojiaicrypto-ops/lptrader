import { describe, expect, it, vi } from 'vitest';
import { FundingPlanner, conversionKey, describeConversion } from '../../src/strategy/funding.ts';
import type { PoolSnapshot } from '../../src/types/market.ts';
import type { Address } from '../../src/types/primitives.ts';
import type { TokenMeta } from '../../src/types/token.ts';

const NOW = '2026-10-01T00:00:00.000Z';
const QQQB = '0x1111111111111111111111111111111111111111' as Address;
const USDT = '0x5555555555555555555555555555555555555555' as Address;
const USDC = '0x2222222222222222222222222222222222222222' as Address;

function meta(address: Address, symbol: string, priority?: number): TokenMeta {
  return {
    id: `56:${address}`,
    chainId: 56,
    address,
    kind: symbol === 'QQQB' ? 'bstocks' : 'stablecoin',
    decimals: 18,
    symbol,
    riskTier: 'CORE',
    autoTrade: true,
    isStockToken: symbol === 'QQQB',
    uiAmount: { mode: 'bep677-scaled', multiplierDecimals: 18 },
    ...(priority === undefined ? {} : { stablecoinPriority: priority }),
  };
}

/** A pool quoting in `quoteToken`. */
function pool(quoteToken: Address): PoolSnapshot {
  return {
    timestamp: NOW,
    chainId: 56,
    dex: 'pancakeswap-v3',
    poolAddress: '0xe531fcb1f5a195de7608b9f4f9518544c2cdb693' as Address,
    poolId: '56:pancakeswap-v3:0xe531fcb1f5a195de7608b9f4f9518544c2cdb693',
    token0: QQQB,
    token1: quoteToken,
    token0Id: `56:${QQQB}`,
    token1Id: `56:${quoteToken}`,
    feeTier: 100,
    token0Decimals: 18,
    token1Decimals: 18,
    tvlUSD: { value: 620_000, source: 'geckoterminal', asOf: NOW, stale: false },
    volume24h: { value: 6_300_000, source: 'geckoterminal', asOf: NOW, stale: false },
    volume7d: { value: 35_500_000, source: 'geckoterminal', asOf: NOW, stale: false },
    fees24h: { value: 630, source: 'derived', asOf: NOW, stale: false },
    fees7d: { value: 3_550, source: 'derived', asOf: NOW, stale: false },
    poolAgeDays: 81,
    currentPrice: { value: 738, source: 'geckoterminal', asOf: NOW, stale: false },
    sqrtPriceX96: 0n,
    currentTick: 0,
    activeLiquidity: 0n,
    stockReferencePrice: { value: 738, source: 'binance-index', asOf: NOW, stale: false },
    tokenNAVDeviation: { value: 0.001, source: 'onchain', asOf: NOW, stale: false },
    stockVolatility7d: { value: 0.02, source: 'binance-index', asOf: NOW, stale: false },
    stockVolatility30d: { value: 0.025, source: 'binance-index', asOf: NOW, stale: false },
    swapImpact1000USD: { value: 0.0001, source: 'onchain', asOf: NOW, stale: false },
    swapImpact3500USD: { value: 0.0005, source: 'onchain', asOf: NOW, stale: false },
    swapImpact5000USD: { value: 0.0008, source: 'onchain', asOf: NOW, stale: false },
    estimatedAPR1d: { value: 0.2, source: 'derived', asOf: NOW, stale: false },
    estimatedAPR7d: { value: 0.2, source: 'derived', asOf: NOW, stale: false },
    estimatedAPR30d: { value: 0.2, source: 'derived', asOf: NOW, stale: false },
    marketDataSource: 'geckoterminal',
  };
}

const E18 = 10n ** 18n;

function harness(balances: Readonly<Record<string, bigint>>) {
  const balanceOf = vi.fn(async (token: Address) => balances[token.toLowerCase()] ?? balances[token] ?? 0n);
  const planner = new FundingPlanner({
    config: {
      whitelist: {
        registry: {
          listStablecoins: () => [meta(USDT, 'USDT', 1), meta(USDC, 'USDC', 2)],
          getTokenByAddress: (_chain: number, address: Address) => {
            const lower = address.toLowerCase();
            if (lower === USDT.toLowerCase()) return meta(USDT, 'USDT', 1);
            if (lower === USDC.toLowerCase()) return meta(USDC, 'USDC', 2);
            if (lower === QQQB.toLowerCase()) return meta(QQQB, 'QQQB');
            return null;
          },
        },
      },
    } as never,
    balanceOf,
    tokenMeta: (address) => {
      const lower = address.toLowerCase();
      if (lower === USDT.toLowerCase()) return meta(USDT, 'USDT', 1);
      if (lower === USDC.toLowerCase()) return meta(USDC, 'USDC', 2);
      if (lower === QQQB.toLowerCase()) return meta(QQQB, 'QQQB');
      return null;
    },
  });
  return { planner, balanceOf };
}

describe('FundingPlanner: the wallet is read, never assumed', () => {
  it('plans a conversion when the wallet holds USDT but the pool quotes USDC', async () => {
    // THE case this exists for: USDT 10,000 in the wallet, best pool is QQQB/USDC.
    const { planner } = harness({
      [USDT.toLowerCase()]: 10_000n * E18,
      [USDC.toLowerCase()]: 0n,
      [QQQB.toLowerCase()]: 0n,
    });

    const decision = await planner.plan({
      pool: pool(USDC),
      quoteTokenNeededRaw: 3_820n * E18,
      stockTokenNeededRaw: 3_180n * E18,
    });

    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.plan.conversion).not.toBeNull();
    expect(decision.plan.conversion?.tokenIn).toBe(USDT);
    // ONLY the shortfall: converting the whole balance would leave the wallet in one stablecoin and spend
    // money on a conversion that earns nothing.
    expect(decision.plan.conversion?.amountInRaw).toBe(3_820n * E18);
    expect(decision.plan.quoteShortfallRaw).toBe(3_820n * E18);
  });

  it('does NOT convert when the wallet already holds the pool\'s own quote token', async () => {
    // An operator holding USDC must never be charged for a USDC→USDC conversion.
    const { planner } = harness({
      [USDC.toLowerCase()]: 10_000n * E18,
      [USDT.toLowerCase()]: 5_000n * E18,
    });

    const decision = await planner.plan({
      pool: pool(USDC),
      quoteTokenNeededRaw: 3_820n * E18,
      stockTokenNeededRaw: 3_180n * E18,
    });

    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.plan.conversion).toBeNull();
    expect(decision.plan.quoteShortfallRaw).toBe(0n);
  });

  it('converts only the SHORTFALL when the wallet is partly funded', async () => {
    const { planner } = harness({
      [USDC.toLowerCase()]: 1_000n * E18,
      [USDT.toLowerCase()]: 5_000n * E18,
    });

    const decision = await planner.plan({
      pool: pool(USDC),
      quoteTokenNeededRaw: 3_820n * E18,
      stockTokenNeededRaw: 0n,
    });

    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.plan.conversion?.amountInRaw).toBe(2_820n * E18);
  });

  it('refuses, naming the deposit needed, when no stablecoin can cover it', async () => {
    // Refused BEFORE anything is signed. The operator learns what to deposit instead of watching a
    // transaction revert after paying gas.
    const { planner } = harness({
      [USDT.toLowerCase()]: 100n * E18,
      [USDC.toLowerCase()]: 50n * E18,
    });

    const decision = await planner.plan({
      pool: pool(USDC),
      quoteTokenNeededRaw: 3_820n * E18,
      stockTokenNeededRaw: 0n,
    });

    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.reason).toBe('NO_QUOTE_TOKEN_FUNDS');
    expect(decision.message).toMatch(/Deposit USDC/);
    // The SHORTFALL, not the requirement: the wallet already holds 50, so it needs 3,770 more. Quoting the
    // full requirement would overstate the deposit and is exactly the arithmetic a refusal must get right.
    expect(decision.message).toMatch(/shortfall of 3770000000000000000000/);
    expect(decision.message).toMatch(/holds 50000000000000000000/);
  });

  it('needs no conversion at all when the wallet already covers the quote leg', async () => {
    // A deep USDC balance against a USDC-quoted pool: nothing to convert, and charging for a USDC→USDC
    // conversion would be pure waste. This is also why the candidate list excludes the pool's own quote
    // token — there is no such thing as converting a token into itself.
    const { planner } = harness({
      [USDT.toLowerCase()]: 5_000n * E18,
      [USDC.toLowerCase()]: 50_000n * E18,
    });

    const decision = await planner.plan({
      pool: pool(USDC),
      quoteTokenNeededRaw: 3_000n * E18,
      stockTokenNeededRaw: 0n,
    });

    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.plan.conversion).toBeNull();
    expect(decision.plan.quoteShortfallRaw).toBe(0n);
  });

  it('falls through to a lower-priority stablecoin when the preferred one is short', async () => {
    // Priority must not override sufficiency: USDT is preferred but holds only 100, so USDC funds it.
    const { planner } = harness({
      [USDT.toLowerCase()]: 100n * E18,
      [USDC.toLowerCase()]: 50_000n * E18,
    });

    const decision = await planner.plan({
      // A USDT-quoted pool, so USDC is a legitimate source and USDT is the self-conversion to exclude.
      pool: pool(USDT),
      quoteTokenNeededRaw: 3_000n * E18,
      stockTokenNeededRaw: 0n,
    });

    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.plan.conversion?.meta.symbol).toBe('USDC');
  });

  it('falls through when the preferred stablecoin exists but is short', async () => {
    // USDT (priority 1) holds 10 units — not enough. USDC (priority 2) has plenty. Priority must not
    // override sufficiency, or the build would be refused while a funded wallet sat right there.
    const { planner } = harness({
      [USDT.toLowerCase()]: 10n * E18,
      [USDC.toLowerCase()]: 9_000n * E18,
    });

    const decision = await planner.plan({
      pool: pool(USDT),
      quoteTokenNeededRaw: 3_820n * E18,
      stockTokenNeededRaw: 0n,
    });

    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.plan.conversion?.meta.symbol).toBe('USDC');
    // USDT contributes its 10 units, so USDC covers the remaining 3,810 — the shortfall, not the total.
    expect(decision.plan.conversion?.amountInRaw).toBe(3_810n * E18);
  });

  it('refuses when ONLY the self-conversion remains', async () => {
    // A USDC-quoted pool whose wallet holds only USDC in insufficient size: USDC is excluded (converting it
    // to itself is not a conversion), so there is genuinely nothing to convert from.
    const { planner } = harness({ [USDC.toLowerCase()]: 100n * E18 });

    const decision = await planner.plan({
      pool: pool(USDC),
      quoteTokenNeededRaw: 3_820n * E18,
      stockTokenNeededRaw: 0n,
    });

    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.reason).toBe('NO_QUOTE_TOKEN_FUNDS');
  });

  it('does NOT require a stock balance: the stock leg is bought with the quote leg (§38)', async () => {
    // The wallet holds only the quote token, which is the ordinary case — capital arrives as a stablecoin
    // and the position's stock leg is purchased by the build's own swap. Requiring a stock balance would
    // refuse every normal build.
    const { planner } = harness({ [USDC.toLowerCase()]: 50_000n * E18, [QQQB.toLowerCase()]: 0n });

    const decision = await planner.plan({
      pool: pool(USDC),
      quoteTokenNeededRaw: 3_820n * E18,
      stockTokenNeededRaw: 3_180n * E18,
    });

    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.plan.conversion).toBeNull();
    // The shortfall is still REPORTED, because the caller wants to know how much will be traded.
    expect(decision.plan.stockNeededRaw).toBe(3_180n * E18);
    expect(decision.plan.stockBalanceRaw).toBe(0n);
  });
});

describe('conversionKey: distinct from the build\'s own key', () => {
  it('derives a key that cannot collide with the build', () => {
    const build = 'build:56:pancakeswap-v3:0xe531:2026-10-01T00:00:00.000Z';
    expect(conversionKey(build)).not.toBe(build);
    expect(conversionKey(build)).toBe(`${build}#fund`);
    // Idempotent for the same input, so a retry is recognised as the same conversion.
    expect(conversionKey(build)).toBe(conversionKey(build));
  });
});

describe('describeConversion: says what will happen and what happens if the build fails', () => {
  it('names the pair, the amount and the fallback', () => {
    const text = describeConversion(
      { tokenIn: USDT, meta: meta(USDT, 'USDT'), amountInRaw: 3_820n * E18, balanceRaw: 10_000n * E18 },
      'USDC',
      null,
    );
    expect(text).toMatch(/converting 3820 USDT → USDC/);
    expect(text).toMatch(/separate transaction/);
    // The reassurance is true and specific: the residue is a stablecoin at par, not a lost position.
    expect(text).toMatch(/simply holds USDC instead — the same money/);
  });
});
