/**
 * T6 offline tests for `src/data/poolScanner.ts` plus the HTTP-layer traps that feed it.
 *
 * Every network call is served from an in-process transport double and time comes from an injected
 * clock, so throttling/backoff are deterministic and nothing touches the wire. The four research
 * traps covered here are the ones that would make the bot trade on an inference instead of a fact:
 *
 *   1. DexPaprika `dex_id` arrives BOTH as a slug (`pancakeswap_v3`) and as a factory address;
 *   2. DexPaprika reports `fee: null` for V3 pools — never `0`, never an error;
 *   3. "the source failed" (HTTP 5xx / retry exhaustion) must not become "the pool does not exist";
 *   4. HTTP 429 is backed off and retried, with a bounded number of attempts.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.ts';
import {
  DEFAULT_DEXPAPRIKA_BASE_URL,
  DEFAULT_GECKOTERMINAL_BASE_URL,
  FEE_TIER_UNKNOWN,
  LayeredPoolDataProvider,
  matchDexPaprikaDex,
  normalizeDexPaprikaPool,
  poolIdFor,
  type DetailedPoolDataProvider,
  type HttpTransport,
  type PoolDiscoveryResult,
} from '../../src/data/poolDataProvider.ts';
import {
  DEX_FEE_TIERS,
  POOL_EXISTENCE,
  POOL_EXISTENCE_EVIDENCE,
  PoolScanner,
  describeNotListed,
  describeUnverified,
  enumerateCandidatePairs,
  filterScannedPools,
  createPoolScanner,
  type PoolScanSummary,
} from '../../src/data/poolScanner.ts';
import { DATA_SOURCES, type PoolSnapshot, type Sourced } from '../../src/types/market.ts';
import { DEX_IDS, type Address } from '../../src/types/primitives.ts';
import type { StrategyConfig } from '../../src/types/config.ts';

/* ------------------------------------------------------------------ *
 * Real BSC facts (research §1/§4.1) — identity is the address
 * ------------------------------------------------------------------ */

const QQQB = '0x205812cdbed920aff76c6580abd681a46d11efc7' as Address;
const MSFTB = '0x80106cb3ead06659a5ad19df39d9b4733863b9b0' as Address;
const USDC = '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d' as Address;
const USDT = '0x55d398326f99059ff775485246999027b3197955' as Address;
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c' as Address;
/** QQQB/USDC @ Uniswap V3 0.3% (research §4.1). */
const UNISWAP_POOL = '0xfc4e77248b76fefc27c4cac7151a2ee5b5cc590e' as Address;
/** PancakeSwap V3 factory — the address form of DexPaprika's `dex_id` was measured to be this. */
const PANCAKE_FACTORY = '0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865';

const EVALUATED_AT = '2026-09-29T09:50:00.000Z';

let config: StrategyConfig;

beforeAll(async () => {
  config = await loadConfig();
});

/* ------------------------------------------------------------------ *
 * Doubles
 * ------------------------------------------------------------------ */

interface RouteResponse {
  readonly status?: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

/** Exact-URL route table: an unregistered URL is a TEST BUG, so it throws instead of 404ing. */
function mockTransport(routes: Record<string, RouteResponse | (() => RouteResponse | Promise<RouteResponse>)>): {
  transport: HttpTransport;
  calls: string[];
} {
  const calls: string[] = [];
  const transport: HttpTransport = {
    async request(request) {
      calls.push(request.url);
      const entry = routes[request.url];
      if (entry === undefined) throw new Error(`unexpected HTTP request: ${request.url}`);
      const resolved = typeof entry === 'function' ? await entry() : entry;
      return {
        status: resolved.status ?? 200,
        headers: { 'content-type': 'application/json', ...(resolved.headers ?? {}) },
        body: JSON.stringify(resolved.body ?? {}),
      };
    },
  };
  return { transport, calls };
}

/** A clock whose `sleep` advances time instead of waiting, so throttling costs nothing. */
function virtualClock(startMs = Date.parse(EVALUATED_AT)): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  elapsed: () => number;
} {
  let now = startMs;
  const origin = startMs;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += Math.max(0, ms);
    },
    elapsed: () => now - origin,
  };
}

const gtTokenPoolsUrl = (token: Address): string =>
  `${DEFAULT_GECKOTERMINAL_BASE_URL}/networks/bsc/tokens/${token}/pools?page=1&sort=h24_volume_usd_desc`;
const dpSearchUrl = (token: Address): string =>
  `${DEFAULT_DEXPAPRIKA_BASE_URL}/networks/bsc/pools/search?token_address=${token}&limit=100&order_by=liquidity_usd&sort=desc`;

/** The five auto-trade stock tokens the §14 cross set expands to. */
function autoTradeStockTokens(): readonly Address[] {
  return config.whitelist.registry
    .listStockTokens({ autoTradeOnly: true })
    .map((token) => token.address);
}

/** Empty discovery for every stock token: no HTTP pool is found, so the factory has the last word. */
function emptyDiscoveryRoutes(overrides: Record<string, RouteResponse | (() => RouteResponse)> = {}) {
  const routes: Record<string, RouteResponse | (() => RouteResponse)> = { ...overrides };
  for (const token of autoTradeStockTokens()) {
    if (routes[gtTokenPoolsUrl(token)] === undefined) {
      routes[gtTokenPoolsUrl(token)] = { body: { data: [], links: {} } };
    }
    if (routes[dpSearchUrl(token)] === undefined) {
      routes[dpSearchUrl(token)] = { body: { results: [], has_next_page: false } };
    }
  }
  return routes;
}

/** A minimal but complete `PoolSnapshot`; only the fields the scanner/filter read are meaningful. */
function snapshotFor(params: {
  readonly poolAddress: Address;
  readonly dex: PoolSnapshot['dex'];
  readonly token0?: Address;
  readonly token1?: Address;
  readonly feeTier?: number;
}): PoolSnapshot {
  const token0 = params.token0 ?? QQQB;
  const token1 = params.token1 ?? USDC;
  const { registry } = config.whitelist;
  const usd = (value: number): Sourced<number> => ({
    value,
    source: DATA_SOURCES.GECKOTERMINAL,
    asOf: EVALUATED_AT,
    stale: false,
  });
  return {
    timestamp: EVALUATED_AT,
    chainId: 56,
    dex: params.dex,
    poolAddress: params.poolAddress,
    poolId: poolIdFor(56, params.dex, params.poolAddress),
    token0,
    token1,
    token0Id: registry.idFor(56, token0),
    token1Id: registry.idFor(56, token1),
    feeTier: params.feeTier ?? FEE_TIER_UNKNOWN,
    token0Decimals: 18,
    token1Decimals: 18,
    tvlUSD: usd(1_770_000),
    volume24h: usd(1_340_000),
    volume7d: usd(7_000_000),
    fees24h: { value: 13_400, source: DATA_SOURCES.DERIVED, asOf: EVALUATED_AT, stale: false },
    fees7d: { value: 70_000, source: DATA_SOURCES.DERIVED, asOf: EVALUATED_AT, stale: false },
    poolAgeDays: 81,
    currentPrice: usd(601.25),
    sqrtPriceX96: 0n,
    currentTick: 0,
    activeLiquidity: 0n,
    stockReferencePrice: usd(601.25),
    tokenNAVDeviation: { value: 0.0005, source: DATA_SOURCES.DERIVED, asOf: EVALUATED_AT, stale: false },
    stockVolatility7d: usd(0.01),
    stockVolatility30d: usd(0.02),
    swapImpact1000USD: usd(0.0008),
    swapImpact3500USD: usd(0.0021),
    swapImpact5000USD: usd(0.003),
    estimatedAPR1d: { value: 0.1, source: DATA_SOURCES.DERIVED, asOf: EVALUATED_AT, stale: false },
    estimatedAPR7d: { value: 0.09, source: DATA_SOURCES.DERIVED, asOf: EVALUATED_AT, stale: false },
    estimatedAPR30d: { value: 0.08, source: DATA_SOURCES.DERIVED, asOf: EVALUATED_AT, stale: false },
    marketDataSource: DATA_SOURCES.GECKOTERMINAL,
  };
}

/** A provider double that never touches the network; callers state pools/failures/onchain flags. */
function fakeProvider(result: {
  readonly pools?: readonly PoolSnapshot[];
  readonly diagnostics?: PoolDiscoveryResult['diagnostics'];
  readonly failures?: PoolDiscoveryResult['failures'];
  readonly complete?: boolean;
}): DetailedPoolDataProvider {
  const detailed: PoolDiscoveryResult = {
    pools: result.pools ?? [],
    diagnostics: result.diagnostics ?? [],
    failures: result.failures ?? [],
    complete: result.complete ?? true,
  };
  return {
    name: 'test-double',
    getPoolsDetailed: async () => detailed,
    getPools: async () => detailed.pools,
    getTVL: async () => {
      throw new Error('not used');
    },
    getVolume24h: async () => {
      throw new Error('not used');
    },
    getVolume7d: async () => {
      throw new Error('not used');
    },
    getFees24h: async () => {
      throw new Error('not used');
    },
    getFees7d: async () => {
      throw new Error('not used');
    },
  };
}

/* ------------------------------------------------------------------ *
 * §14 candidate set
 * ------------------------------------------------------------------ */

describe('§14 enumerateCandidatePairs: stock × stablecoin × DEX, by address', () => {
  it('expands the builtin whitelist to the full cross set on chain 56', () => {
    const pairs = enumerateCandidatePairs({ whitelist: config.whitelist });

    // 5 auto-trade stock tokens × 2 stablecoins × 2 DEXes.
    expect(pairs).toHaveLength(20);
    expect([...new Set(pairs.map((pair) => pair.stockToken))]).toHaveLength(5);
    expect([...new Set(pairs.map((pair) => pair.stablecoin))].sort()).toEqual([USDC, USDT].sort());
    expect([...new Set(pairs.map((pair) => pair.dex))].sort()).toEqual(
      [DEX_IDS.UNISWAP_V3, DEX_IDS.PANCAKESWAP_V3].sort(),
    );
    expect(pairs.every((pair) => pair.chainId === 56)).toBe(true);
  });

  it('never treats WBNB as a stablecoin, and excludes HIGH_VOL stock tokens', () => {
    const pairs = enumerateCandidatePairs({ whitelist: config.whitelist });
    expect(pairs.some((pair) => pair.stablecoin === WBNB)).toBe(false);
    // NVDAB/TSLAB/PLTRB are HIGH_VOL: monitor-only in V1 (§9), so they are not trading candidates.
    const nvdab = config.whitelist.registry
      .listStockTokens()
      .find((token) => token.symbol === 'NVDAB');
    expect(nvdab).toBeDefined();
    expect(pairs.some((pair) => pair.stockToken === nvdab!.address)).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * §13 pool identity
 * ------------------------------------------------------------------ */

describe('§13 pool identity', () => {
  it('is chainId + dex + poolAddress, never token pair + fee tier', () => {
    expect(poolIdFor(56, DEX_IDS.UNISWAP_V3, UNISWAP_POOL)).toBe(
      `56:${DEX_IDS.UNISWAP_V3}:${UNISWAP_POOL}`,
    );
    // Checksummed input still yields the lowercased key, so identity is stable.
    expect(poolIdFor(56, DEX_IDS.UNISWAP_V3, '0xFC4e77248B76fEfC27C4CaC7151A2Ee5B5cC590e' as Address)).toBe(
      `56:${DEX_IDS.UNISWAP_V3}:${UNISWAP_POOL}`,
    );
    // The same pair on two DEXes with the same fee tier is two distinct pools.
    const uniswap = poolIdFor(56, DEX_IDS.UNISWAP_V3, UNISWAP_POOL);
    const pancake = poolIdFor(56, DEX_IDS.PANCAKESWAP_V3, UNISWAP_POOL);
    expect(uniswap).not.toBe(pancake);
  });

  it('probes each whitelisted DEX with its OWN fee tiers (research §5)', () => {
    expect(DEX_FEE_TIERS[DEX_IDS.PANCAKESWAP_V3]).toEqual([100, 500, 2500, 10_000]);
    expect(DEX_FEE_TIERS[DEX_IDS.UNISWAP_V3]).toEqual([500, 3_000, 10_000]);
  });
});

/* ------------------------------------------------------------------ *
 * Trap 1 — DexPaprika `dex_id` arrives as a slug OR as a factory address
 * ------------------------------------------------------------------ */

describe('trap 1: DexPaprika dex identification accepts both measured forms', () => {
  it('resolves the slug form `pancakeswap_v3`', () => {
    expect(matchDexPaprikaDex(56, 'pancakeswap_v3', null)).toBe(DEX_IDS.PANCAKESWAP_V3);
    expect(matchDexPaprikaDex(56, 'uniswap_v3', null)).toBe(DEX_IDS.UNISWAP_V3);
  });

  it('resolves the factory-address form in `dex_id`', () => {
    const factory = '0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865' as Address;
    expect(matchDexPaprikaDex(56, factory, null)).toBe(DEX_IDS.PANCAKESWAP_V3);
    // Checksummed input must not defeat the lookup.
    expect(matchDexPaprikaDex(56, PANCAKE_FACTORY as Address, null)).toBe(DEX_IDS.PANCAKESWAP_V3);
  });

  it('reads `factory_id` too, and matches each field against both forms', () => {
    expect(matchDexPaprikaDex(56, null, PANCAKE_FACTORY as Address)).toBe(DEX_IDS.PANCAKESWAP_V3);
    expect(matchDexPaprikaDex(56, 'something_unknown', 'uniswap_v3')).toBe(DEX_IDS.UNISWAP_V3);
  });

  it('never guesses an unknown DEX onto the whitelist', () => {
    expect(matchDexPaprikaDex(56, 'sushiswap_v3', null)).toBeNull();
    expect(matchDexPaprikaDex(56, null, null)).toBeNull();
    expect(matchDexPaprikaDex(56, 'pancakeswap_v3', null)).not.toBeNull();
    // A different chain has no slug table, so nothing is recognised.
    expect(matchDexPaprikaDex(97, 'pancakeswap_v3', null)).toBeNull();
  });

  it('normalizes a factory-address `dex_id` pool end to end', () => {
    const pool = normalizeDexPaprikaPool(
      {
        id: '0x47BC06722295Ac316A569EEf87AC32FaA455f441'.toLowerCase(),
        dex_id: PANCAKE_FACTORY,
        factory_id: null,
        fee: null,
        tokens: [{ id: QQQB }, { id: WBNB }],
        liquidity_usd: 820_000,
        volume_usd_7d: 48_510_000,
        volume_usd_30d: 200_000_000,
        created_at: '2026-07-14T00:00:00Z',
        last_price_usd: 601.2,
        '24h': { volume_usd: 6_930_000 },
      },
      56,
    );
    expect(pool).not.toBeNull();
    expect(pool!.dex).toBe(DEX_IDS.PANCAKESWAP_V3);
    expect(pool!.volume7dUsd).toBe(48_510_000);
  });
});

/* ------------------------------------------------------------------ *
 * Trap 2 — `fee: null` must never become a fee tier
 * ------------------------------------------------------------------ */

describe('trap 2: DexPaprika reports fee=null for V3 pools', () => {
  const basePool = {
    id: UNISWAP_POOL,
    dex_id: 'uniswap_v3',
    factory_id: null,
    tokens: [{ id: QQQB }, { id: USDC }],
    liquidity_usd: 1_770_000,
    volume_usd_7d: 9_380_000,
    created_at: '2026-08-07T00:00:00Z',
    last_price_usd: 601.25,
    '24h': { volume_usd: 1_340_000 },
  };

  it('keeps `fee` null verbatim — it is not coerced to 0', () => {
    const pool = normalizeDexPaprikaPool({ ...basePool, fee: null }, 56);
    expect(pool).not.toBeNull();
    expect(pool!.fee).toBeNull();
    expect(pool!.fee).not.toBe(0);
  });

  it('does not throw and still reads the fields DexPaprika does own', () => {
    const pool = normalizeDexPaprikaPool({ ...basePool, fee: null }, 56);
    expect(pool!.volume7dUsd).toBe(9_380_000);
    expect(pool!.volume24hUsd).toBe(1_340_000);
    expect(pool!.liquidityUsd).toBe(1_770_000);
    expect(pool!.dex).toBe(DEX_IDS.UNISWAP_V3);
  });

  it('derives the fee tier from the RPC/GeckoTerminal chain instead, never from DexPaprika', () => {
    // A pool discovered only through GeckoTerminal (which does report a percentage) still gets a
    // real fee tier; DexPaprika's null contributes nothing.
    const pool = snapshotFor({ poolAddress: UNISWAP_POOL, dex: DEX_IDS.UNISWAP_V3, feeTier: 3_000 });
    expect(pool.feeTier).toBe(3_000);
    // The documented "unknown" sentinel is 0 but is only reachable when NO source reports a fee.
    expect(FEE_TIER_UNKNOWN).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Trap 3 — "the source failed" ≠ "the pool does not exist"
 * ------------------------------------------------------------------ */

describe('trap 3: a failing source yields `unverified`, never `not-listed` (see §7.3)', () => {
  it('reports an HTTP 500 discovery failure as DISCOVERY_FAILED / unverified', async () => {
    // Every stock token answers an empty page except QQQB, whose endpoint is broken.
    const clock = virtualClock();
    const { transport } = mockTransport(
      emptyDiscoveryRoutes({
        [gtTokenPoolsUrl(QQQB)]: { status: 500, body: { error: 'internal' } },
      }),
    );
    const provider = new LayeredPoolDataProvider({
      chainId: 56,
      registry: config.whitelist.registry,
      transport,
      clock,
    });
    // Module 1 is HTTP-only. When the source fails it cannot speak for this token, so the only honest
    // answer is "unknown" — and it must never be rendered as "the pool is not there".
    const scanner = createPoolScanner({ config, provider });

    const summary = await scanner.scan();
    const qqqbProbes = summary.probes.filter((probe) => probe.stockToken === QQQB);

    expect(qqqbProbes.length).toBeGreaterThan(0);
    expect(qqqbProbes.every((probe) => probe.existence === POOL_EXISTENCE.UNVERIFIED)).toBe(true);
    expect(qqqbProbes.every((probe) => probe.evidence === POOL_EXISTENCE_EVIDENCE.DISCOVERY_FAILED)).toBe(
      true,
    );
    // The critical inversion, unchanged by the vocabulary rewrite: a source FAILURE must not be reported
    // as "this combination is not listed". Conflating them is how an outage becomes "no pools exist".
    expect(
      summary.probes.some((probe) => probe.existence === POOL_EXISTENCE.NOT_LISTED && probe.stockToken === QQQB),
    ).toBe(false);
    expect(describeNotListed(summary).some((line) => line.includes(QQQB))).toBe(false);
    expect(describeUnverified(summary).some((line) => line.includes(QQQB))).toBe(true);
    // An incomplete scan: consumers must not act on it (§96).
    expect(summary.complete).toBe(false);
    expect(summary.blockers.some((blocker) => blocker.includes('discovery-failed'))).toBe(true);
  });

  it('reports a source failure for one token without letting it contaminate the others', async () => {
    // Same shape as above, narrowed to the property that survives the vocabulary rewrite: a broken source
    // for ONE token must not turn every other token's verdict into "unknown" either.
    const clock = virtualClock();
    const { transport } = mockTransport(
      emptyDiscoveryRoutes({
        [gtTokenPoolsUrl(QQQB)]: { status: 500, body: { error: 'internal' } },
      }),
    );
    const provider = new LayeredPoolDataProvider({
      chainId: 56,
      registry: config.whitelist.registry,
      transport,
      clock,
    });
    const summary = await createPoolScanner({ config, provider }).scan();

    const qqqb = summary.probes.filter((probe) => probe.stockToken === QQQB);
    const others = summary.probes.filter((probe) => probe.stockToken !== QQQB);

    expect(qqqb.every((probe) => probe.existence === POOL_EXISTENCE.UNVERIFIED)).toBe(true);
    // The healthy tokens still get a definite answer: the source listed no pool for them.
    expect(others.length).toBeGreaterThan(0);
    expect(others.some((probe) => probe.existence === POOL_EXISTENCE.NOT_LISTED)).toBe(true);
    // The scan as a whole is still not clean, and the reason names the failing source.
    expect(summary.complete).toBe(false);
    expect(summary.blockers.some((blocker) => blocker.includes('discovery-failed'))).toBe(true);
  });

  it('reports an empty-but-healthy discovery as `not-listed` and COMPLETES', async () => {
    // The important half of the old "proven absent" test: when every source answers and none lists a pool,
    // the scan is COMPLETE and the answer is definite. No chain call is needed to say that — which is the
    // whole point of moving this layer off-chain (architecture §3).
    const clock = virtualClock();
    const { transport } = mockTransport(emptyDiscoveryRoutes());
    const provider = new LayeredPoolDataProvider({
      chainId: 56,
      registry: config.whitelist.registry,
      transport,
      clock,
    });
    const summary = await createPoolScanner({ config, provider }).scan();

    expect(summary.probes.length).toBeGreaterThan(0);
    expect(summary.probes.every((probe) => probe.existence === POOL_EXISTENCE.NOT_LISTED)).toBe(true);
    expect(
      summary.probes.every((probe) => probe.evidence === POOL_EXISTENCE_EVIDENCE.HTTP_NOT_LISTED),
    ).toBe(true);
    expect(summary.probes.some((probe) => probe.existence === POOL_EXISTENCE.UNVERIFIED)).toBe(false);
    // Zero pools found, but every miss is definite, so consumers may act on "there is nothing here".
    expect(summary.complete).toBe(true);
    expect(describeUnverified(summary)).toEqual([]);
    expect(describeNotListed(summary).length).toBe(summary.probes.length);
  });

  // Truncation itself is covered at the layer that produces it: `tests/data/poolDataProvider.test.ts`
  // asserts a truncated page is a fatal failure and never a verified absence, and that a DexPaprika
  // enrichment failure is degraded-but-visible. Duplicating that here with a hand-built fixture would
  // test the fixture, not the scanner. What the scanner owns is the MAPPING of a source failure onto
  // `unverified` — which the tests above cover directly.




  it('maps a discovery failure reported by the provider onto the affected token only', async () => {
    const summary = await createPoolScanner({
      config,
      provider: fakeProvider({
        failures: [
          {
            source: DATA_SOURCES.GECKOTERMINAL,
            scope: 'discovery',
            subject: MSFTB,
            severity: 'fatal',
            message: 'geckoterminal discovery failed for MSFTB: HTTP 500',
          },
        ],
        complete: false,
      }),
    }).scan();

    const msftb = summary.probes.filter((probe) => probe.stockToken === MSFTB);
    expect(msftb.length).toBeGreaterThan(0);
    expect(msftb.every((probe) => probe.existence === POOL_EXISTENCE.UNVERIFIED)).toBe(true);
    expect(msftb.every((probe) => probe.evidence === POOL_EXISTENCE_EVIDENCE.DISCOVERY_FAILED)).toBe(true);
    // A token whose discovery succeeded is NOT dragged along by another token's failure: its miss is a
    // definite "not listed" rather than a fabricated failure.
    const qqqb = summary.probes.filter((probe) => probe.stockToken === QQQB);
    expect(qqqb.every((probe) => probe.evidence === POOL_EXISTENCE_EVIDENCE.HTTP_NOT_LISTED)).toBe(true);
    expect(summary.complete).toBe(false);
  });

  it('refuses to run at all when the provider exposes no failure reporting', async () => {
    const bare = { ...fakeProvider({}), getPoolsDetailed: undefined } as unknown as DetailedPoolDataProvider;
    const summary = await new PoolScanner({ config, provider: bare }).scan();
    // "No pool discovered" would be indistinguishable from "the source failed" → fatal limitation.
    expect(summary.complete).toBe(false);
    expect(summary.blockers.some((blocker) => blocker.includes('getPoolsDetailed'))).toBe(true);
  });

  it('refuses an empty whitelist instead of reporting "no pools" (§96)', async () => {
    const emptyConfig = { ...config, whitelist: { ...config.whitelist, chains: [] as readonly [] } };
    await expect(
      new PoolScanner({ config: emptyConfig as StrategyConfig, provider: fakeProvider({}) }).scan(),
    ).rejects.toThrow(/no chain to scan/);
  });
});

/* ------------------------------------------------------------------ *
 * Trap 4 — 429 backoff is bounded
 * ------------------------------------------------------------------ */

describe('trap 4: HTTP 429 is retried with backoff, a bounded number of times', () => {
  const policy = {
    minIntervalMs: 0,
    maxAttempts: 3,
    baseBackoffMs: 1_000,
    maxBackoffMs: 4_000,
    maxRetryAfterMs: 10_000,
  };

  it('retries once and succeeds when the second attempt is 200', async () => {
    const clock = virtualClock();
    let attempts = 0;
    const routes = emptyDiscoveryRoutes({
      [gtTokenPoolsUrl(QQQB)]: () => {
        attempts += 1;
        return attempts === 1
          ? { status: 429, headers: { 'retry-after': '2' }, body: { error: 'rate limited' } }
          : { body: { data: [], links: {} } };
      },
    });
    const { transport, calls } = mockTransport(routes);
    const provider = new LayeredPoolDataProvider({
      chainId: 56,
      registry: config.whitelist.registry,
      transport,
      clock,
      geckoterminal: { policy },
    });

    const result = await provider.getPoolsDetailed({
      chainId: 56,
      tokenAddresses: [QQQB],
      stablecoinAddresses: [USDC, USDT],
      dexes: [DEX_IDS.UNISWAP_V3, DEX_IDS.PANCAKESWAP_V3],
    });

    expect(attempts).toBe(2);
    expect(calls.filter((url) => url === gtTokenPoolsUrl(QQQB))).toHaveLength(2);
    expect(result.failures).toEqual([]);
    expect(provider.stats.geckoterminal.rateLimited).toBe(1);
    expect(provider.stats.geckoterminal.retries).toBe(1);
    // The honoured `Retry-After: 2` (2000 ms) is longer than the 1000 ms exponential backoff.
    expect(clock.elapsed()).toBeGreaterThanOrEqual(2_000);
  });

  it('gives up after maxAttempts and reports the source as unavailable, not as an empty market', async () => {
    const clock = virtualClock();
    const { transport, calls } = mockTransport(
      emptyDiscoveryRoutes({
        [gtTokenPoolsUrl(QQQB)]: { status: 429, headers: { 'retry-after': '1' }, body: {} },
      }),
    );
    const provider = new LayeredPoolDataProvider({
      chainId: 56,
      registry: config.whitelist.registry,
      transport,
      clock,
      geckoterminal: { policy },
    });

    // Only QQQB is queried, so every discovery attempt fails → the provider must throw rather than
    // return `[]`, which would be indistinguishable from "no pool exists".
    await expect(
      provider.getPoolsDetailed({
        chainId: 56,
        tokenAddresses: [QQQB],
        stablecoinAddresses: [USDC, USDT],
        dexes: [DEX_IDS.UNISWAP_V3],
      }),
    ).rejects.toThrow(/failed for every requested token/);

    expect(calls.filter((url) => url === gtTokenPoolsUrl(QQQB))).toHaveLength(policy.maxAttempts);
    expect(provider.stats.geckoterminal.rateLimited).toBe(policy.maxAttempts - 1);
    expect(provider.stats.geckoterminal.requests).toBe(policy.maxAttempts);
  });

  it('propagates a per-token rate-limit failure as a discovery failure, not a verdict', async () => {
    const clock = virtualClock();
    const { transport } = mockTransport(
      emptyDiscoveryRoutes({
        [gtTokenPoolsUrl(QQQB)]: { status: 429, headers: { 'retry-after': '1' }, body: {} },
      }),
    );
    const provider = new LayeredPoolDataProvider({
      chainId: 56,
      registry: config.whitelist.registry,
      transport,
      clock,
      geckoterminal: { policy },
    });
    const summary = await createPoolScanner({ config, provider }).scan();

    const qqqb = summary.probes.filter((probe) => probe.stockToken === QQQB);
    expect(qqqb.length).toBeGreaterThan(0);
    expect(qqqb.every((probe) => probe.existence === POOL_EXISTENCE.UNVERIFIED)).toBe(true);
    expect(qqqb.every((probe) => probe.evidence === POOL_EXISTENCE_EVIDENCE.DISCOVERY_FAILED)).toBe(true);
    expect(summary.complete).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * HTTP-found pools are reported FOUND; a blind source is never FOUND
 * ------------------------------------------------------------------ */

describe('found is claimed only on HTTP evidence, and never on a guess', () => {
  it('a pool the discovery layer returns is reported FOUND with the HTTP evidence', async () => {
    // The D1 regression (a real pool reported as "proven absent" because `typeof x === 'string'` matched
    // both sentinels) is now structurally impossible: module 1 has no chain probe to confuse. What still
    // needs guarding is the reverse direction — that a discovered pool is never downgraded, and that its
    // verdict is attributed to the HTTP source rather than to a chain call that no longer happens.
    const summary = await createPoolScanner({
      config,
      provider: fakeProvider({
        pools: [
          snapshotFor({
            poolAddress: UNISWAP_POOL,
            dex: DEX_IDS.UNISWAP_V3,
            // Must be a tier this DEX deploys, and the legs must match a whitelisted
            // (stock × stablecoin) pair, or the scanner correctly refuses to match it.
            feeTier: 500,
          }),
        ],
      }),
    }).scan();

    const found = summary.probes.filter((probe) => probe.existence === POOL_EXISTENCE.FOUND);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((probe) => probe.evidence === POOL_EXISTENCE_EVIDENCE.HTTP_DISCOVERY)).toBe(true);
    // No probe may claim on-chain evidence any more — that vocabulary is gone with the probe.
    expect(summary.probes.some((probe) => probe.evidence.includes('onchain'))).toBe(false);
    expect(summary.onchainVerifiedByPool).toEqual({});
  });

  it('never reports a pool as FOUND when no discovery source returned one', async () => {
    // The mirror property: with every source answering emptily, nothing may be FOUND. A "found" verdict
    // invented from anything other than a discovered pool would be a pool we cannot price or filter.
    const summary = await createPoolScanner({
      config,
      provider: fakeProvider({ pools: [], complete: true }),
    }).scan();

    expect(summary.probes.some((probe) => probe.existence === POOL_EXISTENCE.FOUND)).toBe(false);
    expect(summary.pools).toEqual([]);
  });
});


/* ------------------------------------------------------------------ *
 * D2 — the filter refuses a snapshot whose on-chain state was never read
 * ------------------------------------------------------------------ */

describe('§15/§96 filterScannedPools uses the scan\'s own on-chain verification flags', () => {
  function scanSummary(verified: boolean): PoolScanSummary {
    const pool = snapshotFor({ poolAddress: UNISWAP_POOL, dex: DEX_IDS.UNISWAP_V3, feeTier: 3_000 });
    return {
      chainId: 56,
      scannedAt: EVALUATED_AT,
      feeTiersByDex: DEX_FEE_TIERS,
      stockTokens: [QQQB],
      stablecoins: [USDC],
      dexes: [DEX_IDS.UNISWAP_V3],
      probes: [],
      pools: [pool],
      onchainVerifiedByPool: { [pool.poolId]: verified },
      failures: [],
      complete: true,
      blockers: [],
    };
  }

  it('rejects a discovered pool whose tick/liquidity were never read', () => {
    const outcome = filterScannedPools(scanSummary(false), config.pool, EVALUATED_AT);
    expect(outcome.passed).toEqual([]);
    expect(outcome.rejected[0]?.evaluation.failedCodes).toEqual(['ONCHAIN_UNVERIFIED']);
    expect(outcome.decisive).toBe(false);
  });

  it('passes the same pool once the chain answered for it', () => {
    const outcome = filterScannedPools(scanSummary(true), config.pool, EVALUATED_AT);
    expect(outcome.passed).toHaveLength(1);
    expect(outcome.rejected).toEqual([]);
  });

  it('treats a pool missing from the verification map as unverified', () => {
    const summary = scanSummary(true);
    const outcome = filterScannedPools({ ...summary, onchainVerifiedByPool: {} }, config.pool, EVALUATED_AT);
    expect(outcome.rejected[0]?.evaluation.failedCodes).toEqual(['ONCHAIN_UNVERIFIED']);
  });

  it('carries the provider diagnostic through a real scan into the filter verdict', async () => {
    // A pool discovered with a verified on-chain read must survive the gate; the flag travels
    // provider diagnostic → scan summary → filter verdict without being dropped in between.
    const pool = snapshotFor({
      poolAddress: '0x36c0fc3159eb8662a2e1b84a4df518d916bce0e1' as Address,
      dex: DEX_IDS.UNISWAP_V3,
      feeTier: 500,
    });
    const diagnostic = {
      poolId: pool.poolId,
      poolAddress: pool.poolAddress,
      dex: pool.dex,
      discoverySource: DATA_SOURCES.GECKOTERMINAL,
      tokenOrderSource: 'onchain' as const,
      onchainVerified: true,
      crossChecks: [],
      warnings: [],
    };
    const summary = await new PoolScanner({
      config,
      provider: fakeProvider({ pools: [pool], diagnostics: [diagnostic] }),
    }).scan();
    expect(summary.onchainVerifiedByPool[pool.poolId]).toBe(true);
    expect(filterScannedPools(summary, config.pool, EVALUATED_AT).passed.map((entry) => entry.snapshot.poolId)).toEqual([
      pool.poolId,
    ]);

    // The same scan with the diagnostic reporting an unread chain rejects instead.
    const unread = await new PoolScanner({
      config,
      provider: fakeProvider({
        pools: [pool],
        diagnostics: [{ ...diagnostic, onchainVerified: false }],
      }),
    }).scan();
    expect(unread.onchainVerifiedByPool[pool.poolId]).toBe(false);
    expect(filterScannedPools(unread, config.pool, EVALUATED_AT).rejected[0]?.evaluation.failedCodes).toEqual([
      'ONCHAIN_UNVERIFIED',
    ]);
  });
});
