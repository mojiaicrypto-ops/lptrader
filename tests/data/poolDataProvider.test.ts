/**
 * T6 offline tests for `src/data/poolDataProvider.ts` — the three-layer composition policy.
 *
 * No network: `transport` and `clock` are injected, so the canonical-source table, the cross-checks,
 * the derived `fees24h/7d` provenance, the RPC-only `tick`/`liquidity` rule and the TTL cache are
 * all deterministic. Research §4.4 is the source of the layer facts asserted here.
 */

import { createServer } from 'node:http';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.ts';
import { createBuiltinRegistry } from '../../src/config/registry.ts';
import {
  CROSS_CHECK_CRITICAL_TOLERANCE,
  DEFAULT_DEXPAPRIKA_BASE_URL,
  DEFAULT_GECKOTERMINAL_BASE_URL,
  DEFAULT_HTTP_TIMEOUT_MS,
  FEE_TIER_TO_RATIO,
  FetchHttpTransport,
  FEE_TIER_UNKNOWN,
  LayeredPoolDataProvider,
  POOL_DATA_ERROR_CODES,
  PoolDataError,
  combineMarketDataSource,
  createPoolDataProvider,
  deriveFees,
  feeTierFromPercent,
  parsePoolId,
  poolIdFor,
  relativeDifference,
  sumCandleVolume,
  closeToCloseVolatility,
  type Clock,
  type DetailedPoolDataProvider,
  type HttpTransport,
  type OnchainPoolReserves,
  type OnchainPoolState,
  type PoolStateSource,
} from '../../src/data/poolDataProvider.ts';
import { DATA_SOURCES } from '../../src/types/market.ts';
import { DEX_IDS, type Address } from '../../src/types/primitives.ts';
import type { TokenRegistry } from '../../src/types/registry.ts';

/* ------------------------------------------------------------------ *
 * Real BSC facts (research §1/§4.1)
 * ------------------------------------------------------------------ */

const QQQB = '0x205812cdbed920aff76c6580abd681a46d11efc7' as Address;
const USDC = '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d' as Address;
const USDT = '0x55d398326f99059ff775485246999027b3197955' as Address;
/** QQQB/USDC @ Uniswap V3 0.3% (research §4.1). */
const POOL = '0xfc4e77248b76fefc27c4cac7151a2ee5b5cc590e' as Address;
const OTHER_POOL = '0x62609d8964b2fb5ce0322c4e0b659466e7297df9' as Address;

const NOW = new Date('2026-09-29T09:50:00.000Z');
const NOW_ISO = NOW.toISOString();
/** Measured 24h volume / TVL of the QQQB/USDC pool (research §4.1). */
const GT_TVL = 1_770_000;
const GT_VOL24 = 1_340_000;

let registry: TokenRegistry;

beforeAll(async () => {
  registry = createBuiltinRegistry();
  expect((await loadConfig()).pool.minTvlUsd).toBe(500_000);
});

/* ------------------------------------------------------------------ *
 * Doubles
 * ------------------------------------------------------------------ */

interface RouteResponse {
  readonly status?: number;
  readonly body?: unknown;
}

function mockTransport(routes: Record<string, RouteResponse>): {
  transport: HttpTransport;
  calls: string[];
} {
  const calls: string[] = [];
  const transport: HttpTransport = {
    async request(request) {
      calls.push(request.url);
      const entry = routes[request.url];
      if (entry === undefined) throw new Error(`unexpected HTTP request: ${request.url}`);
      return {
        status: entry.status ?? 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(entry.body ?? {}),
      };
    },
  };
  return { transport, calls };
}

const clockNow: Clock = { now: () => NOW.getTime(), sleep: async () => undefined };

const GT_LIST_URL = `${DEFAULT_GECKOTERMINAL_BASE_URL}/networks/bsc/tokens/${QQQB}/pools?page=1&sort=h24_volume_usd_desc`;
const GT_DETAIL_URL = `${DEFAULT_GECKOTERMINAL_BASE_URL}/networks/bsc/pools/${POOL}`;
const GT_OHLCV_URL = `${DEFAULT_GECKOTERMINAL_BASE_URL}/networks/bsc/pools/${POOL}/ohlcv/day?aggregate=1&limit=31`;
const DP_SEARCH_URL = `${DEFAULT_DEXPAPRIKA_BASE_URL}/networks/bsc/pools/search?token_address=${QQQB}&limit=100&order_by=liquidity_usd&sort=desc`;
const GT_MULTI_URL = `${DEFAULT_GECKOTERMINAL_BASE_URL}/networks/bsc/pools/multi/${POOL}`;

/** A GeckoTerminal list-page entry (`normalizeGeckoTerminalPool` shape). */
function gtPoolEntry(params: {
  readonly address: Address;
  readonly dexId?: string;
  readonly baseToken?: Address;
  readonly quoteToken?: Address;
  readonly feePercent?: number | null;
  readonly tvl?: number;
  readonly volume24h?: number;
  readonly basePrice?: number;
  readonly quotePrice?: number;
  readonly createdAt?: string;
}): unknown {
  const base = params.baseToken ?? QQQB;
  const quote = params.quoteToken ?? USDC;
  return {
    attributes: {
      address: params.address,
      pool_fee_percentage: params.feePercent === undefined ? 0.3 : params.feePercent,
      pool_created_at: params.createdAt ?? '2026-08-07T00:00:00Z',
      base_token_price_usd: params.basePrice ?? 601.25,
      quote_token_price_usd: params.quotePrice ?? 1.0001,
      reserve_in_usd: params.tvl ?? GT_TVL,
      volume_usd: { h24: params.volume24h ?? GT_VOL24 },
    },
    relationships: {
      dex: { data: { id: params.dexId ?? 'uniswap-bsc' } },
      base_token: { data: { id: `bsc_${base}` } },
      quote_token: { data: { id: `bsc_${quote}` } },
    },
  };
}

function gtListBody(pools: readonly unknown[], nextPage = false): unknown {
  return { data: [...pools], links: nextPage ? { next: 'page=2' } : {} };
}

/** 31 daily candles, newest first (the order GeckoTerminal returns). */
function candlesBody(newestFirstVolumes: readonly number[]): unknown {
  const rows: unknown[][] = [];
  for (let index = 0; index < 31; index += 1) {
    const timestamp = Math.floor(NOW.getTime() / 1000) - index * 86_400;
    const close = 600 + Math.sin(index / 3) * 4 + index * 0.05;
    const volume = newestFirstVolumes[index] ?? 1_000_000;
    rows.push([timestamp, close - 1, close + 2, close - 2, close, volume]);
  }
  return { data: { attributes: { ohlcv_list: rows } } };
}

/** A DexPaprika `/pools/search` result (`normalizeDexPaprikaPool` shape). */
function dpPoolEntry(params: {
  readonly address?: Address;
  readonly dexId?: string;
  readonly fee?: number | null;
  readonly tvl?: number;
  readonly volume24h?: number;
  readonly volume7d?: number;
  readonly volume30d?: number;
  readonly createdAt?: string;
  readonly lastPrice?: number;
} = {}): unknown {
  return {
    id: params.address ?? POOL,
    dex_id: params.dexId ?? 'uniswap_v3',
    factory_id: null,
    fee: params.fee === undefined ? null : params.fee,
    tokens: [{ id: QQQB }, { id: USDC }],
    liquidity_usd: params.tvl ?? GT_TVL,
    volume_usd_7d: params.volume7d ?? 9_380_000,
    volume_usd_30d: params.volume30d ?? 40_000_000,
    created_at: params.createdAt ?? '2026-08-07T00:00:00Z',
    last_price_usd: params.lastPrice ?? 601.25,
    '24h': { volume_usd: params.volume24h ?? GT_VOL24 },
  };
}

function dpSearchBody(pools: readonly unknown[]): unknown {
  return { results: [...pools], has_next_page: false, next_cursor: null };
}

/** The on-chain truth for the pool (RPC layer). */
function onchainState(overrides: Partial<OnchainPoolState> = {}): OnchainPoolState {
  return {
    poolAddress: POOL,
    token0: QQQB,
    token1: USDC,
    feeTier: 3_000,
    tickSpacing: 60,
    sqrtPriceX96: 79_228_162_514_264_337_593_543_950_336n, // ≈ 1.0000 in Q64.96
    tick: 0,
    liquidity: 1_234_567_890n,
    asOf: NOW_ISO,
    ...overrides,
  };
}

function onchainSource(overrides: Partial<PoolStateSource> = {}): PoolStateSource {
  const base: PoolStateSource = {
    chainId: 56,
    readPoolStates: async () => [onchainState()],
    readPoolReserves: async (): Promise<readonly OnchainPoolReserves[]> => [
      // ≈ $1.77M at the GeckoTerminal unit prices, so the reserve cross-check agrees with the APIs.
      { poolAddress: POOL, token0Raw: 1_400n * 10n ** 18n, token1Raw: 928_000n * 10n ** 18n, asOf: NOW_ISO },
    ],
    quoteExactInputSingle: async () => 5_808_200_000_000_000_000n,
  };
  return { ...base, ...overrides };
}

function providerWith(params: {
  readonly routes: Record<string, RouteResponse>;
  readonly onchain?: PoolStateSource;
}): { provider: DetailedPoolDataProvider; calls: string[] } {
  const { transport, calls } = mockTransport(params.routes);
  const provider = createPoolDataProvider({
    chainId: 56,
    registry,
    transport,
    clock: clockNow,
    ...(params.onchain === undefined ? {} : { onchain: params.onchain }),
  });
  return { provider, calls };
}

const QUERY = {
  chainId: 56,
  tokenAddresses: [QQQB],
  stablecoinAddresses: [USDC, USDT],
  dexes: [DEX_IDS.UNISWAP_V3, DEX_IDS.PANCAKESWAP_V3],
} as const;

/** The baseline route table: GT list + OHLCV + DexPaprika search, with a healthy RPC. */
function baselineRoutes(
  overrides: {
    readonly gtList?: unknown;
    readonly dpSearch?: unknown;
    readonly candles?: readonly number[];
    readonly gtDetail?: unknown;
  } = {},
): Record<string, RouteResponse> {
  return {
    [GT_LIST_URL]: { body: overrides.gtList ?? gtListBody([gtPoolEntry({ address: POOL })]) },
    [GT_OHLCV_URL]: { body: candlesBody(overrides.candles ?? new Array<number>(31).fill(1_340_000)) },
    [DP_SEARCH_URL]: {
      body: overrides.dpSearch ?? dpSearchBody([dpPoolEntry({ volume7d: 9_380_000 })]),
    },
    ...(overrides.gtDetail === undefined ? {} : { [GT_DETAIL_URL]: { body: overrides.gtDetail } }),
  };
}

/* ------------------------------------------------------------------ *
 * Fee tier extraction
 * ------------------------------------------------------------------ */

describe('fee tier conversion', () => {
  it('turns GeckoTerminal percentages into hundredths of a bip', () => {
    expect(feeTierFromPercent(0.01)).toBe(100);
    expect(feeTierFromPercent(0.05)).toBe(500);
    expect(feeTierFromPercent(0.3)).toBe(3_000);
    expect(feeTierFromPercent(0.25)).toBe(2_500);
    expect(feeTierFromPercent(1)).toBe(10_000);
  });

  it('returns null for a missing or non-positive percentage rather than inventing a tier', () => {
    expect(feeTierFromPercent(0)).toBeNull();
    expect(feeTierFromPercent(-1)).toBeNull();
    expect(feeTierFromPercent(Number.NaN)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Canonical source selection + cross-checks
 * ------------------------------------------------------------------ */

describe('three-source conflict: one canonical value wins, the other is kept for cross-check', () => {
  it('keeps GeckoTerminal as canonical TVL and records the DexPaprika value beside it', async () => {
    const { provider } = providerWith({
      routes: baselineRoutes({ dpSearch: dpSearchBody([dpPoolEntry({ tvl: GT_TVL * 1.03 })]) }),
      onchain: onchainSource(),
    });

    const result = await provider.getPoolsDetailed({ ...QUERY });
    const pool = result.pools[0]!;
    expect(pool.tvlUSD.value).toBe(GT_TVL);
    expect(pool.tvlUSD.source).toBe(DATA_SOURCES.GECKOTERMINAL);

    const check = result.diagnostics[0]!.crossChecks.find((entry) => entry.field === 'tvlUSD');
    expect(check).toBeDefined();
    expect(check!.canonicalSource).toBe(DATA_SOURCES.GECKOTERMINAL);
    expect(check!.canonicalValue).toBe(GT_TVL);
    expect(check!.crossSource).toBe(DATA_SOURCES.DEXPAPRIKA);
    expect(check!.crossValue).toBeCloseTo(GT_TVL * 1.03, 5);
    // Values are never averaged or blended — the canonical field keeps the GT number exactly.
    expect(check!.canonicalValue).not.toBeCloseTo((GT_TVL + GT_TVL * 1.03) / 2, 1);
  });

  it('treats the measured ~3% cross-source gap as informational, not degradation', async () => {
    const { provider } = providerWith({
      routes: baselineRoutes({ dpSearch: dpSearchBody([dpPoolEntry({ tvl: GT_TVL * 1.03 })]) }),
      onchain: onchainSource(),
    });
    const result = await provider.getPoolsDetailed({ ...QUERY });
    const check = result.diagnostics[0]!.crossChecks.find((entry) => entry.field === 'tvlUSD')!;
    // Measured divergence is ~3%: recorded, but below the 10% "investigate" line, so the canonical
    // value stays usable — a busy-pool dataset gap must not be treated as degradation.
    expect(check.relativeDiff).toBeCloseTo(0.0291, 3);
    expect(check.divergent).toBe(false);
    expect(check.severity).toBe('info');
    expect(result.pools[0]!.tvlUSD.stale).toBe(false);
  });

  it('marks the canonical value stale when two sources disagree past the critical tolerance', async () => {
    const far = GT_TVL * (1 + CROSS_CHECK_CRITICAL_TOLERANCE + 0.1);
    const { provider } = providerWith({
      routes: baselineRoutes({ dpSearch: dpSearchBody([dpPoolEntry({ tvl: far })]) }),
      onchain: onchainSource(),
    });
    const result = await provider.getPoolsDetailed({ ...QUERY });
    const check = result.diagnostics[0]!.crossChecks.find((entry) => entry.field === 'tvlUSD')!;
    expect(check.severity).toBe('critical');
    // A number two sources disagree about must fail closed (§96), not be traded on.
    expect(result.pools[0]!.tvlUSD.stale).toBe(true);
  });

  it('falls back to DexPaprika TVL only when GeckoTerminal reports none, and says so', async () => {
    const { provider } = providerWith({
      routes: baselineRoutes({
        gtList: gtListBody([gtPoolEntry({ address: POOL, tvl: 0 })]),
        dpSearch: dpSearchBody([dpPoolEntry({ tvl: 1_500_000 })]),
      }),
      onchain: onchainSource(),
    });
    const result = await provider.getPoolsDetailed({ ...QUERY });
    const pool = result.pools[0]!;
    expect(pool.tvlUSD.value).toBe(1_500_000);
    expect(pool.tvlUSD.source).toBe(DATA_SOURCES.DEXPAPRIKA);
    expect(
      result.diagnostics[0]!.warnings.some((warning) => warning.includes('fell back to DexPaprika')),
    ).toBe(true);
  });

  it('accepts bit-exact identical sources without flagging divergence', async () => {
    const { provider } = providerWith({ routes: baselineRoutes(), onchain: onchainSource() });
    const result = await provider.getPoolsDetailed({ ...QUERY });
    const check = result.diagnostics[0]!.crossChecks.find((entry) => entry.field === 'tvlUSD')!;
    expect(check.relativeDiff).toBe(0);
    expect(check.divergent).toBe(false);
    expect(check.severity).toBe('info');
  });

  it('keeps canonical volume24h from GeckoTerminal and the 7d volume from DexPaprika', async () => {
    const { provider } = providerWith({ routes: baselineRoutes(), onchain: onchainSource() });
    const result = await provider.getPoolsDetailed({ ...QUERY });
    const pool = result.pools[0]!;
    expect(pool.volume24h.source).toBe(DATA_SOURCES.GECKOTERMINAL);
    expect(pool.volume24h.value).toBe(GT_VOL24);
    // GeckoTerminal has no 7d field, so DexPaprika owns it by design (research §4.4).
    expect(pool.volume7d.source).toBe(DATA_SOURCES.DEXPAPRIKA);
    expect(pool.volume7d.value).toBe(9_380_000);
  });
});

/* ------------------------------------------------------------------ *
 * fees are derived, never measured
 * ------------------------------------------------------------------ */

describe('fees24h / fees7d are derived and labelled as such', () => {
  it('computes volume × feeTier and marks the source `derived`', async () => {
    const { provider } = providerWith({ routes: baselineRoutes(), onchain: onchainSource() });
    const pool = (await provider.getPoolsDetailed({ ...QUERY })).pools[0]!;

    const ratio = 3_000 / FEE_TIER_TO_RATIO;
    expect(pool.fees24h.source).toBe(DATA_SOURCES.DERIVED);
    expect(pool.fees24h.value).toBeCloseTo(GT_VOL24 * ratio, 6);
    expect(pool.fees7d.source).toBe(DATA_SOURCES.DERIVED);
    expect(pool.fees7d.value).toBeCloseTo(9_380_000 * ratio, 6);
    expect(pool.fees24h.stale).toBe(false);
  });

  it('never fabricates a fee figure when the volume or the fee tier is unknown', async () => {
    // No RPC (so the fee tier would come from GeckoTerminal) and GT reports no percentage either.
    const { provider } = providerWith({
      routes: {
        ...baselineRoutes({
          gtList: gtListBody([gtPoolEntry({ address: POOL, feePercent: null })]),
        }),
        // The documented GeckoTerminal fee fallback also reports no percentage.
        [GT_MULTI_URL]: { body: gtListBody([gtPoolEntry({ address: POOL, feePercent: null })]) },
      },
    });
    const pool = (await provider.getPoolsDetailed({ ...QUERY })).pools[0]!;
    expect(pool.feeTier).toBe(FEE_TIER_UNKNOWN);
    expect(pool.fees24h.source).toBe(DATA_SOURCES.UNAVAILABLE);
    expect(pool.fees24h.value).toBe(0);
    expect(pool.fees24h.stale).toBe(true);
    expect(pool.fees7d.source).toBe(DATA_SOURCES.UNAVAILABLE);
  });

  it('deriveFees refuses to derive from a stale volume', () => {
    const derived = deriveFees(1_000_000, 0.003, false, NOW_ISO);
    expect(derived.value).toBe(3_000);
    expect(derived.source).toBe(DATA_SOURCES.DERIVED);

    const refused = deriveFees(1_000_000, 0.003, true, NOW_ISO);
    expect(refused.source).toBe(DATA_SOURCES.UNAVAILABLE);
    expect(refused.value).toBe(0);
    expect(refused.stale).toBe(true);

    expect(deriveFees(null, 0.003, false, NOW_ISO).source).toBe(DATA_SOURCES.UNAVAILABLE);
    expect(deriveFees(1_000_000, null, false, NOW_ISO).source).toBe(DATA_SOURCES.UNAVAILABLE);
  });
});

/* ------------------------------------------------------------------ *
 * tick / liquidity / fee are RPC-only
 * ------------------------------------------------------------------ */

describe('tick, liquidity and fee come from the RPC layer alone', () => {
  it('uses the on-chain values and marks the pool verified when the RPC answered', async () => {
    const state = onchainState({ tick: 1234, liquidity: 999_000n, feeTier: 3_000 });
    const { provider } = providerWith({
      routes: baselineRoutes(),
      onchain: onchainSource({ readPoolStates: async () => [state] }),
    });
    const result = await provider.getPoolsDetailed({ ...QUERY });
    const pool = result.pools[0]!;
    expect(pool.currentTick).toBe(1234);
    expect(pool.activeLiquidity).toBe(999_000n);
    expect(pool.feeTier).toBe(3_000);
    expect(result.diagnostics[0]!.onchainVerified).toBe(true);
    expect(result.diagnostics[0]!.tokenOrderSource).toBe('onchain');
  });

  it('without an RPC layer, tick/liquidity are placeholders and the pool is reported unverified', async () => {
    const { provider } = providerWith({ routes: baselineRoutes() });
    const result = await provider.getPoolsDetailed({ ...QUERY });
    const pool = result.pools[0]!;
    // These two fields have no availability bit, which is exactly why the filter refuses them.
    expect(pool.currentTick).toBe(0);
    expect(pool.activeLiquidity).toBe(0n);
    expect(result.diagnostics[0]!.onchainVerified).toBe(false);
    // The observable fail-closed signals the filter keys off:
    expect(pool.swapImpact3500USD.source).toBe(DATA_SOURCES.UNAVAILABLE);
    expect(pool.swapImpact3500USD.stale).toBe(true);
    expect(
      result.diagnostics[0]!.warnings.some((warning) => warning.includes('on-chain state unavailable')),
    ).toBe(true);
  });

  it('a failed on-chain read is a fatal failure, not a zeroed pool state', async () => {
    const { provider } = providerWith({
      routes: baselineRoutes(),
      onchain: onchainSource({
        readPoolStates: async () => {
          throw new Error('RPC unreachable');
        },
      }),
    });
    const result = await provider.getPoolsDetailed({ ...QUERY });
    expect(result.complete).toBe(false);
    expect(
      result.failures.some(
        (failure) => failure.source === DATA_SOURCES.ONCHAIN && failure.severity === 'fatal',
      ),
    ).toBe(true);
    expect(result.diagnostics[0]!.onchainVerified).toBe(false);
    expect(result.pools[0]!.currentTick).toBe(0);
  });

  it('never lets DexPaprika\'s null fee become the fee tier', async () => {
    const { provider } = providerWith({
      routes: baselineRoutes({ dpSearch: dpSearchBody([dpPoolEntry({ fee: null })]) }),
      onchain: onchainSource(),
    });
    const result = await provider.getPoolsDetailed({ ...QUERY });
    expect(result.pools[0]!.feeTier).toBe(3_000); // from the RPC, not from the null
    expect(
      result.diagnostics[0]!.warnings.some((warning) => warning.includes('fee=null')),
    ).toBe(true);
  });

  it('quotes the §16 swap impacts on-chain when the QuoterV2 layer is wired', async () => {
    const { provider } = providerWith({ routes: baselineRoutes(), onchain: onchainSource() });
    const pool = (await provider.getPoolsDetailed({ ...QUERY })).pools[0]!;
    expect(pool.swapImpact3500USD.source).toBe(DATA_SOURCES.ONCHAIN);
    expect(pool.swapImpact3500USD.stale).toBe(false);
    expect(pool.swapImpact1000USD.source).toBe(DATA_SOURCES.ONCHAIN);
    expect(pool.swapImpact5000USD.source).toBe(DATA_SOURCES.ONCHAIN);
  });

  it('refuses a snapshot whose on-chain legs contradict the HTTP legs', async () => {
    const { provider } = providerWith({
      routes: baselineRoutes(),
      onchain: onchainSource({
        readPoolStates: async () => [onchainState({ token1: USDT })],
      }),
    });
    const result = await provider.getPoolsDetailed({ ...QUERY });
    expect(result.pools).toEqual([]);
    expect(result.complete).toBe(false);
    expect(result.failures.some((failure) => failure.message.includes('disagree with the HTTP legs'))).toBe(
      true,
    );
  });
});

/* ------------------------------------------------------------------ *
 * Caching / request economy
 * ------------------------------------------------------------------ */

describe('throttling and caching', () => {
  it('serves a repeated discovery call from the TTL cache without a second HTTP request', async () => {
    const { provider, calls } = providerWith({ routes: baselineRoutes(), onchain: onchainSource() });
    const first = await provider.getPoolsDetailed({ ...QUERY });
    const second = await provider.getPoolsDetailed({ ...QUERY });

    // GeckoTerminal and DexPaprika are each queried exactly once per stock token.
    expect(calls.filter((url) => url === GT_LIST_URL)).toHaveLength(1);
    expect(calls.filter((url) => url === DP_SEARCH_URL)).toHaveLength(1);
    expect(calls.filter((url) => url === GT_OHLCV_URL)).toHaveLength(1);
    expect(first.pools[0]!.tvlUSD.value).toBe(second.pools[0]!.tvlUSD.value);
  });

  it('counts scheduler requests so a rate-limit regression is observable', async () => {
    const { provider } = providerWith({ routes: baselineRoutes(), onchain: onchainSource() });
    await provider.getPoolsDetailed({ ...QUERY });
    const stats = (provider as unknown as { stats: { geckoterminal: { requests: number } } }).stats;
    // One list request + one OHLCV request.
    expect(stats.geckoterminal.requests).toBe(2);
  });

  it('refuses an empty token list instead of reporting "no pools"', async () => {
    const { provider } = providerWith({ routes: baselineRoutes(), onchain: onchainSource() });
    await expect(
      provider.getPoolsDetailed({ ...QUERY, tokenAddresses: [] }),
    ).rejects.toBeInstanceOf(PoolDataError);
  });

  it('refuses a query for another chain', async () => {
    const { provider } = providerWith({ routes: baselineRoutes(), onchain: onchainSource() });
    await expect(
      provider.getPoolsDetailed({ ...QUERY, chainId: 97 }),
    ).rejects.toThrow(/bound to chain 56/);
  });
});

/* ------------------------------------------------------------------ *
 * Reference NAV / deviation
 * ------------------------------------------------------------------ */

describe('tokenNAVDeviation depends on an injected §84 reference', () => {
  it('is unavailable (null) when no reference provider is wired, so §16 cannot pass it', async () => {
    const { provider } = providerWith({ routes: baselineRoutes(), onchain: onchainSource() });
    const pool = (await provider.getPoolsDetailed({ ...QUERY })).pools[0]!;
    expect(pool.tokenNAVDeviation.value).toBeNull();
    expect(pool.tokenNAVDeviation.source).toBe(DATA_SOURCES.UNAVAILABLE);
    expect(pool.tokenNAVDeviation.stale).toBe(true);
    expect(pool.stockReferencePrice.source).toBe(DATA_SOURCES.UNAVAILABLE);
  });

  it('computes |price / reference − 1| when a trustworthy reference exists', async () => {
    const { transport } = mockTransport(baselineRoutes());
    const provider = createPoolDataProvider({
      chainId: 56,
      registry,
      transport,
      clock: clockNow,
      onchain: onchainSource(),
      referencePrice: {
        getStockReferencePrice: async () => ({
          value: 601.25,
          source: DATA_SOURCES.BINANCE_INDEX,
          asOf: NOW_ISO,
          stale: false,
        }),
      },
    });
    const pool = (await provider.getPoolsDetailed({ ...QUERY })).pools[0]!;
    expect(pool.tokenNAVDeviation.value).toBeCloseTo(0, 6);
    expect(pool.tokenNAVDeviation.source).toBe(DATA_SOURCES.DERIVED);
    expect(pool.stockReferencePrice.value).toBe(601.25);
  });

  it('a stale reference degrades the deviation to unavailable rather than computing a number', async () => {
    const { transport } = mockTransport(baselineRoutes());
    const provider = createPoolDataProvider({
      chainId: 56,
      registry,
      transport,
      clock: clockNow,
      onchain: onchainSource(),
      referencePrice: {
        getStockReferencePrice: async () => ({
          value: 0,
          source: DATA_SOURCES.BINANCE_INDEX,
          asOf: NOW_ISO,
          stale: true,
        }),
      },
    });
    const pool = (await provider.getPoolsDetailed({ ...QUERY })).pools[0]!;
    expect(pool.tokenNAVDeviation.value).toBeNull();
    expect(pool.stockReferencePrice.stale).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Discovery edge cases
 * ------------------------------------------------------------------ */

describe('discovery only returns pools that cross a whitelisted stock/stablecoin leg', () => {
  it('drops a pool that does not involve the queried stock token', async () => {
    const { provider } = providerWith({
      routes: {
        ...baselineRoutes(),
        [GT_LIST_URL]: {
          body: gtListBody([
            gtPoolEntry({ address: POOL }),
            // WBNB is not a stablecoin (§14 cross set), so this pool is not a candidate.
            gtPoolEntry({ address: OTHER_POOL, quoteToken: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c' }),
          ]),
        },
      },
      onchain: onchainSource(),
    });
    const result = await provider.getPoolsDetailed({ ...QUERY });
    expect(result.pools.map((pool) => pool.poolAddress)).toEqual([POOL]);
  });

  it('drops a pool on a non-whitelisted DEX', async () => {
    const { provider } = providerWith({
      routes: {
        ...baselineRoutes(),
        [GT_LIST_URL]: {
          body: gtListBody([
            gtPoolEntry({ address: POOL }),
            gtPoolEntry({ address: OTHER_POOL, dexId: 'sushiswap-bsc' }),
          ]),
        },
      },
      onchain: onchainSource(),
    });
    const result = await provider.getPoolsDetailed({ ...QUERY });
    expect(result.pools).toHaveLength(1);
  });

  it('records a truncated GeckoTerminal page as a fatal failure, never as a verified absence', async () => {
    const { provider } = providerWith({
      routes: { ...baselineRoutes(), [GT_LIST_URL]: { body: gtListBody([gtPoolEntry({ address: POOL })], true) } },
      onchain: onchainSource(),
    });
    const result = await provider.getPoolsDetailed({ ...QUERY });
    expect(result.complete).toBe(false);
    expect(result.failures.some((failure) => failure.message.includes('more pages than page 1'))).toBe(true);
  });

  it('throws when every discovery request failed — "no pools" must not be fabricated', async () => {
    const { transport } = mockTransport({
      [GT_LIST_URL]: { status: 500, body: { error: 'internal' } },
      [DP_SEARCH_URL]: { body: dpSearchBody([]) },
    });
    const provider = createPoolDataProvider({ chainId: 56, registry, transport, clock: clockNow });
    await expect(provider.getPoolsDetailed({ ...QUERY })).rejects.toMatchObject({
      code: POOL_DATA_ERROR_CODES.SOURCE_UNAVAILABLE,
    });
  });

  it('records a DexPaprika enrichment failure as non-fatal but visible', async () => {
    const { provider } = providerWith({
      routes: { ...baselineRoutes(), [DP_SEARCH_URL]: { status: 500, body: { error: 'internal' } } },
      onchain: onchainSource(),
    });
    const result = await provider.getPoolsDetailed({ ...QUERY });
    expect(result.pools).toHaveLength(1);
    const failure = result.failures.find((entry) => entry.source === DATA_SOURCES.DEXPAPRIKA)!;
    expect(failure.severity).toBe('degraded');
    // Without DexPaprika the 7d volume falls back to the GeckoTerminal candle sum, with a warning.
    expect(result.pools[0]!.volume7d.source).toBe(DATA_SOURCES.GECKOTERMINAL);
    expect(result.complete).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Identity + single-pool getters
 * ------------------------------------------------------------------ */

describe('pool identity and the single-pool getters', () => {
  it('round-trips a §13 pool id', () => {
    const id = poolIdFor(56, DEX_IDS.UNISWAP_V3, POOL);
    expect(id).toBe(`56:${DEX_IDS.UNISWAP_V3}:${POOL}`);
    expect(parsePoolId(id)).toEqual({ chainId: 56, dex: DEX_IDS.UNISWAP_V3, poolAddress: POOL });
  });

  it('rejects a malformed pool id', () => {
    expect(() => parsePoolId('not-a-pool')).toThrow(PoolDataError);
    expect(() => parsePoolId('56:unknown-dex:0xabc')).toThrow(/unknown dex/);
  });

  it('serves getTVL from the pool detail endpoint and caches the single-pool load', async () => {
    const detail = { data: gtPoolEntry({ address: POOL }) };
    const { provider, calls } = providerWith({
      routes: baselineRoutes({ gtDetail: detail }),
      onchain: onchainSource(),
    });
    const id = poolIdFor(56, DEX_IDS.UNISWAP_V3, POOL);
    const tvl = await provider.getTVL(id);
    expect(tvl.value).toBe(GT_TVL);
    expect(tvl.source).toBe(DATA_SOURCES.GECKOTERMINAL);
    await provider.getVolume24h(id);
    expect(calls.filter((url) => url === GT_DETAIL_URL)).toHaveLength(1);
  });

  it('propagates a source failure from the single-pool getter instead of degrading silently', async () => {
    const { provider } = providerWith({
      routes: { ...baselineRoutes(), [GT_DETAIL_URL]: { status: 503, body: {} } },
      onchain: onchainSource(),
    });
    await expect(provider.getTVL(poolIdFor(56, DEX_IDS.UNISWAP_V3, POOL))).rejects.toThrow(
      /geckoterminal pool detail unavailable/,
    );
  });
});

/* ------------------------------------------------------------------ *
 * The default transport must not hang
 * ------------------------------------------------------------------ */

describe('FetchHttpTransport is bounded', () => {
  it('rejects with a positive, validated timeout by default', () => {
    const transport = new FetchHttpTransport();
    expect(transport.timeoutMs).toBe(DEFAULT_HTTP_TIMEOUT_MS);
    expect(DEFAULT_HTTP_TIMEOUT_MS).toBeLessThan(60_000);
    expect(() => new FetchHttpTransport({ timeoutMs: 0 })).toThrow(/positive number/);
    expect(() => new FetchHttpTransport({ timeoutMs: Number.NaN })).toThrow(/positive number/);
  });

  it('aborts a peer that accepts the request but never answers', async () => {
    // A server that never responds is the failure the scan cadence cannot survive: a pending read
    // never returns, so the cadence round would never complete.
    const server = createServer(() => {
      // Deliberately never call `res.end()`.
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address !== 'object') throw new Error('no server address');

    try {
      const transport = new FetchHttpTransport({ timeoutMs: 250 });
      const startedAt = Date.now();
      await expect(
        transport.request({
          url: `http://127.0.0.1:${String(address.port)}/hang`,
          headers: {},
        }),
      ).rejects.toThrow(/aborted|timeout/i);
      expect(Date.now() - startedAt).toBeLessThan(3_000);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('turns a stalled source into a retried failure, then a precise error', async () => {
    let accepted = 0;
    const server = createServer(() => {
      accepted += 1; // accept and never answer
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address !== 'object') throw new Error('no server address');

    try {
      const transport = new FetchHttpTransport({ timeoutMs: 200 });
      const provider = new LayeredPoolDataProvider({
        chainId: 56,
        registry,
        transport,
        clock: clockNow,
        geckoterminal: {
          baseUrl: `http://127.0.0.1:${String(address.port)}`,
          policy: {
            minIntervalMs: 0,
            maxAttempts: 2,
            baseBackoffMs: 1,
            maxBackoffMs: 2,
            maxRetryAfterMs: 5,
          },
        },
      });

      // The timeout surfaces as an ordinary source failure instead of hanging the process.
      await expect(provider.getPoolsDetailed({ ...QUERY })).rejects.toMatchObject({
        code: POOL_DATA_ERROR_CODES.SOURCE_UNAVAILABLE,
      });
      expect(accepted).toBe(2); // retried exactly once, then gave up
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

/* ------------------------------------------------------------------ *
 * Small pure helpers
 * ------------------------------------------------------------------ */

describe('analytics helpers', () => {
  it('sums the NEWEST `days` candles even though the source is newest-first', () => {
    const candles = [5, 4, 3, 2, 1].map((volumeUsd, index) => ({
      timestampSeconds: 1000 - index,
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      volumeUsd,
    }));
    expect(sumCandleVolume(candles, 3)).toBe(5 + 4 + 3);
    expect(sumCandleVolume(candles, 6)).toBeNull();
  });

  it('computes a volatility of zero for a flat series and null for too-short history', () => {
    const flat = Array.from({ length: 8 }, (_, index) => ({
      timestampSeconds: 1000 - index,
      open: 10,
      high: 10,
      low: 10,
      close: 10,
      volumeUsd: 0,
    }));
    expect(closeToCloseVolatility(flat, 7)).toBe(0);
    expect(closeToCloseVolatility(flat.slice(0, 3), 7)).toBeNull();
  });

  it('relativeDifference is scale-symmetric and null when a side is unknown', () => {
    expect(relativeDifference(100, 90)).toBeCloseTo(0.1, 10);
    expect(relativeDifference(90, 100)).toBeCloseTo(0.1, 10);
    expect(relativeDifference(null, 10)).toBeNull();
    expect(relativeDifference(0, 0)).toBeNull();
  });

  it('combineMarketDataSource reports the WEAKEST provenance of the filter inputs', () => {
    const gt = { value: 1, source: DATA_SOURCES.GECKOTERMINAL, asOf: NOW_ISO, stale: false } as const;
    const dp = { value: 1, source: DATA_SOURCES.DEXPAPRIKA, asOf: NOW_ISO, stale: false } as const;
    const gone = { value: 0, source: DATA_SOURCES.UNAVAILABLE, asOf: NOW_ISO, stale: true } as const;
    expect(combineMarketDataSource(gt, gt)).toBe(DATA_SOURCES.GECKOTERMINAL);
    expect(combineMarketDataSource(gt, dp)).toBe(DATA_SOURCES.DEXPAPRIKA);
    expect(combineMarketDataSource(gone, gt)).toBe(DATA_SOURCES.UNAVAILABLE);
  });
});
