import type {
  Address,
  ChainId,
  DexId,
  FeeTier,
  IsoTimestamp,
  PoolId,
  PriceUsd,
  Ratio,
  SqrtPriceX96,
  Tick,
  TokenId,
  UsdAmount,
} from './primitives.ts';

/** §13 pool identity: `chainId + dex + poolAddress`. Never token pair + fee tier. */
export interface PoolRef {
  readonly chainId: ChainId;
  readonly dex: DexId;
  /** Canonical (lowercased) pool address. */
  readonly poolAddress: Address;
}

/**
 * Pool identity as a stable string key (§13). Used as the primary key for `PoolSnapshot`,
 * `Position` and state-store rows.
 */
export type PoolKey = PoolId;

/**
 * Where a number came from. Every externally-sourced figure carries its provenance so the
 * risk layer can refuse to act on a degraded source (baseline §57, §96, §100).
 *
 * `onchain`    — RPC `eth_call` / multicall (authoritative for tick, liquidity, fee, balances).
 * `geckoterminal` / `dexpaprika` / `defillama` — HTTP market data.
 * `binance-index` — Binance bStocks index price (official reference, freezes after close).
 * `binance-spot` — Binance spot ticker.
 * `oracle` — on-chain push oracle (APRO / Atlas / Chainlink reference equity feed).
 * `derived` — computed locally from other fields (volume * feeTier, etc).
 * `unavailable` — the source could not be read; consumers MUST fail closed.
 */
export const DATA_SOURCES = {
  ONCHAIN: 'onchain',
  GECKOTERMINAL: 'geckoterminal',
  DEXPAPRIKA: 'dexpaprika',
  DEFILLAMA: 'defillama',
  BINANCE_INDEX: 'binance-index',
  BINANCE_SPOT: 'binance-spot',
  ORACLE: 'oracle',
  DERIVED: 'derived',
  UNAVAILABLE: 'unavailable',
} as const;
export type DataSource = (typeof DATA_SOURCES)[keyof typeof DATA_SOURCES];

/** A value plus the context needed to judge whether it may be used. */
export interface Sourced<T> {
  readonly value: T;
  readonly source: DataSource;
  readonly asOf: IsoTimestamp;
  /** True when the source could not be read or returned a placeholder (e.g. Binance `price <= 0`). */
  readonly stale: boolean;
}

/** §34: a range whose bounds are guaranteed tick-aligned with the pool's tick spacing. */
export interface TickRange {
  readonly lowerTick: Tick;
  readonly upperTick: Tick;
  readonly tickSpacing: number;
  /** Pool state the range was derived from, for audit. */
  readonly referenceTick: Tick;
}

/** §33: a price range in USD per stock token, before tick alignment. */
export interface PriceRange {
  readonly lowerPrice: PriceUsd;
  readonly upperPrice: PriceUsd;
}

/**
 * §15 PoolSnapshot. All USD/ratio fields are doubles for filtering/ranking; the on-chain
 * fields (`currentTick`, `activeLiquidity`, `sqrtPriceX96`) are raw.
 */
export interface PoolSnapshot {
  readonly timestamp: IsoTimestamp;
  readonly chainId: ChainId;
  readonly dex: DexId;
  readonly poolAddress: Address;
  /** Canonical pool key (chainId:dex:poolAddress). */
  readonly poolId: PoolKey;
  /** Token addresses, canonical order as reported by the pool (`token0()`/`token1()`). */
  readonly token0: Address;
  readonly token1: Address;
  /** Convenience lookups into the registry (address is the identity). */
  readonly token0Id: TokenId;
  readonly token1Id: TokenId;
  readonly feeTier: FeeTier;
  /** Raw `bigint` in raw token units, UI-converted for bStocks. */
  readonly token0Decimals: number;
  readonly token1Decimals: number;

  readonly tvlUSD: Sourced<UsdAmount>;
  readonly volume24h: Sourced<UsdAmount>;
  readonly volume7d: Sourced<UsdAmount>;
  /** Fees 24h/7d: `derived` when computed as volume * feeTier (research §4.4). */
  readonly fees24h: Sourced<UsdAmount>;
  readonly fees7d: Sourced<UsdAmount>;

  /** Age in days since pool creation. */
  readonly poolAgeDays: number;
  readonly createdAt?: IsoTimestamp;
  readonly currentPrice: Sourced<PriceUsd>;
  /** Raw slot0 fields. */
  readonly sqrtPriceX96: SqrtPriceX96;
  readonly currentTick: Tick;
  /** `liquidity()` — the in-range active liquidity, raw bigint. */
  readonly activeLiquidity: bigint;

  /** Reference NAV for the stock leg (§54–§57). */
  readonly stockReferencePrice: Sourced<PriceUsd>;
  /**
   * §54 `abs(onchainTokenPrice / referenceNAV - 1)`. `null` when no trustworthy reference
   * exists (closed market without a usable source) — consumers must then degrade per §57.
   */
  readonly tokenNAVDeviation: Sourced<Ratio | null>;
  readonly stockVolatility7d: Sourced<Ratio>;
  readonly stockVolatility30d: Sourced<Ratio>;

  /** §16 hard filter inputs: price impact of a hypothetical swap, by notional. */
  readonly swapImpact1000USD: Sourced<Ratio>;
  readonly swapImpact3500USD: Sourced<Ratio>;
  readonly swapImpact5000USD: Sourced<Ratio>;

  /** §18-§19: locally computed, never a frontend APR. `null` when not computable. */
  readonly estimatedAPR1d: Sourced<Ratio | null>;
  readonly estimatedAPR7d: Sourced<Ratio | null>;
  readonly estimatedAPR30d: Sourced<Ratio | null>;

  /** Which source produced TvL/volume figures — used for degradation policy. */
  readonly marketDataSource: DataSource;
}

/** §16 hard filters, resolved from config. Any miss disqualifies the pool. */
export interface PoolFilterThresholds {
  readonly minTvlUsd: UsdAmount;
  readonly minAvgDailyVolume7dUsd: UsdAmount;
  readonly minPoolAgeDays: number;
  readonly maxNavDeviation: Ratio;
  readonly maxSwapPriceImpact: Ratio;
}

/** One hard-filter evaluation result; `reasons` is empty iff `passed`. */
export interface PoolFilterResult {
  readonly poolId: PoolKey;
  readonly passed: boolean;
  readonly reasons: readonly string[];
  readonly evaluatedAt: IsoTimestamp;
}
