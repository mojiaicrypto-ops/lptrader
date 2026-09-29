/**
 * §83 `PoolDataProvider` — the three-layer market-data discovery layer.
 *
 * LAYERS (research `onchain-facts-2026-09-29.md` §4.4). Each layer is used for what only it can
 * provide; nothing is silently substituted:
 *
 *   1. GeckoTerminal (keyless) — pool discovery, `pool_fee_percentage`, TVL, 24h volume,
 *      `pool_created_at`, daily OHLCV (the only keyless history source). ~10 req/min observed ⇒
 *      requests are throttled and HTTP 429 is backed off (`RequestScheduler`).
 *   2. DexPaprika (keyless / free key) — `volume_usd_7d` / `volume_usd_30d` and `created_at`.
 *      Its `fee` field is **null for every V3 pool** (verified 2026-09-29) so it is NEVER read as a
 *      fee tier: a null must not be coerced into `0`.
 *   3. BSC RPC (`PoolStateSource`, wired to `src/chain/**`) — the *truth* for `fee`, `tick`,
 *      `liquidity`, the canonical `token0/token1` order, pool reserves and QuoterV2 swap quotes.
 *      No free HTTP API exposes tick/liquidity/fee, so without this layer those fields are
 *      `unavailable` and the §16 swap-impact filter cannot pass (fail closed).
 *
 * CANONICAL-FIELD POLICY — each field has exactly ONE canonical source; every other source is only
 * ever recorded as a cross-check. Nothing is averaged and nothing is silently mixed:
 *
 *   | field                     | canonical                             | cross-check / fallback |
 *   |---------------------------|---------------------------------------|---------------------------------------------------|
 *   | tvlUSD                    | GeckoTerminal `reserve_in_usd`        | DexPaprika `liquidity_usd`; on-chain reserves × unit prices |
 *   | volume24h                 | GeckoTerminal `volume_usd.h24`        | DexPaprika `volume_usd_24h` |
 *   | volume7d                  | DexPaprika `volume_usd_7d`            | GeckoTerminal daily-OHLCV sum (GT has no 7d field) |
 *   | volume30d (APR only)      | DexPaprika `volume_usd_30d`           | — (absent ⇒ `estimatedAPR30d` unavailable) |
 *   | fees24h / fees7d          | **derived** = volume × feeTier        | never measured (`source: 'derived'`) |
 *   | feeTier                   | RPC `fee()`                           | GeckoTerminal `pool_fee_percentage` × 10 000. DexPaprika excluded (`fee: null`) |
 *   | currentTick / sqrtPrice   | RPC `slot0()`                         | — |
 *   | activeLiquidity           | RPC `liquidity()`                     | — |
 *   | poolAgeDays / createdAt   | GeckoTerminal `pool_created_at`       | DexPaprika `created_at` |
 *   | currentPrice              | GeckoTerminal base-token USD price    | DexPaprika `last_price_usd`; on-chain mid × quote USD |
 *   | swapImpact{1000,3500,5000}| QuoterV2 quote vs pool mid           | — (RPC only) |
 *   | stockReferencePrice       | injected §84 provider                 | — |
 *   | tokenNAVDeviation         | `abs(price / referenceNAV − 1)`       | — |
 *   | stockVolatility7d/30d     | GeckoTerminal daily OHLCV closes      | — |
 *
 * DIVERGENCE HANDLING — the measured cross-source gap is ~3% (research §4.4). Past
 * `CROSS_CHECK_DIVERGENCE_TOLERANCE` (10%) the field carries a `warning`; past
 * `CROSS_CHECK_CRITICAL_TOLERANCE` (25%) the canonical field is additionally marked `stale`, so
 * every consumer fails closed (§96) instead of trading on a number two sources disagree about.
 * The alternate value always survives in `PoolDiagnostic.crossChecks` for audit.
 *
 * FAIL CLOSED — `getPoolsDetailed` distinguishes "the pool does not exist" from "a source failed":
 * per-token failures are recorded in `failures`, `complete` goes false, and when *every* requested
 * token failed the call throws rather than returning `[]`.
 *
 * UNITS — `PriceUsd`/`UsdAmount`/`Ratio` are `number` (display + thresholds only); raw amounts are
 * `bigint` carrying their decimals (`primitives.ts` UNITAGREEMENT). BSC USDC/USDT are 18 decimals.
 */
import { z } from 'zod';
import type {
  PoolDataProvider,
  PoolDiscoveryQuery,
  ReferencePriceProvider,
} from '../types/adapters.ts';
import { DATA_SOURCES, type DataSource, type PoolSnapshot, type Sourced } from '../types/market.ts';
import {
  DEX_IDS,
  type Address,
  type ChainId,
  type DexId,
  type FeeTier,
  type IsoTimestamp,
  type PoolId,
  type PriceUsd,
  type Ratio,
  type Tick,
  type UsdAmount,
} from '../types/primitives.ts';
import type { TokenRegistry } from '../types/registry.ts';
import { BSC_DEX_CONTRACTS } from '../config/builtins.ts';
import { toFloat } from '../util/decimal.ts';

// ---------------------------------------------------------------------------------------------
// Identity (§13)
// ---------------------------------------------------------------------------------------------

/**
 * §13 pool identity: `chainId + dex + poolAddress`. Never `token0 + token1 + feeTier`.
 * The address is lowercased so the key is stable regardless of checksummed input, mirroring
 * `tokenIdFor` in `src/config/registry.ts`.
 */
export function poolIdFor(chainId: ChainId, dex: DexId, poolAddress: Address): PoolId {
  return `${chainId}:${dex}:${poolAddress.toLowerCase()}`;
}

/** Inverse of `poolIdFor`; throws when the key is not shaped like a §13 identity. */
export function parsePoolId(poolId: PoolId): {
  chainId: ChainId;
  dex: DexId;
  poolAddress: Address;
} {
  const parts = poolId.split(':');
  const [chainRaw, dexRaw, addressRaw] = parts;
  if (parts.length !== 3 || chainRaw === undefined || dexRaw === undefined || addressRaw === undefined) {
    throw new PoolDataError(
      POOL_DATA_ERROR_CODES.POOL_ID_MALFORMED,
      `pool id is not "chainId:dex:poolAddress": ${poolId}`,
    );
  }
  const chainId = Number(chainRaw);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new PoolDataError(POOL_DATA_ERROR_CODES.POOL_ID_MALFORMED, `bad chain id in ${poolId}`);
  }
  if (dexRaw !== DEX_IDS.UNISWAP_V3 && dexRaw !== DEX_IDS.PANCAKESWAP_V3) {
    throw new PoolDataError(POOL_DATA_ERROR_CODES.POOL_ID_MALFORMED, `unknown dex in ${poolId}`);
  }
  return { chainId, dex: dexRaw, poolAddress: addressRaw.toLowerCase() as Address };
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

export const POOL_DATA_ERROR_CODES = {
  /** No HTTP layer could be read at all; nothing may be concluded from the attempt. */
  SOURCE_UNAVAILABLE: 'SOURCE_UNAVAILABLE',
  /** 429 persisted past the retry budget. */
  RATE_LIMIT_EXHAUSTED: 'RATE_LIMIT_EXHAUSTED',
  /** A response arrived but could not be decoded into the expected shape. */
  BAD_RESPONSE: 'BAD_RESPONSE',
  /** Caller error: unknown chain, empty token list, malformed pool id, unwhitelisted leg. */
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  POOL_ID_MALFORMED: 'POOL_ID_MALFORMED',
} as const;
export type PoolDataErrorCode = (typeof POOL_DATA_ERROR_CODES)[keyof typeof POOL_DATA_ERROR_CODES];

export class PoolDataError extends Error {
  readonly code: PoolDataErrorCode;
  readonly source?: DataSource;
  readonly url?: string;

  constructor(
    code: PoolDataErrorCode,
    message: string,
    context: { source?: DataSource; url?: string } = {},
  ) {
    super(message);
    this.name = 'PoolDataError';
    this.code = code;
    if (context.source !== undefined) this.source = context.source;
    if (context.url !== undefined) this.url = context.url;
  }
}

// ---------------------------------------------------------------------------------------------
// Time, rate limiting, caching
// ---------------------------------------------------------------------------------------------

/** Injectable clock so throttling / backoff / TTLs are deterministic in tests. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

export interface RateLimitPolicy {
  /** Minimum spacing between two requests to the same host (the observed 429 guard). */
  readonly minIntervalMs: number;
  /** Total attempts per request, retries included. `1` disables retrying. */
  readonly maxAttempts: number;
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
  /** Upper bound on an honoured `Retry-After`; a broken value must not stall the bot. */
  readonly maxRetryAfterMs: number;
}

/** Research §4.4: GeckoTerminal allows ~10 req/min and 429s were measured. */
export const DEFAULT_GECKOTERMINAL_RATE_LIMIT: RateLimitPolicy = {
  minIntervalMs: 6_000,
  maxAttempts: 4,
  baseBackoffMs: 1_000,
  maxBackoffMs: 30_000,
  maxRetryAfterMs: 60_000,
};

/** DexPaprika reports `ratelimit-limit: 10` per minute on `/pools/search`. */
export const DEFAULT_DEXPAPRIKA_RATE_LIMIT: RateLimitPolicy = {
  minIntervalMs: 6_000,
  maxAttempts: 4,
  baseBackoffMs: 1_000,
  maxBackoffMs: 30_000,
  maxRetryAfterMs: 60_000,
};

export interface SchedulerStats {
  readonly requests: number;
  readonly throttledWaits: number;
  readonly retries: number;
  readonly rateLimited: number;
  /** Timestamps (epoch ms) of every 429 seen — the observable backoff evidence. */
  readonly rateLimitedAtMs: readonly number[];
}

export const EMPTY_SCHEDULER_STATS: SchedulerStats = {
  requests: 0,
  throttledWaits: 0,
  retries: 0,
  rateLimited: 0,
  rateLimitedAtMs: [],
};

/**
 * Serializes requests to one host, enforces a minimum interval between them, and retries 429/5xx
 * with exponential backoff (honouring `Retry-After`). GeckoTerminal tolerates a short burst but
 * returns 429 under sustained traffic, so both throttling and backoff are required.
 */
export class RequestScheduler {
  readonly #label: string;
  readonly #policy: RateLimitPolicy;
  readonly #clock: Clock;
  #nextAllowedAt = 0;
  #gate: Promise<void> = Promise.resolve();
  #stats: SchedulerStats = EMPTY_SCHEDULER_STATS;

  constructor(options: { label: string; policy: RateLimitPolicy; clock?: Clock }) {
    this.#label = options.label;
    this.#policy = options.policy;
    this.#clock = options.clock ?? systemClock;
  }

  get stats(): SchedulerStats {
    return { ...this.#stats, rateLimitedAtMs: [...this.#stats.rateLimitedAtMs] };
  }

  /**
   * Run one HTTP request through the throttle/backoff gate.
   *
   * 429 and 5xx are retried; any other 4xx is returned unchanged because it is a permanent answer
   * (e.g. DexPaprika's HTTP 410 for a removed endpoint) and must reach the caller intact.
   */
  async send(perform: () => Promise<HttpResponse>): Promise<HttpResponse> {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= this.#policy.maxAttempts; attempt += 1) {
      await this.#waitForTurn();
      this.#stats = { ...this.#stats, requests: this.#stats.requests + 1 };

      let response: HttpResponse | null = null;
      try {
        response = await perform();
      } catch (error) {
        lastError = error;
      }

      if (response !== null && response.status !== 429 && response.status < 500) {
        return response;
      }

      if (attempt === this.#policy.maxAttempts) {
        // Exhausted: hand a real HTTP response back so the caller raises a precise error.
        if (response !== null) return response;
        throw new PoolDataError(
          POOL_DATA_ERROR_CODES.SOURCE_UNAVAILABLE,
          `${this.#label}: request failed on all ${attempt} attempts: ${describeError(lastError)}`,
          { source: this.#source },
        );
      }

      if (response !== null && response.status === 429) {
        this.#stats = {
          ...this.#stats,
          rateLimited: this.#stats.rateLimited + 1,
          rateLimitedAtMs: [...this.#stats.rateLimitedAtMs, this.#clock.now()],
        };
      }
      this.#stats = { ...this.#stats, retries: this.#stats.retries + 1 };

      const retryAfterMs = response === null ? null : parseRetryAfterMs(response, this.#clock);
      const backoff = this.#backoffMs(attempt, retryAfterMs);
      this.#nextAllowedAt = Math.max(this.#nextAllowedAt, this.#clock.now() + backoff);
      const waitMs = this.#nextAllowedAt - this.#clock.now();
      if (waitMs > 0) await this.#clock.sleep(waitMs);
    }
    throw new PoolDataError(
      POOL_DATA_ERROR_CODES.SOURCE_UNAVAILABLE,
      `${this.#label}: retry loop exited without a result`,
      { source: this.#source },
    );
  }

  get #source(): DataSource {
    return this.#label.startsWith('dexpaprika')
      ? DATA_SOURCES.DEXPAPRIKA
      : DATA_SOURCES.GECKOTERMINAL;
  }

  /** `max(Retry-After, exponential)` so an honest server hint is never shortened. */
  #backoffMs(attempt: number, retryAfterMs: number | null): number {
    const exponential = Math.min(
      this.#policy.maxBackoffMs,
      this.#policy.baseBackoffMs * 2 ** (attempt - 1),
    );
    if (retryAfterMs === null) return exponential;
    return Math.min(this.#policy.maxRetryAfterMs, Math.max(exponential, retryAfterMs));
  }

  /** Serializes callers so the minimum interval is actually observed under concurrency. */
  async #waitForTurn(): Promise<void> {
    const turn = this.#gate.then(async () => {
      const waitMs = this.#nextAllowedAt - this.#clock.now();
      if (waitMs > 0) {
        this.#stats = { ...this.#stats, throttledWaits: this.#stats.throttledWaits + 1 };
        await this.#clock.sleep(waitMs);
      }
      this.#nextAllowedAt = this.#clock.now() + this.#policy.minIntervalMs;
    });
    // The gate must never reject, otherwise one failure would poison every later request.
    this.#gate = turn.then(
      () => undefined,
      () => undefined,
    );
    await turn;
  }
}

/** `Retry-After` is either delta-seconds or an HTTP date; anything else is ignored. */
export function parseRetryAfterMs(response: HttpResponse, clock: Clock = systemClock): number | null {
  const raw = response.headers['retry-after'];
  if (raw === undefined) return null;
  const seconds = Number(raw.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - clock.now()) : null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** TTL cache keyed by request identity: a read path must not re-fetch inside its TTL. */
export class TtlCache {
  readonly #entries = new Map<string, { readonly value: unknown; readonly expiresAt: number }>();
  readonly #clock: Clock;

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  get<T>(key: string): T | null {
    const entry = this.#entries.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAt <= this.#clock.now()) {
      this.#entries.delete(key);
      return null;
    }
    return entry.value as T;
  }

  set(key: string, value: unknown, ttlMs: number): void {
    if (ttlMs <= 0) return;
    this.#entries.set(key, { value, expiresAt: this.#clock.now() + ttlMs });
  }

  get size(): number {
    return this.#entries.size;
  }
}

// ---------------------------------------------------------------------------------------------
// HTTP transport
// ---------------------------------------------------------------------------------------------

export interface HttpRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface HttpResponse {
  readonly status: number;
  /** Lowercased header names. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface HttpTransport {
  request(request: HttpRequest): Promise<HttpResponse>;
}

/** `globalThis.fetch` transport (Node >= 22.6 — no dependency needed). */
export class FetchHttpTransport implements HttpTransport {
  async request(request: HttpRequest): Promise<HttpResponse> {
    const response = await fetch(request.url, {
      method: 'GET',
      headers: { ...request.headers },
      redirect: 'follow',
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((value: string, name: string) => {
      headers[name.toLowerCase()] = value;
    });
    return { status: response.status, headers, body: await response.text() };
  }
}

// ---------------------------------------------------------------------------------------------
// On-chain truth — the narrow wiring point to `src/chain/**` (T4/T5)
// ---------------------------------------------------------------------------------------------

/**
 * On-chain pool state: the RPC truth for `fee`/`tick`/`liquidity` and the canonical token order.
 * Implemented by `src/chain/**` (`ChainAdapter` + pool reader); the provider depends only on this
 * narrow shape, so the whole policy is testable without an RPC.
 */
export interface OnchainPoolState {
  readonly poolAddress: Address;
  /** Raw `token0()` — canonical order, never inferred from symbols. */
  readonly token0: Address;
  readonly token1: Address;
  /** Raw `fee()` in hundredths of a bip: 100 | 500 | 2500 | 3000 | 10000. */
  readonly feeTier: FeeTier;
  readonly tickSpacing: number;
  readonly sqrtPriceX96: bigint;
  readonly tick: Tick;
  /** `liquidity()`. `0n` is legal (fully out of range) — it is not an error. */
  readonly liquidity: bigint;
  readonly asOf: IsoTimestamp;
}

/** Raw ERC-20 reserves of a pool (`balanceOf(pool)`), for the TVL reserve cross-check. */
export interface OnchainPoolReserves {
  readonly poolAddress: Address;
  readonly token0Raw: bigint;
  readonly token1Raw: bigint;
  readonly asOf: IsoTimestamp;
}

export interface PoolStateSource {
  readonly chainId: ChainId;
  /**
   * Batched on-chain truth. MUST throw when the read fails: a zeroed pool state would be
   * indistinguishable from a real empty pool (fail closed, §96).
   */
  readPoolStates(poolAddresses: readonly Address[]): Promise<readonly OnchainPoolState[]>;
  /** Optional: raw pool reserves, used for the TVL cross-check. */
  readPoolReserves?(poolAddresses: readonly Address[]): Promise<readonly OnchainPoolReserves[]>;
  /** Optional: `factory.getPool(tokenA, tokenB, fee)`; `null` means no such pool exists (§13). */
  findPool?(params: {
    readonly dex: DexId;
    readonly tokenA: Address;
    readonly tokenB: Address;
    readonly feeTier: FeeTier;
  }): Promise<Address | null>;
  /** Optional: QuoterV2 `quoteExactInputSingle`, RAW in → RAW out. */
  quoteExactInputSingle?(params: {
    readonly dex: DexId;
    readonly poolAddress: Address;
    readonly tokenIn: Address;
    readonly tokenOut: Address;
    readonly amountInRaw: bigint;
    readonly feeTier: FeeTier;
  }): Promise<bigint>;
}

// ---------------------------------------------------------------------------------------------
// Provenance / diagnostic records (audit-only; not part of the frozen contracts)
// ---------------------------------------------------------------------------------------------

export type CrossCheckField =
  | 'tvlUSD'
  | 'tvlReservesUsd'
  | 'volume24h'
  | 'volume7d'
  | 'currentPrice'
  | 'createdAt';

export interface PoolFieldCrossCheck {
  readonly field: CrossCheckField;
  readonly canonicalSource: DataSource;
  readonly canonicalValue: number | null;
  readonly crossSource: DataSource;
  readonly crossValue: number | null;
  /** `|canonical − cross| / max(|canonical|, |cross|)`; `null` when either side is unknown. */
  readonly relativeDiff: number | null;
  readonly divergent: boolean;
  readonly severity: 'info' | 'warning' | 'critical';
  readonly note: string;
}

export interface PoolDiagnostic {
  readonly poolId: PoolId;
  readonly poolAddress: Address;
  readonly dex: DexId;
  readonly discoverySource: DataSource;
  /** Where the canonical `token0`/`token1` ordering came from. */
  readonly tokenOrderSource: 'onchain' | 'geckoterminal';
  readonly onchainVerified: boolean;
  readonly crossChecks: readonly PoolFieldCrossCheck[];
  readonly warnings: readonly string[];
}

export const POOL_SOURCE_FAILURE_SEVERITIES = {
  /** Affects an existence determination or a filter-critical field with no fallback. */
  FATAL: 'fatal',
  /** The canonical source failed but a documented fallback supplied the field. */
  DEGRADED: 'degraded',
} as const;
export type PoolSourceFailureSeverity =
  (typeof POOL_SOURCE_FAILURE_SEVERITIES)[keyof typeof POOL_SOURCE_FAILURE_SEVERITIES];

export interface PoolSourceFailure {
  readonly source: DataSource;
  readonly scope: 'discovery' | 'enrichment' | 'onchain' | 'reference';
  /** Token or pool address the failure applies to. */
  readonly subject?: Address;
  readonly severity: PoolSourceFailureSeverity;
  readonly message: string;
}

export interface PoolDiscoveryResult {
  readonly pools: readonly PoolSnapshot[];
  readonly diagnostics: readonly PoolDiagnostic[];
  readonly failures: readonly PoolSourceFailure[];
  /** False when any `fatal` failure occurred — consumers must then not act (§96). */
  readonly complete: boolean;
}

/** The provider's richer surface; the frozen `PoolDataProvider` is a strict subset. */
export interface DetailedPoolDataProvider extends PoolDataProvider {
  getPoolsDetailed(query: PoolDiscoveryQuery): Promise<PoolDiscoveryResult>;
}

/** Dogfoods a `PoolDataProvider` (e.g. a test double) for the richer discovery surface. */
export function supportsDetail(value: unknown): value is DetailedPoolDataProvider {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { getPoolsDetailed?: unknown }).getPoolsDetailed === 'function'
  );
}

// ---------------------------------------------------------------------------------------------
// Tolerances and network constants
// ---------------------------------------------------------------------------------------------

/** Measured cross-source gap is ~3%; 10% is the "investigate" line. */
export const CROSS_CHECK_DIVERGENCE_TOLERANCE = 0.1;
/** Past this the canonical value is also marked `stale`: two sources cannot both be right. */
export const CROSS_CHECK_CRITICAL_TOLERANCE = 0.25;

/** §16 `fees24h`/`fees7d` derivation: fee tier is hundredths of a bip, i.e. `/1e6` for a ratio. */
export const FEE_TIER_TO_RATIO = 1_000_000;

/**
 * §16 filter input. `3500` feeds `swapImpact3500USD`; the other two are reported for audit and for
 * §23 (Liquidity Score) but are not gates.
 */
export const SWAP_IMPACT_NOTIONALS_USD = [1_000, 3_500, 5_000] as const;

/** `PoolSnapshot.feeTier` has no `Sourced` wrapper; `0` is the documented "unknown" sentinel. */
export const FEE_TIER_UNKNOWN = 0;

export const GECKOTERMINAL_NETWORKS: Readonly<Record<ChainId, string>> = { 56: 'bsc' };
export const DEXPAPRIKA_NETWORKS: Readonly<Record<ChainId, string>> = { 56: 'bsc' };

/** GeckoTerminal dex relationship ids (verified live: `uniswap-bsc`, `pancakeswap-v3-bsc`). */
export const GECKOTERMINAL_DEX_IDS: Readonly<Record<ChainId, Readonly<Record<string, DexId>>>> = {
  56: {
    'uniswap-bsc': DEX_IDS.UNISWAP_V3,
    'pancakeswap-v3-bsc': DEX_IDS.PANCAKESWAP_V3,
  },
};

/**
 * DexPaprika dex slugs. Verified live: `dex_id` carries the slug (`pancakeswap_v3`), while
 * `factory_id` carries the factory address — but `dex_id` itself has also been observed carrying an
 * address, so both fields are matched against both slug and address (`matchDexPaprikaDex`).
 */
export const DEXPAPRIKA_DEX_SLUGS: Readonly<Record<ChainId, Readonly<Record<string, DexId>>>> = {
  56: {
    pancakeswap_v3: DEX_IDS.PANCAKESWAP_V3,
    uniswap_v3: DEX_IDS.UNISWAP_V3,
  },
};

/** Lowercased factory address → DEX, from the landed address facts in `src/config/builtins.ts`. */
export function dexByFactoryAddress(chainId: ChainId): Readonly<Record<string, DexId>> {
  if (chainId !== 56) return {};
  const map: Record<string, DexId> = {};
  for (const [dex, contracts] of Object.entries(BSC_DEX_CONTRACTS)) {
    map[contracts.factory.toLowerCase()] = dex as DexId;
  }
  return map;
}

/**
 * Resolve a DexPaprika pool onto a whitelisted DEX. `dex_id` and `factory_id` are both inspected
 * and each may hold a slug or an address. A value matching neither yields `null` so the pool is
 * dropped instead of being guessed onto a whitelisted DEX (§12).
 */
export function matchDexPaprikaDex(
  chainId: ChainId,
  dexIdRaw: string | null,
  factoryIdRaw: string | null,
): DexId | null {
  const slugs = DEXPAPRIKA_DEX_SLUGS[chainId] ?? {};
  const factories = dexByFactoryAddress(chainId);
  for (const candidate of [dexIdRaw, factoryIdRaw]) {
    if (candidate === null) continue;
    const normalized = candidate.toLowerCase();
    const slugMatch = slugs[normalized];
    if (slugMatch !== undefined) return slugMatch;
    const factoryMatch = factories[normalized];
    if (factoryMatch !== undefined) return factoryMatch;
  }
  return null;
}

/** GeckoTerminal dex relationship id → whitelisted DEX id. */
export function matchGeckoTerminalDex(chainId: ChainId, dexIdRaw: string | null): DexId | null {
  if (dexIdRaw === null) return null;
  return GECKOTERMINAL_DEX_IDS[chainId]?.[dexIdRaw.toLowerCase()] ?? null;
}

// ---------------------------------------------------------------------------------------------
// Wire schemas — every external shape is parsed ONCE at the boundary (repo convention: zod)
// ---------------------------------------------------------------------------------------------

/** Vendor payloads are lenient: a bad value becomes `null` rather than throwing the whole page. */
const numberish = z
  .union([z.number(), z.string()])
  .transform((value) => {
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  })
  .catch(null);
const stringish = z.union([z.string(), z.null()]).catch(null);

const gtRelationship = z.object({
  data: z.object({ id: z.string() }).optional(),
});

const gtPoolSchema = z.object({
  attributes: z.object({
    address: z.string(),
    pool_fee_percentage: numberish.optional(),
    pool_created_at: z.string().optional(),
    base_token_price_usd: numberish.optional(),
    quote_token_price_usd: numberish.optional(),
    reserve_in_usd: numberish.optional(),
    volume_usd: z.object({ h24: numberish.optional() }).optional(),
  }),
  relationships: z
    .object({
      dex: gtRelationship.optional(),
      base_token: gtRelationship.optional(),
      quote_token: gtRelationship.optional(),
    })
    .optional(),
});

const gtListSchema = z.object({
  data: z.array(z.unknown()),
  links: z.object({ next: z.string().optional() }).optional(),
});

const gtPoolDetailSchema = z.object({ data: z.unknown() });

const gtOhlcvSchema = z.object({
  data: z.object({
    attributes: z.object({ ohlcv_list: z.array(z.array(z.unknown())) }),
  }),
});

const dpPoolSchema = z.object({
  id: z.string(),
  dex_id: z.string().nullish(),
  factory_id: z.string().nullish(),
  /** `null` for every V3 pool; a null is NEVER a fee tier. */
  fee: numberish.nullish(),
  tokens: z.array(z.object({ id: z.string() })).optional(),
  liquidity_usd: numberish.optional(),
  volume_usd_7d: numberish.optional(),
  volume_usd_30d: numberish.optional(),
  created_at: z.string().nullish(),
  last_price_usd: numberish.optional(),
  '24h': z.object({ volume_usd: numberish.optional() }).optional(),
});

const dpSearchSchema = z.object({
  results: z.array(z.unknown()),
  has_next_page: z.boolean().optional(),
  next_cursor: z.string().nullish(),
});

// ---------------------------------------------------------------------------------------------
// Normalized wire types
// ---------------------------------------------------------------------------------------------

export interface GeckoTerminalPool {
  readonly poolAddress: Address;
  readonly dex: DexId | null;
  readonly dexIdRaw: string | null;
  /** GT's "base" leg; either leg of the pair, which is why on-chain order is canonical. */
  readonly baseToken: Address | null;
  readonly quoteToken: Address | null;
  readonly priceBaseUsd: number | null;
  readonly priceQuoteUsd: number | null;
  readonly reserveInUsd: number | null;
  readonly volume24hUsd: number | null;
  readonly createdAt: IsoTimestamp | null;
  /** `pool_fee_percentage` (%): detail/multi endpoints only, `null` on list pages. */
  readonly feePercent: number | null;
}

export interface GeckoTerminalCandle {
  readonly timestampSeconds: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volumeUsd: number;
}

export interface DexPaprikaPool {
  readonly poolAddress: Address;
  readonly dex: DexId | null;
  readonly dexIdRaw: string | null;
  readonly factoryId: string | null;
  /** Raw `fee` field verbatim: `null` for V3 pools, never read as a fee tier. */
  readonly fee: number | null;
  readonly tokenAddresses: readonly Address[];
  readonly liquidityUsd: number | null;
  readonly volume24hUsd: number | null;
  readonly volume7dUsd: number | null;
  readonly volume30dUsd: number | null;
  readonly createdAt: IsoTimestamp | null;
  readonly lastPriceUsd: number | null;
}

// ---------------------------------------------------------------------------------------------
// JSON client
// ---------------------------------------------------------------------------------------------

interface JsonClientOptions {
  readonly label: string;
  readonly baseUrl: string;
  readonly source: DataSource;
  readonly transport: HttpTransport;
  readonly scheduler: RequestScheduler;
  readonly cache: TtlCache;
  /** Sent as `apiKeyHeader` when present. Both vendors take the raw key, without a scheme. */
  readonly apiKey?: string;
  readonly apiKeyHeader?: string;
}

class JsonHttpClient {
  readonly #label: string;
  readonly #baseUrl: string;
  readonly #source: DataSource;
  readonly #transport: HttpTransport;
  readonly #scheduler: RequestScheduler;
  readonly #cache: TtlCache;
  readonly #headers: Readonly<Record<string, string>>;

  readonly scheduler: RequestScheduler;
  readonly source: DataSource;

  constructor(options: JsonClientOptions) {
    this.#label = options.label;
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#source = options.source;
    this.scheduler = options.scheduler;
    this.source = options.source;
    this.#transport = options.transport;
    this.#scheduler = options.scheduler;
    this.#cache = options.cache;
    this.#headers = {
      accept: 'application/json',
      'user-agent': 'lptrader/0.1 (pool-scanner; read-only)',
      // DexPaprika expects the raw key as the whole `Authorization` value (no `Bearer` scheme);
      // GeckoTerminal (CoinGecko demo) expects `x-cg-demo-api-key`. Both are optional.
      ...(options.apiKey === undefined || options.apiKeyHeader === undefined
        ? {}
        : { [options.apiKeyHeader]: options.apiKey }),
    };
  }

  /** Cached, throttled GET returning parsed JSON. Throws `PoolDataError` on any non-2xx. */
  async getJson(
    path: string,
    query: Readonly<Record<string, string | number | boolean | undefined>>,
    options: { readonly cacheKey: string; readonly ttlMs: number; readonly schema: z.ZodType },
  ): Promise<unknown> {
    const cached = this.#cache.get<unknown>(options.cacheKey);
    if (cached !== null) return cached;

    const url = this.#buildUrl(path, query);
    const response = await this.#scheduler.send(() =>
      this.#transport.request({ url, headers: this.#headers }),
    );
    if (response.status === 429) {
      throw new PoolDataError(
        POOL_DATA_ERROR_CODES.RATE_LIMIT_EXHAUSTED,
        `${this.#label}: rate limited (HTTP 429) after retries: ${url}`,
        { source: this.#source, url },
      );
    }
    if (response.status < 200 || response.status >= 300) {
      // The body may be a JSON error document; keep one line, capped so an HTML error page cannot
      // flood the log.
      const detail = response.body.replace(/\s+/g, ' ').slice(0, 200);
      throw new PoolDataError(
        POOL_DATA_ERROR_CODES.SOURCE_UNAVAILABLE,
        `${this.#label}: HTTP ${response.status} for ${url}${detail.length > 0 ? ` — ${detail}` : ''}`,
        { source: this.#source, url },
      );
    }

    let raw: unknown;
    try {
      raw = JSON.parse(response.body) as unknown;
    } catch {
      throw new PoolDataError(
        POOL_DATA_ERROR_CODES.BAD_RESPONSE,
        `${this.#label}: response is not JSON (${url})`,
        { source: this.#source, url },
      );
    }
    const parsed = options.schema.safeParse(raw);
    if (!parsed.success) {
      throw new PoolDataError(
        POOL_DATA_ERROR_CODES.BAD_RESPONSE,
        `${this.#label}: unexpected response shape for ${url}: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`,
        { source: this.#source, url },
      );
    }
    this.#cache.set(options.cacheKey, parsed.data, options.ttlMs);
    return parsed.data;
  }

  #buildUrl(
    path: string,
    query: Readonly<Record<string, string | number | boolean | undefined>>,
  ): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, String(value));
    }
    const suffix = params.size > 0 ? `?${params.toString()}` : '';
    return `${this.#baseUrl}${path}${suffix}`;
  }
}

// ---------------------------------------------------------------------------------------------
// GeckoTerminal source
// ---------------------------------------------------------------------------------------------

export interface GeckoTerminalTtls {
  readonly tokenPoolsMs: number;
  readonly poolDetailMs: number;
  readonly ohlcvMs: number;
}

export const DEFAULT_GECKOTERMINAL_TTLS: GeckoTerminalTtls = {
  tokenPoolsMs: 60_000,
  poolDetailMs: 60_000,
  ohlcvMs: 300_000,
};

export interface TokenPoolsPage {
  readonly pools: readonly GeckoTerminalPool[];
  /** True when GeckoTerminal reported more pages — recorded so a miss is never called "absent". */
  readonly hasMorePages: boolean;
}

export class GeckoTerminalSource {
  readonly #client: JsonHttpClient;
  readonly #network: string;
  readonly #chainId: ChainId;
  readonly #ttls: GeckoTerminalTtls;

  constructor(options: { chainId: ChainId; client: JsonHttpClient; ttls?: GeckoTerminalTtls }) {
    this.#chainId = options.chainId;
    this.#network = requireNetwork(GECKOTERMINAL_NETWORKS, options.chainId, 'geckoterminal');
    this.#client = options.client;
    this.#ttls = options.ttls ?? DEFAULT_GECKOTERMINAL_TTLS;
  }

  get source(): DataSource {
    return this.#client.source;
  }

  get scheduler(): RequestScheduler {
    return this.#client.scheduler;
  }

  /** `GET /networks/{network}/tokens/{address}/pools?sort=h24_volume_usd_desc` (page 1). */
  async listTokenPools(tokenAddress: Address): Promise<TokenPoolsPage> {
    const data = await this.#client.getJson(
      `/networks/${this.#network}/tokens/${tokenAddress}/pools`,
      { page: 1, sort: 'h24_volume_usd_desc' },
      {
        cacheKey: `gt:token-pools:${this.#network}:${tokenAddress}`,
        ttlMs: this.#ttls.tokenPoolsMs,
        schema: gtListSchema,
      },
    );
    const parsed = gtListSchema.parse(data);
    const pools: GeckoTerminalPool[] = [];
    for (const entry of parsed.data) {
      const pool = normalizeGeckoTerminalPool(entry, this.#chainId);
      if (pool !== null) pools.push(pool);
    }
    return { pools, hasMorePages: parsed.links?.next !== undefined };
  }

  /** `GET /networks/{network}/pools/{address}` — carries `pool_fee_percentage`. */
  async getPool(poolAddress: Address): Promise<GeckoTerminalPool> {
    const data = await this.#client.getJson(
      `/networks/${this.#network}/pools/${poolAddress}`,
      {},
      {
        cacheKey: `gt:pool:${this.#network}:${poolAddress}`,
        ttlMs: this.#ttls.poolDetailMs,
        schema: gtPoolDetailSchema,
      },
    );
    const parsed = gtPoolDetailSchema.parse(data);
    const pool = normalizeGeckoTerminalPool(parsed.data, this.#chainId);
    if (pool === null) {
      throw new PoolDataError(
        POOL_DATA_ERROR_CODES.BAD_RESPONSE,
        `geckoterminal: pool ${poolAddress} could not be decoded`,
        { source: this.#client.source },
      );
    }
    return pool;
  }

  /**
   * Fee-tier fallback: `GET /networks/{network}/pools/multi/{addresses}` (cap 30 per call, verified
   * live). Used only when the RPC layer cannot supply `fee()`.
   */
  async getPoolFees(poolAddresses: readonly Address[]): Promise<ReadonlyMap<Address, FeeTier>> {
    const result = new Map<Address, FeeTier>();
    const capped = poolAddresses.slice(0, 30);
    if (capped.length === 0) return result;
    const data = await this.#client.getJson(
      `/networks/${this.#network}/pools/multi/${capped.join(',')}`,
      {},
      {
        cacheKey: `gt:pool-multi:${this.#network}:${capped.join(',')}`,
        ttlMs: this.#ttls.poolDetailMs,
        schema: gtListSchema,
      },
    );
    const parsed = gtListSchema.parse(data);
    for (const entry of parsed.data) {
      const pool = normalizeGeckoTerminalPool(entry, this.#chainId);
      if (pool === null || pool.feePercent === null) continue;
      const tier = feeTierFromPercent(pool.feePercent);
      if (tier !== null) result.set(pool.poolAddress, tier);
    }
    return result;
  }

  /** Daily candles, newest first (the order GeckoTerminal returns). */
  async getDailyCandles(
    poolAddress: Address,
    limit: number,
  ): Promise<readonly GeckoTerminalCandle[]> {
    const data = await this.#client.getJson(
      `/networks/${this.#network}/pools/${poolAddress}/ohlcv/day`,
      { aggregate: 1, limit },
      {
        cacheKey: `gt:ohlcv:${this.#network}:${poolAddress}:${limit}`,
        ttlMs: this.#ttls.ohlcvMs,
        schema: gtOhlcvSchema,
      },
    );
    const parsed = gtOhlcvSchema.parse(data);
    const candles: GeckoTerminalCandle[] = [];
    for (const row of parsed.data.attributes.ohlcv_list) {
      const values = row.slice(0, 6).map((cell) => numberish.parse(cell));
      if (values.length < 6 || values.some((value) => value === null)) continue;
      const [timestamp, open, high, low, close, volume] = values as [
        number,
        number,
        number,
        number,
        number,
        number,
      ];
      candles.push({
        timestampSeconds: timestamp,
        open,
        high,
        low,
        close,
        volumeUsd: volume,
      });
    }
    return candles;
  }
}

export function normalizeGeckoTerminalPool(
  entry: unknown,
  chainId: ChainId,
): GeckoTerminalPool | null {
  const parsed = gtPoolSchema.safeParse(entry);
  if (!parsed.success) return null;
  const { attributes, relationships } = parsed.data;
  if (!isAddress(attributes.address)) return null;
  const dexIdRaw = relationshipId(relationships?.dex);
  return {
    poolAddress: attributes.address.toLowerCase() as Address,
    dex: matchGeckoTerminalDex(chainId, dexIdRaw),
    dexIdRaw,
    baseToken: relationshipAddress(relationships?.base_token),
    quoteToken: relationshipAddress(relationships?.quote_token),
    priceBaseUsd: positiveOrNull(attributes.base_token_price_usd),
    priceQuoteUsd: positiveOrNull(attributes.quote_token_price_usd),
    reserveInUsd: positiveOrNull(attributes.reserve_in_usd),
    volume24hUsd: nonNegativeOrNull(attributes.volume_usd?.h24),
    createdAt: isoOrNull(attributes.pool_created_at),
    feePercent: nonNegativeOrNull(attributes.pool_fee_percentage),
  };
}

/** GeckoTerminal reports the fee as a percent (`0.01`, `0.3`); the tier is `% × 10 000`. */
export function feeTierFromPercent(percent: number): FeeTier | null {
  if (!Number.isFinite(percent) || percent <= 0) return null;
  const tier = Math.round(percent * 10_000);
  return tier > 0 ? tier : null;
}

// ---------------------------------------------------------------------------------------------
// DexPaprika source
// ---------------------------------------------------------------------------------------------

export interface DexPaprikaTtls {
  readonly tokenPoolsMs: number;
}

export const DEFAULT_DEXPAPRIKA_TTLS: DexPaprikaTtls = { tokenPoolsMs: 120_000 };

export class DexPaprikaSource {
  readonly #client: JsonHttpClient;
  readonly #network: string;
  readonly #chainId: ChainId;
  readonly #ttls: DexPaprikaTtls;

  constructor(options: { chainId: ChainId; client: JsonHttpClient; ttls?: DexPaprikaTtls }) {
    this.#chainId = options.chainId;
    this.#network = requireNetwork(DEXPAPRIKA_NETWORKS, options.chainId, 'dexpaprika');
    this.#client = options.client;
    this.#ttls = options.ttls ?? DEFAULT_DEXPAPRIKA_TTLS;
  }

  get source(): DataSource {
    return this.#client.source;
  }

  get scheduler(): RequestScheduler {
    return this.#client.scheduler;
  }

  /**
   * `GET /networks/{network}/pools/search?token_address=…` — the current way to enumerate a token's
   * pools WITH `volume_usd_7d`/`volume_usd_30d`; the older `/tokens/{a}/pools` route answers HTTP
   * 410 (verified live). Pages up to `maxPages`, so a truncated list is visible instead of silent.
   */
  async searchPoolsByToken(
    tokenAddress: Address,
    options: { readonly maxPages: number; readonly pageSize: number },
  ): Promise<{ readonly pools: readonly DexPaprikaPool[]; readonly truncated: boolean }> {
    const pools: DexPaprikaPool[] = [];
    let cursor: string | null = null;
    let pages = 0;
    let truncated = false;
    for (;;) {
      const data = await this.#client.getJson(
        `/networks/${this.#network}/pools/search`,
        {
          token_address: tokenAddress,
          limit: options.pageSize,
          order_by: 'liquidity_usd',
          sort: 'desc',
          ...(cursor === null ? {} : { cursor }),
        },
        {
          cacheKey: `dp:search:${this.#network}:${tokenAddress}:${cursor ?? 'first'}:${options.pageSize}`,
          ttlMs: this.#ttls.tokenPoolsMs,
          schema: dpSearchSchema,
        },
      );
      const parsed = dpSearchSchema.parse(data);
      for (const entry of parsed.results) {
        const pool = normalizeDexPaprikaPool(entry, this.#chainId);
        if (pool !== null) pools.push(pool);
      }
      pages += 1;
      const nextCursor = parsed.next_cursor ?? null;
      if (parsed.has_next_page !== true) break;
      if (pages >= options.maxPages || nextCursor === null) {
        truncated = true;
        break;
      }
      cursor = nextCursor;
    }
    return { pools, truncated };
  }
}

export function normalizeDexPaprikaPool(entry: unknown, chainId: ChainId): DexPaprikaPool | null {
  const parsed = dpPoolSchema.safeParse(entry);
  if (!parsed.success) return null;
  const pool = parsed.data;
  if (!isAddress(pool.id)) return null;
  const dexIdRaw = nonEmptyString(pool.dex_id);
  const factoryId = nonEmptyString(pool.factory_id);
  const tokenAddresses: Address[] = [];
  for (const token of pool.tokens ?? []) {
    if (isAddress(token.id)) tokenAddresses.push(token.id.toLowerCase() as Address);
  }
  return {
    poolAddress: pool.id.toLowerCase() as Address,
    dex: matchDexPaprikaDex(chainId, dexIdRaw, factoryId),
    dexIdRaw,
    factoryId,
    // Verbatim: `null` for V3 pools, and a null is never coerced into a fee tier.
    fee: pool.fee ?? null,
    tokenAddresses,
    liquidityUsd: positiveOrNull(pool.liquidity_usd),
    volume24hUsd: nonNegativeOrNull(pool['24h']?.volume_usd),
    volume7dUsd: nonNegativeOrNull(pool.volume_usd_7d),
    volume30dUsd: nonNegativeOrNull(pool.volume_usd_30d),
    createdAt: isoOrNull(pool.created_at),
    lastPriceUsd: positiveOrNull(pool.last_price_usd),
  };
}

// ---------------------------------------------------------------------------------------------
// OHLCV analytics
// ---------------------------------------------------------------------------------------------

/**
 * Sum of the newest `days` daily candles. GeckoTerminal returns candles newest-first and the newest
 * candle is the *current, incomplete* day, so a 7-day window is the newest 7 rows (verified live:
 * DexPaprika `volume_usd_7d` 2 708 934 vs the GT first-7 sum 2 696 950 — a 0.4% gap).
 */
export function sumCandleVolume(
  candles: readonly GeckoTerminalCandle[],
  days: number,
): number | null {
  if (candles.length < days) return null;
  const newest = [...candles]
    .sort((a, b) => b.timestampSeconds - a.timestampSeconds)
    .slice(0, days);
  return newest.reduce((total, candle) => total + candle.volumeUsd, 0);
}

/**
 * Close-to-close volatility: population standard deviation of daily log returns over the newest
 * `days + 1` closes. `null` when the history is too short.
 */
export function closeToCloseVolatility(
  candles: readonly GeckoTerminalCandle[],
  days: number,
): number | null {
  if (candles.length < days + 1) return null;
  const ordered = [...candles].sort((a, b) => a.timestampSeconds - b.timestampSeconds);
  const closes = ordered.slice(-(days + 1)).map((candle) => candle.close);
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i += 1) {
    const previous = closes[i - 1];
    const current = closes[i];
    if (previous === undefined || current === undefined || previous <= 0 || current <= 0) return null;
    returns.push(Math.log(current / previous));
  }
  if (returns.length === 0) return null;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance);
}

/** `|a − b| / max(|a|, |b|)`; `null` when either side is unknown or both are zero. */
export function relativeDifference(a: number | null, b: number | null): number | null {
  if (a === null || b === null || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return scale === 0 ? null : Math.abs(a - b) / scale;
}

// ---------------------------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------------------------

export interface PoolDataProviderOptions {
  readonly chainId: ChainId;
  /** The whitelist registry: the only source of token decimals and `TokenId` keys (§8). */
  readonly registry: TokenRegistry;
  /** Wired to `src/chain/**` (T4/T5). Absent ⇒ tick/liquidity/fee/impact are `unavailable`. */
  readonly onchain?: PoolStateSource;
  /** §84 reference NAV source (T7). Absent ⇒ `tokenNAVDeviation` is `null` + unavailable. */
  readonly referencePrice?: Pick<ReferencePriceProvider, 'getStockReferencePrice'>;
  readonly transport?: HttpTransport;
  readonly clock?: Clock;
  readonly geckoterminal?: {
    readonly baseUrl?: string;
    readonly apiKey?: string;
    readonly policy?: RateLimitPolicy;
    readonly ttls?: GeckoTerminalTtls;
  };
  readonly dexpaprika?: {
    readonly baseUrl?: string;
    readonly apiKey?: string;
    readonly policy?: RateLimitPolicy;
    readonly ttls?: DexPaprikaTtls;
  };
  /** `/pools/search` pages followed per token before the list is declared truncated. */
  readonly dexpaprikaMaxPages?: number;
  /** Notional levels (USD) quoted for the §16 swap-impact figures. */
  readonly swapImpactNotionalsUsd?: readonly number[];
  /** Daily OHLCV bars requested per pool; 31 covers both the 7d and 30d windows. */
  readonly ohlcvLimit?: number;
}

export const DEFAULT_GECKOTERMINAL_BASE_URL = 'https://api.geckoterminal.com/api/v2';
export const DEFAULT_DEXPAPRIKA_BASE_URL = 'https://api.dexpaprika.com';

interface ComposedPool {
  readonly snapshot: PoolSnapshot;
  readonly diagnostic: PoolDiagnostic;
}

/**
 * Three-layer provider bound to one chain (the whitelist is per-chain, §11).
 *
 * All I/O is injectable (`transport`, `onchain`, `referencePrice`, `clock`), so the whole policy —
 * canonical selection, cross-checking, throttling, backoff — is testable without a network.
 */
export class LayeredPoolDataProvider implements DetailedPoolDataProvider {
  readonly name = 'layered(geckoterminal+dexpaprika+onchain)';
  readonly #chainId: ChainId;
  readonly #registry: TokenRegistry;
  readonly #onchain: PoolStateSource | undefined;
  readonly #referencePrice: Pick<ReferencePriceProvider, 'getStockReferencePrice'> | undefined;
  readonly #clock: Clock;
  readonly #cache: TtlCache;
  readonly #geckoterminal: GeckoTerminalSource;
  readonly #dexpaprika: DexPaprikaSource;
  readonly #dexpaprikaMaxPages: number;
  readonly #notionals: readonly number[];
  readonly #ohlcvLimit: number;
  readonly #singlePoolCache = new Map<PoolId, PoolSnapshot>();

  constructor(options: PoolDataProviderOptions) {
    if (!Number.isInteger(options.chainId) || options.chainId <= 0) {
      throw new PoolDataError(
        POOL_DATA_ERROR_CODES.INVALID_ARGUMENT,
        `PoolDataProvider: bad chainId ${String(options.chainId)}`,
      );
    }
    this.#chainId = options.chainId;
    this.#registry = options.registry;
    this.#onchain = options.onchain;
    this.#referencePrice = options.referencePrice;
    this.#clock = options.clock ?? systemClock;
    this.#cache = new TtlCache(this.#clock);
    const transport = options.transport ?? new FetchHttpTransport();

    const gtApiKey = options.geckoterminal?.apiKey;
    this.#geckoterminal = new GeckoTerminalSource({
      chainId: options.chainId,
      client: new JsonHttpClient({
        label: 'geckoterminal',
        baseUrl: options.geckoterminal?.baseUrl ?? DEFAULT_GECKOTERMINAL_BASE_URL,
        source: DATA_SOURCES.GECKOTERMINAL,
        transport,
        scheduler: new RequestScheduler({
          label: 'geckoterminal',
          policy: options.geckoterminal?.policy ?? DEFAULT_GECKOTERMINAL_RATE_LIMIT,
          clock: this.#clock,
        }),
        cache: this.#cache,
        ...(gtApiKey === undefined ? {} : { apiKey: gtApiKey, apiKeyHeader: 'x-cg-demo-api-key' }),
      }),
      ...(options.geckoterminal?.ttls === undefined ? {} : { ttls: options.geckoterminal.ttls }),
    });

    const dpApiKey = options.dexpaprika?.apiKey;
    this.#dexpaprika = new DexPaprikaSource({
      chainId: options.chainId,
      client: new JsonHttpClient({
        label: 'dexpaprika',
        baseUrl: options.dexpaprika?.baseUrl ?? DEFAULT_DEXPAPRIKA_BASE_URL,
        source: DATA_SOURCES.DEXPAPRIKA,
        transport,
        scheduler: new RequestScheduler({
          label: 'dexpaprika',
          policy: options.dexpaprika?.policy ?? DEFAULT_DEXPAPRIKA_RATE_LIMIT,
          clock: this.#clock,
        }),
        cache: this.#cache,
        ...(dpApiKey === undefined ? {} : { apiKey: dpApiKey, apiKeyHeader: 'authorization' }),
      }),
      ...(options.dexpaprika?.ttls === undefined ? {} : { ttls: options.dexpaprika.ttls }),
    });

    this.#dexpaprikaMaxPages = options.dexpaprikaMaxPages ?? 2;
    this.#notionals = options.swapImpactNotionalsUsd ?? [...SWAP_IMPACT_NOTIONALS_USD];
    this.#ohlcvLimit = options.ohlcvLimit ?? 31;
  }

  get chainId(): ChainId {
    return this.#chainId;
  }

  get onchain(): PoolStateSource | undefined {
    return this.#onchain;
  }

  /** Scheduler counters for observability: requests, throttle waits, retries, 429 timestamps. */
  get stats(): { readonly geckoterminal: SchedulerStats; readonly dexpaprika: SchedulerStats } {
    return {
      geckoterminal: this.#geckoterminal.scheduler.stats,
      dexpaprika: this.#dexpaprika.scheduler.stats,
    };
  }

  async getPools(query: PoolDiscoveryQuery): Promise<readonly PoolSnapshot[]> {
    return (await this.getPoolsDetailed(query)).pools;
  }

  /**
   * Discovery + enrichment with the provenance trail attached.
   *
   * EXISTENCE SEMANTICS: a pool appears here only when the HTTP discovery layer returned it and
   * both its legs resolve to whitelisted addresses. When the *source* failed, the failure lands in
   * `failures` and `complete` goes false — an empty `pools` array must never be read as "no pool
   * exists" unless `complete === true` (and, for a rigorous answer, the caller should also use the
   * on-chain factory probe in `poolScanner.ts`).
   */
  async getPoolsDetailed(query: PoolDiscoveryQuery): Promise<PoolDiscoveryResult> {
    if (query.chainId !== this.#chainId) {
      throw new PoolDataError(
        POOL_DATA_ERROR_CODES.INVALID_ARGUMENT,
        `provider is bound to chain ${this.#chainId}, query asked for ${query.chainId}`,
      );
    }
    const stockTokens = dedupeAddresses(query.tokenAddresses);
    if (stockTokens.length === 0) {
      throw new PoolDataError(
        POOL_DATA_ERROR_CODES.INVALID_ARGUMENT,
        'PoolDiscoveryQuery.tokenAddresses is empty — refusing to scan nothing',
      );
    }
    const stableTokens = new Set(dedupeAddresses(query.stablecoinAddresses));
    const dexes = new Set<DexId>(query.dexes);
    const failures: PoolSourceFailure[] = [];

    // ---- layer 1: GeckoTerminal discovery, one request per stock token.
    const discovered = new Map<Address, { stockToken: Address; gt: GeckoTerminalPool }>();
    let discoverySuccesses = 0;
    for (const stockToken of stockTokens) {
      try {
        const page = await this.#geckoterminal.listTokenPools(stockToken);
        discoverySuccesses += 1;
        if (page.hasMorePages) {
          failures.push({
            source: DATA_SOURCES.GECKOTERMINAL,
            scope: 'discovery',
            subject: stockToken,
            severity: POOL_SOURCE_FAILURE_SEVERITIES.FATAL,
            message: `geckoterminal returned more pages than page 1 for ${stockToken}; a valid pool may be missing, so absence cannot be asserted`,
          });
        }
        for (const gt of page.pools) {
          if (gt.dex === null || !dexes.has(gt.dex)) continue;
          const base = gt.baseToken;
          const quote = gt.quoteToken;
          if (base === null || quote === null) continue;
          const crosses =
            (base === stockToken && stableTokens.has(quote)) ||
            (quote === stockToken && stableTokens.has(base));
          if (!crosses) continue;
          if (!discovered.has(gt.poolAddress)) discovered.set(gt.poolAddress, { stockToken, gt });
        }
      } catch (error) {
        failures.push({
          source: DATA_SOURCES.GECKOTERMINAL,
          scope: 'discovery',
          subject: stockToken,
          severity: POOL_SOURCE_FAILURE_SEVERITIES.FATAL,
          message: `geckoterminal discovery failed for ${stockToken}: ${describeError(error)}`,
        });
      }
    }
    if (discoverySuccesses === 0) {
      throw new PoolDataError(
        POOL_DATA_ERROR_CODES.SOURCE_UNAVAILABLE,
        `geckoterminal discovery failed for every requested token (${stockTokens.length}); a result would be indistinguishable from "no pool exists"`,
        { source: DATA_SOURCES.GECKOTERMINAL },
      );
    }

    const ordered = [...discovered.values()].sort((a, b) =>
      a.gt.poolAddress.localeCompare(b.gt.poolAddress),
    );

    // ---- layer 2: DexPaprika enrichment, one search per stock token (not per pool).
    const dpByToken = await this.#enrichWithDexPaprika(
      new Set(ordered.map((entry) => entry.stockToken)),
      failures,
    );

    // ---- layer 3: on-chain truth, one batch for every candidate pool.
    const poolAddresses = ordered.map((entry) => entry.gt.poolAddress);
    const onchainStates = await this.#readOnchainStates(poolAddresses, failures);
    const reserves = await this.#readOnchainReserves(poolAddresses, failures);

    const pools: PoolSnapshot[] = [];
    const diagnostics: PoolDiagnostic[] = [];
    for (const entry of ordered) {
      const base = entry.gt.baseToken;
      const quote = entry.gt.quoteToken;
      if (base === null || quote === null) continue;
      const stableToken = entry.stockToken === base ? quote : base;
      const dex = entry.gt.dex;
      if (dex === null) continue;
      const dp = dpByToken.get(entry.stockToken)?.get(entry.gt.poolAddress) ?? null;
      const composed = await this.#compose({
        stockToken: entry.stockToken,
        stableToken,
        dex,
        gt: entry.gt,
        dp,
        onchain: onchainStates.get(entry.gt.poolAddress) ?? null,
        reserves: reserves.get(entry.gt.poolAddress) ?? null,
        failures,
      });
      if (composed === null) continue;
      pools.push(composed.snapshot);
      diagnostics.push(composed.diagnostic);
    }

    return {
      pools,
      diagnostics,
      failures,
      complete: !failures.some(
        (failure) => failure.severity === POOL_SOURCE_FAILURE_SEVERITIES.FATAL,
      ),
    };
  }

  // -- frozen single-field getters -----------------------------------------------------------------

  async getTVL(poolId: PoolId): Promise<Sourced<UsdAmount>> {
    return (await this.#loadSinglePool(poolId)).tvlUSD;
  }

  async getVolume24h(poolId: PoolId): Promise<Sourced<UsdAmount>> {
    return (await this.#loadSinglePool(poolId)).volume24h;
  }

  async getVolume7d(poolId: PoolId): Promise<Sourced<UsdAmount>> {
    return (await this.#loadSinglePool(poolId)).volume7d;
  }

  async getFees24h(poolId: PoolId): Promise<Sourced<UsdAmount>> {
    return (await this.#loadSinglePool(poolId)).fees24h;
  }

  async getFees7d(poolId: PoolId): Promise<Sourced<UsdAmount>> {
    return (await this.#loadSinglePool(poolId)).fees7d;
  }

  async #loadSinglePool(poolId: PoolId): Promise<PoolSnapshot> {
    const cached = this.#singlePoolCache.get(poolId);
    if (cached !== undefined) return cached;
    const { chainId, dex, poolAddress } = parsePoolId(poolId);
    if (chainId !== this.#chainId) {
      throw new PoolDataError(
        POOL_DATA_ERROR_CODES.INVALID_ARGUMENT,
        `pool ${poolId} is not on chain ${this.#chainId}`,
      );
    }
    const failures: PoolSourceFailure[] = [];
    let gt: GeckoTerminalPool;
    try {
      gt = await this.#geckoterminal.getPool(poolAddress);
    } catch (error) {
      // These getters cannot degrade: without the detail view there is no TVL/volume at all.
      throw new PoolDataError(
        POOL_DATA_ERROR_CODES.SOURCE_UNAVAILABLE,
        `geckoterminal pool detail unavailable for ${poolId}: ${describeError(error)}`,
        { source: DATA_SOURCES.GECKOTERMINAL },
      );
    }
    const base = gt.baseToken;
    const quote = gt.quoteToken;
    if (base === null || quote === null) {
      throw new PoolDataError(
        POOL_DATA_ERROR_CODES.BAD_RESPONSE,
        `geckoterminal pool ${poolAddress} did not report both legs`,
        { source: DATA_SOURCES.GECKOTERMINAL },
      );
    }
    const stockToken = this.#stockLegOf(base) ?? this.#stockLegOf(quote);
    if (stockToken === null) {
      throw new PoolDataError(
        POOL_DATA_ERROR_CODES.INVALID_ARGUMENT,
        `pool ${poolId} has no whitelisted stock leg (legs ${base}/${quote}) — refusing to value it`,
      );
    }
    const stableToken = stockToken === base ? quote : base;

    const dpByToken = await this.#enrichWithDexPaprika(new Set([stockToken]), failures);
    const dp = dpByToken.get(stockToken)?.get(poolAddress) ?? null;
    const onchainStates = await this.#readOnchainStates([poolAddress], failures);
    const reserves = await this.#readOnchainReserves([poolAddress], failures);

    const composed = await this.#compose({
      stockToken,
      stableToken,
      dex,
      gt,
      dp,
      onchain: onchainStates.get(poolAddress) ?? null,
      reserves: reserves.get(poolAddress) ?? null,
      failures,
    });
    if (composed === null) {
      throw new PoolDataError(
        POOL_DATA_ERROR_CODES.BAD_RESPONSE,
        `pool ${poolId} could not be composed from the available layers`,
      );
    }
    this.#singlePoolCache.set(poolId, composed.snapshot);
    return composed.snapshot;
  }

  // -- layer helpers -------------------------------------------------------------------------------

  async #enrichWithDexPaprika(
    stockTokens: ReadonlySet<Address>,
    failures: PoolSourceFailure[],
  ): Promise<ReadonlyMap<Address, ReadonlyMap<Address, DexPaprikaPool>>> {
    const byToken = new Map<Address, ReadonlyMap<Address, DexPaprikaPool>>();
    for (const stockToken of stockTokens) {
      try {
        const search = await this.#dexpaprika.searchPoolsByToken(stockToken, {
          maxPages: this.#dexpaprikaMaxPages,
          pageSize: 100,
        });
        const byPool = new Map<Address, DexPaprikaPool>();
        for (const pool of search.pools) byPool.set(pool.poolAddress, pool);
        byToken.set(stockToken, byPool);
        if (search.truncated) {
          failures.push({
            source: DATA_SOURCES.DEXPAPRIKA,
            scope: 'enrichment',
            subject: stockToken,
            severity: POOL_SOURCE_FAILURE_SEVERITIES.DEGRADED,
            message: `dexpaprika pool search for ${stockToken} was truncated after ${this.#dexpaprikaMaxPages} page(s); a low-liquidity pool may lack 7d/30d volume`,
          });
        }
      } catch (error) {
        failures.push({
          source: DATA_SOURCES.DEXPAPRIKA,
          scope: 'enrichment',
          subject: stockToken,
          severity: POOL_SOURCE_FAILURE_SEVERITIES.DEGRADED,
          message: `dexpaprika enrichment failed for ${stockToken}: ${describeError(error)}`,
        });
      }
    }
    return byToken;
  }

  async #readOnchainStates(
    poolAddresses: readonly Address[],
    failures: PoolSourceFailure[],
  ): Promise<ReadonlyMap<Address, OnchainPoolState>> {
    const source = this.#onchain;
    if (source === undefined || poolAddresses.length === 0) return new Map();
    try {
      const states = await source.readPoolStates(poolAddresses);
      const map = new Map<Address, OnchainPoolState>();
      for (const state of states) map.set(state.poolAddress.toLowerCase() as Address, state);
      return map;
    } catch (error) {
      failures.push({
        source: DATA_SOURCES.ONCHAIN,
        scope: 'onchain',
        severity: POOL_SOURCE_FAILURE_SEVERITIES.FATAL,
        message: `on-chain pool state read failed for ${poolAddresses.length} pool(s): ${describeError(error)}`,
      });
      return new Map();
    }
  }

  async #readOnchainReserves(
    poolAddresses: readonly Address[],
    failures: PoolSourceFailure[],
  ): Promise<ReadonlyMap<Address, OnchainPoolReserves>> {
    const source = this.#onchain;
    const reader = source?.readPoolReserves;
    if (source === undefined || reader === undefined || poolAddresses.length === 0) return new Map();
    try {
      const reserves = await reader.call(source, poolAddresses);
      const map = new Map<Address, OnchainPoolReserves>();
      for (const entry of reserves) map.set(entry.poolAddress.toLowerCase() as Address, entry);
      return map;
    } catch (error) {
      failures.push({
        source: DATA_SOURCES.ONCHAIN,
        scope: 'onchain',
        severity: POOL_SOURCE_FAILURE_SEVERITIES.DEGRADED,
        message: `on-chain pool reserve read failed: ${describeError(error)}`,
      });
      return new Map();
    }
  }

  #stockLegOf(address: Address): Address | null {
    const token = this.#registry.getTokenByAddress(this.#chainId, address);
    return token !== null && token.isStockToken ? (address.toLowerCase() as Address) : null;
  }

  #decimalsOf(address: Address): number | null {
    const token = this.#registry.getTokenByAddress(this.#chainId, address);
    return token === null ? null : token.decimals;
  }

  // -- composition ---------------------------------------------------------------------------------

  /**
   * Compose one `PoolSnapshot` from the three layers under the canonical-field policy.
   * Returns `null` when a structural precondition is missing (an unwhitelisted leg, decimals we
   * would have to guess, HTTP legs contradicting the chain) — never a half-guessed snapshot.
   */
  async #compose(params: {
    stockToken: Address;
    stableToken: Address;
    dex: DexId;
    gt: GeckoTerminalPool;
    dp: DexPaprikaPool | null;
    onchain: OnchainPoolState | null;
    reserves: OnchainPoolReserves | null;
    failures: PoolSourceFailure[];
  }): Promise<ComposedPool | null> {
    const { stockToken, stableToken, dex, gt, dp, onchain, reserves } = params;
    const asOf = new Date(this.#clock.now()).toISOString();
    const warnings: string[] = [];
    const crossChecks: PoolFieldCrossCheck[] = [];

    const stockDecimals = this.#decimalsOf(stockToken);
    const stableDecimals = this.#decimalsOf(stableToken);
    if (stockDecimals === null || stableDecimals === null) {
      params.failures.push({
        source: DATA_SOURCES.ONCHAIN,
        scope: 'discovery',
        subject: gt.poolAddress,
        severity: POOL_SOURCE_FAILURE_SEVERITIES.DEGRADED,
        message: `pool ${gt.poolAddress} skipped: a leg is not whitelisted (decimals unavailable)`,
      });
      return null;
    }

    // ---- token order: on-chain `token0()/token1()` is canonical; GT only labels legs.
    let token0 = gt.baseToken as Address;
    let token1 = gt.quoteToken as Address;
    let tokenOrderSource: 'onchain' | 'geckoterminal' = 'geckoterminal';
    if (onchain !== null) {
      const legs = new Set([onchain.token0.toLowerCase(), onchain.token1.toLowerCase()]);
      if (!legs.has(stockToken) || !legs.has(stableToken)) {
        params.failures.push({
          source: DATA_SOURCES.ONCHAIN,
          scope: 'discovery',
          subject: gt.poolAddress,
          severity: POOL_SOURCE_FAILURE_SEVERITIES.FATAL,
          message: `pool ${gt.poolAddress}: on-chain legs (${onchain.token0}/${onchain.token1}) disagree with the HTTP legs (${gt.baseToken}/${gt.quoteToken}) — refusing the snapshot`,
        });
        return null;
      }
      token0 = onchain.token0.toLowerCase() as Address;
      token1 = onchain.token1.toLowerCase() as Address;
      tokenOrderSource = 'onchain';
    } else {
      warnings.push(
        'on-chain state unavailable: token0/token1 order, tick, liquidity, fee and swap impact are unverified (src/chain/** not wired)',
      );
    }
    const decimalsFor = (address: Address): number =>
      address === stockToken ? stockDecimals : stableDecimals;

    // ---- feeTier: RPC `fee()` is the truth; GT `pool_fee_percentage` is the fallback.
    const fee = await this.#resolveFeeTier({ gt, onchain, warnings });
    if (dp !== null && dp.fee === null) {
      warnings.push('dexpaprika reported fee=null for this V3 pool (excluded from the feeTier chain)');
    }

    // ---- canonical TVL: GeckoTerminal, cross-checked against DexPaprika and on-chain reserves.
    const dpTvl = dp?.liquidityUsd ?? null;
    let tvlSource: DataSource = DATA_SOURCES.GECKOTERMINAL;
    let tvlValue = gt.reserveInUsd;
    if (tvlValue === null && dpTvl !== null) {
      tvlValue = dpTvl;
      tvlSource = DATA_SOURCES.DEXPAPRIKA;
      warnings.push('tvlUSD fell back to DexPaprika liquidity_usd (GeckoTerminal reported none)');
    }
    let tvlStale = tvlValue === null;
    if (gt.reserveInUsd !== null && dpTvl !== null) {
      const check = this.#crossCheck(
        'tvlUSD',
        tvlSource,
        gt.reserveInUsd,
        DATA_SOURCES.DEXPAPRIKA,
        dpTvl,
        'GT reserve_in_usd vs DP liquidity_usd',
      );
      crossChecks.push(check);
      tvlStale ||= check.severity === 'critical';
    }
    const priceUsdFor = (address: Address): number | null =>
      address === gt.baseToken
        ? gt.priceBaseUsd
        : address === gt.quoteToken
          ? gt.priceQuoteUsd
          : null;
    const reservesUsd =
      reserves === null
        ? null
        : this.#reservesUsd(reserves, token0, token1, priceUsdFor, decimalsFor);
    if (reservesUsd !== null && tvlValue !== null) {
      const check = this.#crossCheck(
        'tvlReservesUsd',
        tvlSource,
        tvlValue,
        DATA_SOURCES.ONCHAIN,
        reservesUsd,
        'TVL vs on-chain reserves × GeckoTerminal unit prices',
      );
      crossChecks.push(check);
      if (check.severity === 'critical') {
        tvlStale = true;
        warnings.push(
          `tvlUSD marked stale: on-chain reserves imply ${reservesUsd.toFixed(2)} USD vs ${tvlValue.toFixed(2)} reported`,
        );
      }
    }

    // ---- canonical 24h volume: GeckoTerminal.
    const dpVol24 = dp?.volume24hUsd ?? null;
    let vol24Source: DataSource = DATA_SOURCES.GECKOTERMINAL;
    let vol24Value = gt.volume24hUsd;
    if (vol24Value === null && dpVol24 !== null) {
      vol24Value = dpVol24;
      vol24Source = DATA_SOURCES.DEXPAPRIKA;
      warnings.push('volume24h fell back to DexPaprika volume_usd_24h (GeckoTerminal reported none)');
    }
    let vol24Stale = vol24Value === null;
    if (gt.volume24hUsd !== null && dpVol24 !== null) {
      const check = this.#crossCheck(
        'volume24h',
        vol24Source,
        gt.volume24hUsd,
        DATA_SOURCES.DEXPAPRIKA,
        dpVol24,
        'GT volume_usd.h24 vs DP volume_usd_24h (≈3% expected, research §4.4)',
      );
      crossChecks.push(check);
      vol24Stale ||= check.severity === 'critical';
    }

    // ---- daily OHLCV: only meaningful when GT's base leg IS the stock leg.
    let candles: readonly GeckoTerminalCandle[] | null = null;
    if (gt.baseToken === stockToken) {
      try {
        candles = await this.#geckoterminal.getDailyCandles(gt.poolAddress, this.#ohlcvLimit);
      } catch (error) {
        warnings.push(`daily OHLCV unavailable: ${describeError(error)}`);
        params.failures.push({
          source: DATA_SOURCES.GECKOTERMINAL,
          scope: 'enrichment',
          subject: gt.poolAddress,
          severity: POOL_SOURCE_FAILURE_SEVERITIES.DEGRADED,
          message: `daily OHLCV failed for ${gt.poolAddress}: ${describeError(error)}`,
        });
      }
    } else {
      warnings.push(
        'daily OHLCV skipped: GeckoTerminal quotes this pool with the stablecoin as base, so the candles are not stock-token prices',
      );
    }

    // ---- canonical 7d volume: DexPaprika (GT has no 7d field), fallback = GT candle sum.
    const gtVolume7d = candles === null ? null : sumCandleVolume(candles, 7);
    const dpVolume7d = dp?.volume7dUsd ?? null;
    let volume7dSource: DataSource = DATA_SOURCES.DEXPAPRIKA;
    let volume7dValue = dpVolume7d;
    if (volume7dValue === null && gtVolume7d !== null) {
      volume7dValue = gtVolume7d;
      volume7dSource = DATA_SOURCES.GECKOTERMINAL;
      warnings.push('volume7d fell back to the GeckoTerminal daily-OHLCV sum over 7 bars');
    }
    let volume7dStale = volume7dValue === null;
    if (dpVolume7d !== null && gtVolume7d !== null) {
      const check = this.#crossCheck(
        'volume7d',
        volume7dSource,
        dpVolume7d,
        DATA_SOURCES.GECKOTERMINAL,
        gtVolume7d,
        'DP volume_usd_7d vs GT daily-OHLCV sum',
      );
      crossChecks.push(check);
      volume7dStale ||= check.severity === 'critical';
    }

    // ---- fees: derived only, and labelled as such (research §4.4).
    const feeRatio = fee.tier === null ? null : fee.tier / FEE_TIER_TO_RATIO;
    const fees24h = deriveFees(vol24Value, feeRatio, vol24Stale, asOf);
    const fees7d = deriveFees(volume7dValue, feeRatio, volume7dStale, asOf);
    if (fees24h.source === DATA_SOURCES.UNAVAILABLE) {
      warnings.push('fees24h unavailable (volume or feeTier missing) — not fabricated');
    }
    if (fees7d.source === DATA_SOURCES.UNAVAILABLE) {
      warnings.push('fees7d unavailable (volume or feeTier missing) — not fabricated');
    }

    // ---- age: GeckoTerminal createdAt, cross-checked against DexPaprika.
    if (gt.createdAt !== null && dp?.createdAt !== null && dp !== null) {
      crossChecks.push(
        this.#crossCheck(
          'createdAt',
          DATA_SOURCES.GECKOTERMINAL,
          Date.parse(gt.createdAt) / 1000,
          DATA_SOURCES.DEXPAPRIKA,
          Date.parse(dp.createdAt) / 1000,
          'GT pool_created_at vs DP created_at (epoch seconds)',
          1,
        ),
      );
    }
    const poolAgeDays = this.#poolAgeDays(gt.createdAt, dp?.createdAt ?? null, warnings);

    // ---- price: GeckoTerminal base-token USD, cross-checked against DP and the on-chain mid.
    const gtPrice = priceUsdFor(stockToken);
    const dpPrice = dp?.lastPriceUsd ?? null;
    let priceSource: DataSource = DATA_SOURCES.GECKOTERMINAL;
    let priceValue = gtPrice;
    if (priceValue === null && dpPrice !== null) {
      priceValue = dpPrice;
      priceSource = DATA_SOURCES.DEXPAPRIKA;
      warnings.push('currentPrice fell back to DexPaprika last_price_usd (GeckoTerminal reported none)');
    }
    let priceStale = priceValue === null;
    if (gtPrice !== null && dpPrice !== null) {
      const check = this.#crossCheck(
        'currentPrice',
        DATA_SOURCES.GECKOTERMINAL,
        gtPrice,
        DATA_SOURCES.DEXPAPRIKA,
        dpPrice,
        'GT base-token price vs DP last_price_usd',
      );
      crossChecks.push(check);
      priceStale ||= check.severity === 'critical';
    }
    const onchainStockPrice =
      onchain === null
        ? null
        : this.#onchainStockPriceUsd({
            onchain,
            token0,
            token1,
            stockToken,
            priceUsdFor,
            decimalsFor,
          });
    if (onchainStockPrice !== null && gtPrice !== null) {
      const check = this.#crossCheck(
        'currentPrice',
        DATA_SOURCES.GECKOTERMINAL,
        gtPrice,
        DATA_SOURCES.ONCHAIN,
        onchainStockPrice,
        'GT base-token price vs on-chain slot0 mid × quote USD price',
      );
      crossChecks.push(check);
      priceStale ||= check.severity === 'critical';
    }

    // ---- §54 deviation against the injected §84 reference provider.
    const reference = await this.#referenceFor(stockToken, params.failures);
    const deviation = this.#navDeviation(priceValue, reference, warnings, asOf);

    // ---- §16 swap impacts, quoted on-chain per notional.
    const impacts = await this.#impacts({
      dex,
      poolAddress: gt.poolAddress,
      stockToken,
      stableToken,
      stockDecimals,
      stableDecimals,
      feeTier: fee.tier,
      midPriceUsd: priceValue,
      asOf,
      warnings,
    });

    const tvl: Sourced<UsdAmount> = tvlValue === null
      ? unavailableUsd(asOf)
      : { value: tvlValue, source: tvlSource, asOf, stale: tvlStale };
    const volume24h: Sourced<UsdAmount> = vol24Value === null
      ? unavailableUsd(asOf)
      : { value: vol24Value, source: vol24Source, asOf, stale: vol24Stale };
    const volume7d: Sourced<UsdAmount> = volume7dValue === null
      ? unavailableUsd(asOf)
      : { value: volume7dValue, source: volume7dSource, asOf, stale: volume7dStale };
    const currentPrice: Sourced<PriceUsd> = priceValue === null
      ? { value: 0, source: DATA_SOURCES.UNAVAILABLE, asOf, stale: true }
      : { value: priceValue, source: priceSource, asOf, stale: priceStale };

    const poolId = poolIdFor(this.#chainId, dex, gt.poolAddress);
    const snapshot: PoolSnapshot = {
      timestamp: asOf,
      chainId: this.#chainId,
      dex,
      poolAddress: gt.poolAddress,
      poolId,
      token0,
      token1,
      token0Id: this.#registry.idFor(this.#chainId, token0),
      token1Id: this.#registry.idFor(this.#chainId, token1),
      feeTier: fee.tier ?? FEE_TIER_UNKNOWN,
      token0Decimals: decimalsFor(token0),
      token1Decimals: decimalsFor(token1),
      tvlUSD: tvl,
      volume24h,
      volume7d,
      fees24h,
      fees7d,
      poolAgeDays,
      ...(gt.createdAt === null ? {} : { createdAt: gt.createdAt }),
      currentPrice,
      sqrtPriceX96: onchain?.sqrtPriceX96 ?? 0n,
      currentTick: onchain?.tick ?? 0,
      activeLiquidity: onchain?.liquidity ?? 0n,
      stockReferencePrice: reference ?? unavailablePrice(asOf),
      tokenNAVDeviation: deviation,
      stockVolatility7d: volatilityOf(candles, 7, asOf),
      stockVolatility30d: volatilityOf(candles, 30, asOf),
      swapImpact1000USD: impacts[0] ?? unavailableRatio(asOf),
      swapImpact3500USD: impacts[1] ?? unavailableRatio(asOf),
      swapImpact5000USD: impacts[2] ?? unavailableRatio(asOf),
      estimatedAPR1d: estimateApr(fees24h, tvl, 1, asOf),
      estimatedAPR7d: estimateApr(fees7d, tvl, 7, asOf),
      estimatedAPR30d: estimateApr(
        deriveFees(dp?.volume30dUsd ?? null, feeRatio, dp?.volume30dUsd === null, asOf),
        tvl,
        30,
        asOf,
      ),
      marketDataSource: combineMarketDataSource(tvl, volume24h),
    };

    return {
      snapshot,
      diagnostic: {
        poolId,
        poolAddress: gt.poolAddress,
        dex,
        discoverySource: DATA_SOURCES.GECKOTERMINAL,
        tokenOrderSource,
        onchainVerified: onchain !== null,
        crossChecks,
        warnings,
      },
    };
  }

  async #resolveFeeTier(params: {
    gt: GeckoTerminalPool;
    onchain: OnchainPoolState | null;
    warnings: string[];
  }): Promise<{ tier: FeeTier | null; source: DataSource }> {
    if (params.onchain !== null) {
      return { tier: params.onchain.feeTier, source: DATA_SOURCES.ONCHAIN };
    }
    const fromDetail = params.gt.feePercent === null ? null : feeTierFromPercent(params.gt.feePercent);
    if (fromDetail !== null) {
      params.warnings.push(
        `feeTier fell back to GeckoTerminal pool_fee_percentage (${params.gt.feePercent}%) — RPC fee() unavailable`,
      );
      return { tier: fromDetail, source: DATA_SOURCES.GECKOTERMINAL };
    }
    try {
      const fees = await this.#geckoterminal.getPoolFees([params.gt.poolAddress]);
      const tier = fees.get(params.gt.poolAddress) ?? null;
      if (tier !== null) {
        params.warnings.push(
          'feeTier fell back to GeckoTerminal /pools/multi pool_fee_percentage — RPC fee() unavailable',
        );
        return { tier, source: DATA_SOURCES.GECKOTERMINAL };
      }
    } catch (error) {
      params.warnings.push(`feeTier fallback failed: ${describeError(error)}`);
    }
    params.warnings.push('feeTier unknown: no RPC and no GeckoTerminal percentage → snapshot carries 0');
    return { tier: null, source: DATA_SOURCES.UNAVAILABLE };
  }

  /** `Σ balanceOf(pool) × unitPrice` — the on-chain cross-check for TVL. */
  #reservesUsd(
    reserves: OnchainPoolReserves,
    token0: Address,
    token1: Address,
    priceUsdFor: (address: Address) => number | null,
    decimalsFor: (address: Address) => number,
  ): number | null {
    const price0 = priceUsdFor(token0);
    const price1 = priceUsdFor(token1);
    if (price0 === null || price1 === null) return null;
    const value0 = toFloat(reserves.token0Raw, decimalsFor(token0)) * price0;
    const value1 = toFloat(reserves.token1Raw, decimalsFor(token1)) * price1;
    const total = value0 + value1;
    return Number.isFinite(total) && total > 0 ? total : null;
  }

  /** Stock price implied by `slot0()`, using the quote leg's USD price to convert. */
  #onchainStockPriceUsd(params: {
    onchain: OnchainPoolState;
    token0: Address;
    token1: Address;
    stockToken: Address;
    priceUsdFor: (address: Address) => number | null;
    decimalsFor: (address: Address) => number;
  }): number | null {
    const sqrt = Number(params.onchain.sqrtPriceX96);
    if (!Number.isFinite(sqrt) || sqrt <= 0) return null;
    const ratio = sqrt / 2 ** 96;
    const rawPrice = ratio * ratio; // token1 per token0, RAW units
    const mid =
      rawPrice * 10 ** (params.decimalsFor(params.token0) - params.decimalsFor(params.token1));
    if (!Number.isFinite(mid) || mid <= 0) return null;
    if (params.token0 === params.stockToken) {
      const quoteUsd = params.priceUsdFor(params.token1);
      return quoteUsd === null ? null : mid * quoteUsd;
    }
    const quoteUsd = params.priceUsdFor(params.token0);
    return quoteUsd === null ? null : quoteUsd / mid;
  }

  async #referenceFor(
    stockToken: Address,
    failures: PoolSourceFailure[],
  ): Promise<Sourced<PriceUsd> | null> {
    const source = this.#referencePrice;
    if (source === undefined) return null;
    try {
      const price = await source.getStockReferencePrice(stockToken);
      if (price.value === null || !(price.value > 0) || price.stale) {
        return { value: 0, source: price.source, asOf: price.asOf, stale: true };
      }
      return { value: price.value, source: price.source, asOf: price.asOf, stale: false };
    } catch (error) {
      failures.push({
        source: DATA_SOURCES.UNAVAILABLE,
        scope: 'reference',
        subject: stockToken,
        severity: POOL_SOURCE_FAILURE_SEVERITIES.DEGRADED,
        message: `reference NAV lookup failed for ${stockToken}: ${describeError(error)}`,
      });
      return null;
    }
  }

  #navDeviation(
    price: number | null,
    reference: Sourced<PriceUsd> | null,
    warnings: string[],
    asOf: IsoTimestamp,
  ): Sourced<Ratio | null> {
    if (price === null || price <= 0) {
      warnings.push('tokenNAVDeviation unavailable: pool price unavailable');
      return { value: null, source: DATA_SOURCES.UNAVAILABLE, asOf, stale: true };
    }
    if (reference === null || reference.stale || reference.value <= 0) {
      warnings.push('tokenNAVDeviation unavailable: no trustworthy reference NAV (§57 → alert only)');
      return { value: null, source: DATA_SOURCES.UNAVAILABLE, asOf, stale: true };
    }
    return {
      value: Math.abs(price / reference.value - 1),
      source: DATA_SOURCES.DERIVED,
      asOf,
      stale: false,
    };
  }

  async #impacts(params: {
    dex: DexId;
    poolAddress: Address;
    stockToken: Address;
    stableToken: Address;
    stockDecimals: number;
    stableDecimals: number;
    feeTier: FeeTier | null;
    midPriceUsd: number | null;
    asOf: IsoTimestamp;
    warnings: string[];
  }): Promise<readonly Sourced<Ratio>[]> {
    const quoter = this.#onchain?.quoteExactInputSingle;
    const onchain = this.#onchain;
    if (quoter === undefined || onchain === undefined) {
      params.warnings.push(
        'swap impact unavailable: no on-chain quote layer wired (src/chain/** — QuoterV2)',
      );
      return [];
    }
    if (params.feeTier === null || params.midPriceUsd === null || params.midPriceUsd <= 0) {
      params.warnings.push('swap impact unavailable: feeTier or pool mid price unknown');
      return [];
    }
    const out: Sourced<Ratio>[] = [];
    for (const notional of this.#notionals) {
      const amountInRaw = toRawAmount(notional, params.stableDecimals);
      if (amountInRaw <= 0n) {
        out.push(unavailableRatio(params.asOf));
        continue;
      }
      try {
        const outRaw = await quoter.call(onchain, {
          dex: params.dex,
          poolAddress: params.poolAddress,
          tokenIn: params.stableToken,
          tokenOut: params.stockToken,
          amountInRaw,
          feeTier: params.feeTier,
        });
        const stockOut = outRaw <= 0n ? 0 : toFloat(outRaw, params.stockDecimals);
        if (!(stockOut > 0)) {
          params.warnings.push(`quote returned no output for a ${notional} USD buy`);
          out.push(unavailableRatio(params.asOf));
          continue;
        }
        const executed = notional / stockOut; // USD per stock token actually paid
        out.push({
          value: Math.abs(executed - params.midPriceUsd) / params.midPriceUsd,
          source: DATA_SOURCES.ONCHAIN,
          asOf: params.asOf,
          stale: false,
        });
      } catch (error) {
        params.warnings.push(`quote for ${notional} USD failed: ${describeError(error)}`);
        out.push(unavailableRatio(params.asOf));
      }
    }
    return out;
  }

  #poolAgeDays(
    gtCreatedAt: IsoTimestamp | null,
    dpCreatedAt: IsoTimestamp | null,
    warnings: string[],
  ): number {
    const createdAt = gtCreatedAt ?? dpCreatedAt;
    if (createdAt === null) {
      warnings.push('poolAgeDays unknown: neither source reported a creation time');
      return Number.NaN;
    }
    const created = Date.parse(createdAt);
    if (!Number.isFinite(created)) {
      warnings.push(`poolAgeDays unknown: unparseable creation time ${createdAt}`);
      return Number.NaN;
    }
    const days = (this.#clock.now() - created) / 86_400_000;
    if (days < 0) {
      warnings.push(`poolAgeDays unknown: creation time ${createdAt} is in the future`);
      return Number.NaN;
    }
    return days;
  }

  #crossCheck(
    field: CrossCheckField,
    canonicalSource: DataSource,
    canonicalValue: number | null,
    crossSource: DataSource,
    crossValue: number | null,
    note: string,
    tolerance = CROSS_CHECK_DIVERGENCE_TOLERANCE,
  ): PoolFieldCrossCheck {
    const relativeDiff = relativeDifference(canonicalValue, crossValue);
    const critical = relativeDiff !== null && relativeDiff > CROSS_CHECK_CRITICAL_TOLERANCE;
    const divergent = relativeDiff !== null && relativeDiff > tolerance;
    return {
      field,
      canonicalSource,
      canonicalValue,
      crossSource,
      crossValue,
      relativeDiff,
      divergent,
      severity: critical ? 'critical' : divergent ? 'warning' : 'info',
      note,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Composition helpers
// ---------------------------------------------------------------------------------------------

/** `volume × feeTier`. `derived` by construction — never presented as measured fee revenue. */
export function deriveFees(
  volume: number | null,
  feeRatio: number | null,
  volumeStale: boolean,
  asOf: IsoTimestamp,
): Sourced<UsdAmount> {
  if (volume === null || feeRatio === null || volumeStale || feeRatio <= 0) {
    return unavailableUsd(asOf);
  }
  return { value: volume * feeRatio, source: DATA_SOURCES.DERIVED, asOf, stale: false };
}

function volatilityOf(
  candles: readonly GeckoTerminalCandle[] | null,
  days: number,
  asOf: IsoTimestamp,
): Sourced<Ratio> {
  if (candles === null) return unavailableRatio(asOf);
  const value = closeToCloseVolatility(candles, days);
  return value === null ? unavailableRatio(asOf) : { value, source: DATA_SOURCES.GECKOTERMINAL, asOf, stale: false };
}

/**
 * Rough derived APR from fee totals, in the shape of §18 (`fees / TVL × 365/window`) but using the
 * *current* TVL instead of the period-average and ignoring range concentration. Therefore it is
 * marked `derived` and must never be reported as a frontend APR (§17). `poolRanker` and the
 * `positionPlanner` own the real calculations.
 */
export function estimateApr(
  fees: Sourced<UsdAmount>,
  tvl: Sourced<UsdAmount>,
  windowDays: number,
  asOf: IsoTimestamp,
): Sourced<Ratio | null> {
  if (
    fees.stale ||
    fees.source === DATA_SOURCES.UNAVAILABLE ||
    tvl.stale ||
    tvl.source === DATA_SOURCES.UNAVAILABLE ||
    tvl.value <= 0
  ) {
    return { value: null, source: DATA_SOURCES.UNAVAILABLE, asOf, stale: true };
  }
  return {
    value: (fees.value / tvl.value) * (365 / windowDays),
    source: DATA_SOURCES.DERIVED,
    asOf,
    stale: false,
  };
}

/**
 * `marketDataSource` summarises the TVL / 24h-volume provenance for the degradation policy.
 * `volume7d` is deliberately excluded: DexPaprika owns it by design (GeckoTerminal has no 7d
 * field), so including it would report every healthy pool as degraded. Per-field provenance lives
 * in each `Sourced.source`.
 */
export function combineMarketDataSource(
  tvl: Sourced<UsdAmount>,
  volume24h: Sourced<UsdAmount>,
): DataSource {
  const rank: Partial<Record<DataSource, number>> = {
    [DATA_SOURCES.GECKOTERMINAL]: 0,
    [DATA_SOURCES.ONCHAIN]: 1,
    [DATA_SOURCES.DEXPAPRIKA]: 2,
    [DATA_SOURCES.DERIVED]: 3,
  };
  return [tvl, volume24h].reduce<DataSource>((current, field) => {
    return (rank[field.source] ?? 4) > (rank[current] ?? 4) ? field.source : current;
  }, DATA_SOURCES.GECKOTERMINAL);
}

export function createPoolDataProvider(options: PoolDataProviderOptions): DetailedPoolDataProvider {
  return new LayeredPoolDataProvider(options);
}

/** `unavailable` USD: consumers MUST fail closed; `0` mirrors the Binance `price <= 0` convention. */
export function unavailableUsd(asOf: IsoTimestamp): Sourced<UsdAmount> {
  return { value: 0, source: DATA_SOURCES.UNAVAILABLE, asOf, stale: true };
}

export function unavailableRatio(asOf: IsoTimestamp): Sourced<Ratio> {
  return { value: 0, source: DATA_SOURCES.UNAVAILABLE, asOf, stale: true };
}

export function unavailablePrice(asOf: IsoTimestamp): Sourced<PriceUsd> {
  return { value: 0, source: DATA_SOURCES.UNAVAILABLE, asOf, stale: true };
}

/** USD notional → RAW amount in `decimals` units. Returns `0n` when it is not representable. */
export function toRawAmount(notionalUsd: number, decimals: number): bigint {
  if (!Number.isFinite(notionalUsd) || notionalUsd <= 0) return 0n;
  const scaled = Math.round(notionalUsd * 10 ** decimals);
  return Number.isFinite(scaled) ? BigInt(scaled) : 0n;
}

export function isAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

export function dedupeAddresses(addresses: readonly Address[]): readonly Address[] {
  const seen = new Set<string>();
  const out: Address[] = [];
  for (const address of addresses) {
    const normalized = address.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized as Address);
  }
  return out;
}

function requireNetwork(
  table: Readonly<Record<ChainId, string>>,
  chainId: ChainId,
  source: string,
): string {
  const network = table[chainId];
  if (network === undefined) {
    throw new PoolDataError(
      POOL_DATA_ERROR_CODES.INVALID_ARGUMENT,
      `${source}: chain ${chainId} has no network slug (only whitelisted chains are supported, §11)`,
    );
  }
  return network;
}

function relationshipId(value: unknown): string | null {
  const parsed = gtRelationship.safeParse(value);
  if (!parsed.success) return null;
  return parsed.data.data?.id ?? null;
}

/** `bsc_0x…` → `0x…`; anything else is rejected rather than coerced. */
function relationshipAddress(value: unknown): Address | null {
  const id = relationshipId(value);
  if (id === null) return null;
  const address = id.includes('_') ? id.slice(id.lastIndexOf('_') + 1) : id;
  return isAddress(address) ? (address.toLowerCase() as Address) : null;
}

function nonEmptyString(value: unknown): string | null {
  const parsed = stringish.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Positive only: `0` means "not reported" for TVL, prices and liquidity (never "free"). */
function positiveOrNull(value: number | null | undefined): number | null {
  return value !== null && value !== undefined && Number.isFinite(value) && value > 0 ? value : null;
}

/** Non-negative: a genuinely zero daily volume is a fact, not a missing value. */
function nonNegativeOrNull(value: number | null | undefined): number | null {
  return value !== null && value !== undefined && Number.isFinite(value) && value >= 0 ? value : null;
}

function isoOrNull(value: string | null | undefined): IsoTimestamp | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
