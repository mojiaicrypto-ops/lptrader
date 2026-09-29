/**
 * Primitive aliases shared by every contract in `src/types`.
 *
 * UNITAGREEMENT (must be read before adding any field):
 * - Token amounts are ALWAYS `bigint` in raw on-chain units ("raw bigint"), and the
 *   matching `decimals` metadata must travel with them (TokenAmount) or be resolvable
 *   from `TokenRegistry`. Never store UI-scaled token amounts as `number`.
 *   NOTE: BSC USDC/USDT are 18 decimals, not 6 (research §1).
 * - bStocks are BEP-677 "Scaled UI Amount" tokens: a raw balance/supply does NOT move on
 *   dividends or splits, only `uiMultiplier()` does. Therefore every economic amount
 *   exposed by an adapter is the UI amount (raw * uiMultiplier / 1e18), and the raw value
 *   plus the multiplier used are kept alongside it (`UiAmount`). Never hardcode 1e18.
 * - USD values and ratios are `number` (double) and are ONLY for display, threshold
 *   comparisons, ranking and reporting. They must never be converted back into a token
 *   amount to be signed.
 * - Prices: `PriceUsd` is USD per whole (UI) token. `SqrtPriceX96` / `Tick` are the raw
 *   CLMM representations. Conversions between them live in the adapters, not here.
 */

/** EIP-55 checksummed or lowercased hex address. Registry keys are always lowercased. */
export type Address = `0x${string}`;

/** Uninterpreted hex payload (calldata, ABIs blobs, encoded bytes). */
export type Hex = `0x${string}`;

/** 32-byte transaction/block hash. */
export type Hash = `0x${string}`;

/** EVM chain id. BNB Chain = 56 (baseline §11). */
export type ChainId = number;

/** DEX identifier from `DEX_IDS` — never a free-form string at call sites. */
export type DexId = (typeof DEX_IDS)[keyof typeof DEX_IDS];

/** `${chainId}:${dex}:${poolAddress}` — baseline §13; pool identity is never (token0,token1,fee). */
export type PoolId = string;

/** `${chainId}:${lowercasedTokenAddress}` — baseline §8: address is the identity, symbol is a label. */
export type TokenId = string;

/** Seconds since the Unix epoch (UTC). */
export type UnixSeconds = number;

/** ISO-8601 UTC timestamp, e.g. `2026-09-29T09:46:00.000Z`. */
export type IsoTimestamp = string;

/** Integer ratio in basis points, 0..10_000. */
export type Bps = number;

/** Dimensionless ratio (0..1 unless the field documents otherwise). */
export type Ratio = number;

/** USD value, double precision. Display/threshold use only — never a signed amount. */
export type UsdAmount = number;

/** USD per one whole (UI-scaled) token. */
export type PriceUsd = number;

/** CLMM tick index (can exceed int24 range only when uninitialised; adapters must validate). */
export type Tick = number;

/** CLMM √price encoded as a Q64.96 unsigned integer (viem `bigint`). */
export type SqrtPriceX96 = bigint;

/** Seconds, for TTLs / windows / durations. */
export type DurationSeconds = number;

/** Pool fee in hundredths of a bip (Pancake: 100/500/2500/10000). */
export type FeeTier = number;

/**
 * DEX whitelist ids (baseline §12). A DEX id is only valid for a chain if it appears in
 * `StrategyConfig.whitelist.dexes` with the same `chainId`.
 */
export const DEX_IDS = {
  UNISWAP_V3: 'uniswap-v3',
  PANCAKESWAP_V3: 'pancakeswap-v3',
} as const;

/** §9 token risk tiers. `BLOCKED` tokens must never pass the whitelist. */
export const TOKEN_RISK_TIERS = {
  CORE: 'CORE',
  HIGH_VOL: 'HIGH_VOL',
  BLOCKED: 'BLOCKED',
} as const;
export type TokenRiskTier = (typeof TOKEN_RISK_TIERS)[keyof typeof TOKEN_RISK_TIERS];

/** Economic role of a whitelisted token. */
export const TOKEN_KINDS = {
  /** Binance bStocks share token (BEP-20 + BEP-677 scaled UI amount). */
  BSTOCKS: 'bstocks',
  STABLECOIN: 'stablecoin',
  /** WBNB — required to assert the native leg of a swap (research §4.2). */
  WRAPPED_NATIVE: 'wrapped-native',
  OTHER: 'other',
} as const;
export type TokenKind = (typeof TOKEN_KINDS)[keyof typeof TOKEN_KINDS];
