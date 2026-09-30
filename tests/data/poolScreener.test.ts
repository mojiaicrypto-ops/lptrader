import { describe, expect, it, vi } from 'vitest';
import { PoolScreener, SCREEN_REFUSALS, DEFAULT_PROBE_NOTIONAL_USD } from '../../src/data/poolScreener.ts';
import { loadConfig } from '../../src/config/index.ts';
import { PoolScreener as _unused } from '../../src/data/poolScreener.ts'; // eslint-disable-line
import type { PoolSnapshot, Sourced } from '../../src/types/market.ts';
import type { DexAdapter, PoolPriceView, SwapQuote } from '../../src/types/adapters.ts';
import type { ReferencePriceProvider } from '../../src/types/adapters.ts';
import { BSC_ADDRESSES, BSC_BSTOCKS } from '../../src/config/builtins.ts';
import { DEX_IDS, type Address } from '../../src/types/primitives.ts';

const CHAIN = 56;
const POOL_ADDRESS = '0xe531fcb1f5a195de7608b9f4f9518544c2cdb693' as Address;
const POOL_ID = `${CHAIN}:${DEX_IDS.PANCAKESWAP_V3}:${POOL_ADDRESS}`;
const QQQB = BSC_BSTOCKS.find((token) => token.symbol === 'QQQB')!.address as Address;
const USDT = BSC_ADDRESSES.USDT as Address;

void _unused;

function sourced<T>(value: T, stale = false): Sourced<T> {
  return { value, source: 'geckoterminal', asOf: '2026-09-30T00:00:00.000Z', stale };
}

/** A snapshot that passes every HTTP-measurable §16 gate; individual tests degrade one field. */
function candidate(over: Partial<PoolSnapshot> = {}): PoolSnapshot {
  return {
    timestamp: '2026-09-30T00:00:00.000Z',
    chainId: CHAIN,
    dex: DEX_IDS.PANCAKESWAP_V3,
    poolAddress: POOL_ADDRESS,
    poolId: POOL_ID,
    token0: QQQB,
    token1: USDT,
    token0Id: `${CHAIN}:${QQQB}`,
    token1Id: `${CHAIN}:${USDT}`,
    feeTier: 100,
    token0Decimals: 18,
    token1Decimals: 18,
    tvlUSD: sourced(620_000),
    volume24h: sourced(6_300_000),
    volume7d: sourced(35_500_000),
    fees24h: sourced(630),
    fees7d: sourced(3_550),
    poolAgeDays: 81,
    currentPrice: sourced(738),
    sqrtPriceX96: 2_154_702_184_312_214_094_591_448_544_382n,
    currentTick: 66_041,
    activeLiquidity: 1_158_746_174_719_549_200_573_411n,
    stockReferencePrice: sourced(738.84),
    tokenNAVDeviation: sourced(0.0005),
    stockVolatility7d: sourced(0.02),
    stockVolatility30d: sourced(0.025),
    swapImpact1000USD: sourced(0.001),
    swapImpact3500USD: sourced(0.0035),
    swapImpact5000USD: sourced(0.005),
    estimatedAPR1d: sourced(0.2),
    estimatedAPR7d: sourced(0.2),
    estimatedAPR30d: sourced(0.2),
    marketDataSource: 'geckoterminal',
    ...over,
  };
}

function priceView(over: Partial<PoolPriceView> = {}): PoolPriceView {
  return {
    poolId: POOL_ID,
    sqrtPriceX96: 2_154_702_184_312_214_094_591_448_544_382n,
    tick: 66_041,
    liquidity: 1_158_746_174_719_549_200_573_411n,
    feeTier: 100,
    tickSpacing: 1,
    // token1 per token0 (USDT per QQQB) — the pool's own orientation.
    priceToken1PerToken0: 738.5,
    priceUsd: 738.5,
    asOf: '2026-09-30T00:00:00.000Z',
    ...over,
  };
}

function quote(over: Partial<SwapQuote> = {}): SwapQuote {
  return {
    poolId: POOL_ID,
    tokenIn: USDT,
    tokenOut: QQQB,
    amountInRaw: BigInt(DEFAULT_PROBE_NOTIONAL_USD) * 10n ** 18n,
    amountOutRaw: 4_730_000_000_000_000_000n,
    amountInUsd: DEFAULT_PROBE_NOTIONAL_USD,
    priceImpact: 0.0035,
    slippageTolerance: 0.003,
    amountOutMinimumRaw: 4_715_810_000_000_000_000n,
    quotedAt: '2026-09-30T00:00:00.000Z',
    expiresAt: '2026-09-30T00:00:30.000Z',
    route: ['USDT/QQQB 0.01%'],
    ...over,
  };
}

function adapter(over: {
  readonly price?: PoolPriceView | Error;
  readonly quote?: SwapQuote | Error;
} = {}): DexAdapter {
  return {
    dex: DEX_IDS.PANCAKESWAP_V3,
    chainId: CHAIN,
    supportsAtomicBuild: true,
    assertWhitelisted: () => undefined,
    getPool: async () => null,
    getPoolPrice: async () => {
      const value = over.price ?? priceView();
      if (value instanceof Error) throw value;
      return value;
    },
    getLiquidity: async () => 0n,
    getTick: async () => 0,
    quoteSwap: async () => {
      const value = over.quote ?? quote();
      if (value instanceof Error) throw value;
      return value;
    },
    executeSwap: async () => {
      throw new Error('not used');
    },
    addLiquidity: async () => {
      throw new Error('not used');
    },
    removeLiquidity: async () => {
      throw new Error('not used');
    },
    collectFees: async () => {
      throw new Error('not used');
    },
    getPosition: async () => null,
  } as unknown as DexAdapter;
}

function referencePrice(over: { readonly value?: number | null; readonly stale?: boolean } = {}): ReferencePriceProvider {
  const value = over.value === undefined ? 738.84 : over.value;
  const stale = over.stale ?? false;
  return {
    getStockReferencePrice: async () => ({ value, source: 'binance-index', asOf: '2026-09-30T00:00:00.000Z', stale }),
    getMarketStatus: async () => 'open',
    getLatestClose: async () => ({ value, source: 'binance-index', asOf: '2026-09-30T00:00:00.000Z', stale }),
    getIndicativePrice: async () => ({ value, source: 'binance-index', asOf: '2026-09-30T00:00:00.000Z', stale }),
  };
}

async function screener(options: {
  readonly adapters?: readonly DexAdapter[];
  readonly referencePrice?: ReferencePriceProvider;
} = {}) {
  const config = await loadConfig();
  return new PoolScreener({
    config,
    adapters: new Map((options.adapters ?? [adapter()]).map((entry) => [entry.dex, entry])),
    referencePrice: options.referencePrice ?? referencePrice(),
  });
}

describe('§4.1 screening stops at the first acceptance', () => {
  it('examines ONLY the first candidate when it passes', async () => {
    // The point of the module: with one position, screening past a success is pure waste of chain calls.
    const first = candidate();
    const second = candidate({ poolAddress: '0xaaaa000000000000000000000000000000000001' as Address, poolId: `${CHAIN}:${DEX_IDS.PANCAKESWAP_V3}:0xaaaa000000000000000000000000000000000001` });

    const s = await screener();
    const outcome = await s.screen([first, second]);

    expect(outcome.accepted?.poolId).toBe(POOL_ID);
    expect(outcome.attempts).toHaveLength(1);
    expect(outcome.aborted).toBe(false);
  });

  it('moves to the next candidate only when the previous one is refused', async () => {
    const rejectingAdapter = adapter({ quote: quote({ priceImpact: 0.02 }) });
    const s = await screener({ adapters: [rejectingAdapter] });

    const first = candidate();
    const second = candidate({ poolAddress: '0xbbbb000000000000000000000000000000000002' as Address, poolId: `${CHAIN}:${DEX_IDS.PANCAKESWAP_V3}:0xbbbb000000000000000000000000000000000002` });

    const outcome = await s.screen([first, second]);
    // Both examined — the walk did NOT stop at the first refusal, which is the property under test. The
    // first is refused on the impact gate; the second is refused by the identity check because this stub
    // adapter reports the same pool address for every input (a real adapter would not), so the specific
    // refusal differs by design. What matters is that the second candidate was reached at all.
    expect(outcome.accepted).toBeNull();
    expect(outcome.attempts).toHaveLength(2);
    expect(outcome.attempts[0]!.refusal).toBe(SCREEN_REFUSALS.IMPACT_TOO_HIGH);
    expect(outcome.attempts[1]!.poolId).toBe(second.poolId);
    expect(outcome.attempts[1]!.accepted).toBe(false);
  });

  it('reports "no candidate qualified" as a normal outcome, not an abort', async () => {
    // Distinct from a provider fault: an empty result is information, not a failure.
    const s = await screener({ adapters: [adapter({ quote: quote({ priceImpact: 0.02 }) })] });
    const outcome = await s.screen([candidate()]);

    expect(outcome.accepted).toBeNull();
    expect(outcome.aborted).toBe(false);
    expect(outcome.abortReason).toBeUndefined();
  });
});

describe('§16 chain-only gates are evaluated on evidence, never on a placeholder', () => {
  it('rejects on the $3500 impact gate when the quote exceeds it', async () => {
    const s = await screener({ adapters: [adapter({ quote: quote({ priceImpact: 0.0066 }) })] });
    const outcome = await s.screen([candidate()]);

    expect(outcome.accepted).toBeNull();
    const attempt = outcome.attempts[0]!;
    expect(attempt.refusal).toBe(SCREEN_REFUSALS.IMPACT_TOO_HIGH);
    expect(attempt.reasons.join(' ')).toMatch(/\$3500 impact 0\.6600%/);
  });

  it('accepts a pool exactly AT the impact limit (the gate is not exclusive)', async () => {
    const config = await loadConfig();
    const s = await screener({ adapters: [adapter({ quote: quote({ priceImpact: config.pool.maxSwapPriceImpact }) })] });
    const outcome = await s.screen([candidate()]);

    expect(outcome.accepted).not.toBeNull();
  });

  it('probes the STABLECOIN → STOCK direction, the trade a build actually performs', async () => {
    // Probing the other side measures a different book and could pass on a side never traded.
    const quoteSwap = vi.fn(async (_request: { tokenIn: string; tokenOut: string; amountIn: bigint }) => quote());
    const spy = { ...adapter(), quoteSwap } as unknown as DexAdapter;
    const s = await screener({ adapters: [spy] });
    await s.screen([candidate()]);

    expect(quoteSwap).toHaveBeenCalledTimes(1);
    const request = quoteSwap.mock.calls[0]![0] as { tokenIn: string; tokenOut: string; amountIn: bigint };
    expect(request.tokenIn.toLowerCase()).toBe(USDT.toLowerCase());
    expect(request.tokenOut.toLowerCase()).toBe(QQQB.toLowerCase());
    // The notional must be the size the §16 gate is defined against, in the stablecoin's own decimals.
    expect(request.amountIn).toBe(BigInt(DEFAULT_PROBE_NOTIONAL_USD) * 10n ** 18n);
  });

  it('rejects on the NAV deviation gate when the on-chain price departs from the reference', async () => {
    // 2% above the reference NAV → past the §16 1% limit.
    const s = await screener({
      adapters: [adapter({ price: priceView({ priceToken1PerToken0: 753.6, priceUsd: 753.6 }) })],
      referencePrice: referencePrice({ value: 738.84 }),
    });
    const outcome = await s.screen([candidate()]);

    expect(outcome.accepted).toBeNull();
    expect(outcome.attempts[0]!.reasons.join(' ')).toMatch(/tokenNAVDeviation/);
  });

  it('treats an UNTRUSTWORTHY reference price as indeterminate, not as a pass (§96)', async () => {
    // A depeg gate evaluated against a stale reference would wave through a real depeg. "Cannot verify"
    // must never become "verified fine" - this is the exact failure mode §96 exists to prevent.
    const s = await screener({ referencePrice: referencePrice({ value: null, stale: true }) });
    const outcome = await s.screen([candidate()]);

    expect(outcome.accepted).toBeNull();
    expect(outcome.attempts[0]!.refusal).toBe(SCREEN_REFUSALS.INDETERMINATE);
    expect(outcome.attempts[0]!.reasons.join(' ')).toMatch(/could not be computed/);
  });

  it('skips a candidate whose DEX has no adapter instead of guessing at it', async () => {
    const s = await screener({ adapters: [] });
    const outcome = await s.screen([candidate()]);

    expect(outcome.accepted).toBeNull();
    expect(outcome.attempts[0]!.refusal).toBe(SCREEN_REFUSALS.PRICE_UNAVAILABLE);
    expect(outcome.attempts[0]!.reasons.join(' ')).toMatch(/no adapter is wired/);
  });
});

describe('a provider fault aborts the run rather than walking to the next pool', () => {
  it('aborts on an endpoint-internal error and says so distinctly', async () => {
    // A provider fault says nothing about THIS pool, so trying the next candidate would be guessing - and
    // worse, it would turn "the RPC is broken" into "no pool qualifies", which reads as a healthy market.
    const s = await screener({
      adapters: [adapter({ quote: new Error('RPC endpoint internal error (-32603). This is a PROVIDER fault') })],
    });
    const second = candidate({ poolAddress: '0xcccc000000000000000000000000000000000003' as Address, poolId: `${CHAIN}:${DEX_IDS.PANCAKESWAP_V3}:0xcccc000000000000000000000000000000000003` });

    const outcome = await s.screen([candidate(), second]);

    expect(outcome.aborted).toBe(true);
    expect(outcome.accepted).toBeNull();
    expect(outcome.abortReason).toMatch(/PROVIDER fault/);
    // Crucially: it stopped at the fault instead of examining the second candidate.
    expect(outcome.attempts).toHaveLength(1);
  });

  it('does NOT abort for a genuine quote failure on a specific pool (that is pool-specific)', async () => {
    // A thin pool with no route is a fact about that pool, so the walk should continue.
    const s = await screener({ adapters: [adapter({ quote: new Error('no route found') })] });
    const outcome = await s.screen([candidate()]);

    expect(outcome.aborted).toBe(false);
    expect(outcome.attempts[0]!.refusal).toBe(SCREEN_REFUSALS.QUOTE_FAILED);
  });
});

describe('identity and self-sufficiency', () => {
  it('refuses when the adapter returns a DIFFERENT pool than the candidate', async () => {
    // Discovery data can be stale or wrong; building on it would use a pool that never passed the filters.
    const s = await screener({
      adapters: [adapter({ price: priceView({ poolId: `${CHAIN}:${DEX_IDS.PANCAKESWAP_V3}:0xother` }) })],
    });
    const outcome = await s.screen([candidate()]);

    expect(outcome.accepted).toBeNull();
    expect(outcome.attempts[0]!.reasons.join(' ')).toMatch(/adapter returned/);
  });

  it('re-runs the §16 filter itself rather than trusting the caller to have filtered', async () => {
    // This module is the last gate before money moves, so it must be correct on its own.
    const s = await screener();
    const outcome = await s.screen([candidate({ tvlUSD: sourced(10_000) })]); // far below the §16 floor

    expect(outcome.accepted).toBeNull();
    expect(outcome.attempts[0]!.refusal).toBe(SCREEN_REFUSALS.FILTER_REJECTED);
    expect(outcome.attempts[0]!.reasons.join(' ')).toMatch(/tvl/);
  });

  it('rejects a stale §16 figure instead of evaluating a placeholder', async () => {
    const s = await screener();
    const outcome = await s.screen([candidate({ volume7d: sourced(0, true) })]);

    expect(outcome.accepted).toBeNull();
    expect(outcome.attempts[0]!.refusal).toBe(SCREEN_REFUSALS.FILTER_REJECTED);
    expect(outcome.attempts[0]!.reasons.join(' ')).toMatch(/unavailable|fail closed/i);
  });
});
