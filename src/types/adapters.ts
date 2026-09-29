import type { PoolSnapshot, Sourced } from './market.ts';
import type {
  Address,
  ChainId,
  DexId,
  DurationSeconds,
  FeeTier,
  Hash,
  Hex,
  IsoTimestamp,
  PoolId,
  PriceUsd,
  Ratio,
  SqrtPriceX96,
  Tick,
  TokenId,
  UsdAmount,
} from './primitives.ts';

/**
 * §81 ChainAdapter — the only component allowed to talk to an RPC.
 *
 * Unit rules:
 * - `getTokenBalance` / `getNativeBalance` return `bigint` raw wei and the RAW ERC-20 balance
 *   (not UI-scaled). bStocks UI conversion happens in `src/chain/tokenReader.ts`;
 *   this interface deliberately exposes raw so a caller cannot accidentally sign a UI amount.
 * - `estimateGas` / fees are `bigint` wei.
 * - `sendTransaction` is the ONLY write path in the whole system; every call must pass
 *   `TxGuardChecks` (see `src/types/execution.ts`) first (§95).
 */
export interface TokenBalance {
  readonly tokenId: TokenId;
  readonly address: Address;
  readonly decimals: number;
  /** RAW ERC-20 balance (`balanceOf`), NOT UI-scaled. */
  readonly raw: bigint;
}

export interface ChainAdapter {
  readonly chainId: ChainId;
  readonly nativeCurrencyDecimals: number;

  /** §11 chain whitelist check performed at construction; throws when not whitelisted. */
  assertWhitelistedChain(): void;

  getBlockNumber(): Promise<bigint>;
  /** RAW ERC-20 balance (see unit rules above). */
  getTokenBalance(tokenAddress: Address): Promise<bigint>;
  getNativeBalance(address: Address): Promise<bigint>;
  /** Batch read via multicall3 where available (§99 cross-check friendly). */
  getTokenBalances(tokenAddresses: readonly Address[]): Promise<readonly TokenBalance[]>;
  getAllowance(tokenAddress: Address, owner: Address, spender: Address): Promise<bigint>;
  estimateGas(tx: ChainWriteRequest): Promise<bigint>;
  getTransaction(txHash: Hash): Promise<TransactionInfo | null>;
  /** Gas price suggestion for a write; route-aware gas estimation uses this (research §4.2). */
  getGasPrice(): Promise<bigint>;
  /** Unused for read-only RPCs; `null` when no signer is attached (Phase A). */
  getSignerAddress(): Address | null;
  /** §81/§95 — must be gated by TxGuard; executors must never call this directly. */
  sendTransaction(tx: ChainWriteRequest): Promise<Hash>;
}

export interface ChainWriteRequest {
  readonly to: Address;
  readonly data: Hex;
  /** Wei value for the native leg; `0n` for token-only calls. */
  readonly value: bigint;
  readonly gasLimit?: bigint;
  readonly gasPrice?: bigint;
  /** §95 pre-flight checks; adapters must refuse to send when `ok === false`. */
  readonly guard: TxGuardChecks;
}

/** §98 transaction state. `UNKNOWN` must be re-queried on chain, never auto-retried (§96). */
export const TX_STATES = {
  CREATED: 'CREATED',
  SUBMITTED: 'SUBMITTED',
  CONFIRMED: 'CONFIRMED',
  FAILED: 'FAILED',
  REVERTED: 'REVERTED',
  UNKNOWN: 'UNKNOWN',
} as const;
export type TxState = (typeof TX_STATES)[keyof typeof TX_STATES];

export interface TransactionInfo {
  readonly hash: Hash;
  readonly state: TxState;
  /** `null` until mined. */
  readonly blockNumber: bigint | null;
  readonly from: Address;
  readonly to: Address | null;
  readonly value: bigint;
  readonly gasUsed?: bigint;
  readonly effectiveGasPriceWei?: bigint;
  /** `UNKNOWN` must carry a reason so the operator can see why no retry happened. */
  readonly unknownReason?: string;
}

/** §95 per-transaction pre-flight verification. Any `false` ⇒ do not send (fail closed). */
export interface TxGuardChecks {
  readonly chainIdOk: boolean;
  readonly toWhitelisted: boolean;
  readonly tokenInWhitelisted: boolean;
  readonly tokenOutWhitelisted: boolean;
  readonly functionSelectorOk: boolean;
  readonly amountWithinLimit: boolean;
  readonly slippageWithinLimit: boolean;
  readonly deadlineOk: boolean;
  readonly gasLimitSet: boolean;
  /** Allowance is exact/limited — never unlimited (§93). */
  readonly allowanceNotUnlimited: boolean;
  readonly ok: boolean;
  readonly failures: readonly string[];
}

/**
 * §82 DexAdapter — quotes and LP actions for one DEX family.
 *
 * UNIFYING RULE (research §5): one DEX never shares SDK objects with another. Uniswap V3 is a
 * minimal viem-based reimplementation; PancakeSwap V3 uses the official SDK. Everything that
 * crosses this interface is plain data (`bigint`, `Address`, `Hex`) so the two can never
 * silently intermix (cross-package `FeeAmount` selection picks the wrong pool).
 */
export interface DexAdapter {
  readonly dex: DexId;
  readonly chainId: ChainId;
  /**
   * §42 capability of the DEPLOYED contracts — a static property, not a runtime query, so it is a
   * field rather than a method (a method would only add a way to get it wrong).
   *
   * `true`  — this venue can swap and mint in a single transaction (PancakeSwap SmartRouter
   *           `swapAndAddCallParameters`); the adapter MUST honour `swapForDeficit`.
   * `false` — a build must be swap-then-add across two transactions (plain Uniswap V3: its
   *           `multicall` is a self-delegatecall and cannot swap — research §4.2); the adapter
   *           MUST throw if `swapForDeficit` is passed rather than silently splitting the build.
   *
   * The executor reads this to choose the build shape and must never branch on `dex` directly.
   */
  readonly supportsAtomicBuild: boolean;
  /** §12 whitelist check; throws when the DEX is not whitelisted for this chain. */
  assertWhitelisted(): void;

  getPool(token0: Address, token1: Address, feeTier: FeeTier): Promise<PoolRefView | null>;
  getPoolPrice(poolAddress: Address): Promise<PoolPriceView>;
  getLiquidity(poolAddress: Address): Promise<bigint>;
  getTick(poolAddress: Address): Promise<Tick>;

  /** §39/§40 quote with an explicit sender so allowance/permit paths are realistic. */
  quoteSwap(request: SwapQuoteRequest): Promise<SwapQuote>;
  executeSwap(request: SwapExecutionRequest): Promise<SwapExecutionResult>;
  addLiquidity(request: AddLiquidityRequest): Promise<LiquidityExecutionResult>;
  removeLiquidity(request: RemoveLiquidityRequest): Promise<LiquidityExecutionResult>;
  collectFees(request: CollectFeesRequest): Promise<LiquidityExecutionResult>;
  getPosition(tokenId: bigint): Promise<LpPositionView | null>;
}

export interface PoolRefView {
  readonly chainId: ChainId;
  readonly dex: DexId;
  readonly poolAddress: Address;
  readonly poolId: PoolId;
  readonly token0: Address;
  readonly token1: Address;
  readonly feeTier: FeeTier;
  readonly tickSpacing: number;
}

/**
 * Raw CLMM pool state. `sqrtPriceX96`/`liquidity` are the on-chain integers; `priceToken1PerToken0`
 * is the human price derived from them (raw price, i.e. in whole-token terms after decimals)
 * and `priceUsd` is only populated when a reference price for one leg is known.
 */
export interface PoolPriceView {
  readonly poolId: PoolId;
  readonly sqrtPriceX96: SqrtPriceX96;
  readonly tick: Tick;
  readonly liquidity: bigint;
  readonly feeTier: FeeTier;
  readonly tickSpacing: number;
  /** `token1` per 1 `token0`, adjusted for decimals. */
  readonly priceToken1PerToken0: number;
  readonly priceUsd?: PriceUsd;
  /** Source of the price (`onchain` unless a reference price was folded in). */
  readonly asOf: IsoTimestamp;
}

/** §39-§41 swap quote. `amountIn`/`amountOut` are RAW token units. */
export interface SwapQuoteRequest {
  readonly poolId: PoolId;
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  /** RAW amount to sell. Never a UI amount. */
  readonly amountIn: bigint;
  /** §41 quote freshness. */
  readonly ttlSeconds: DurationSeconds;
}

export interface SwapQuote {
  readonly poolId: PoolId;
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly amountInRaw: bigint;
  readonly amountOutRaw: bigint;
  /** Notional of the trade at the quoted price (USD, display/threshold only). */
  readonly amountInUsd: UsdAmount;
  /** §40 `abs(quoteMidPrice - poolMidPrice)/poolMidPrice`, self-computed — the SDK does not
   *  enforce it (research §4.2). Must be compared against `max_price_impact` BEFORE encoding. */
  readonly priceImpact: Ratio;
  readonly slippageTolerance: Ratio;
  /** §41 `amountOut * (1 - slippage)`. */
  readonly amountOutMinimumRaw: bigint;
  readonly quotedAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  /** Route description for audit, e.g. `["QQQB/USDC 0.3%"]`. */
  readonly route: readonly string[];
  readonly gasEstimateWei?: bigint;
}

/** §39-§43 execution inputs. Executors own the guard + approval gate; adapters only encode/send. */
export interface SwapExecutionRequest {
  readonly quote: SwapQuote;
  readonly deadline: DeadlineSpec;
  readonly purpose: SwapPurpose;
  readonly idempotencyKey: string;
  readonly guard: TxGuardChecks;
}

/**
 * §42 atomic build request: swap the deficit and mint the position in ONE transaction.
 *
 * `atomic` is the literal `true` on purpose. An adapter MUST NOT downgrade this to a swap followed
 * by an add-liquidity: splitting silently loses the all-or-nothing guarantee §42 exists for, and a
 * `boolean` would let a caller encode a contradictory "maybe atomic" intent. A venue that cannot
 * combine (plain Uniswap V3 SwapRouter / NonfungiblePositionManager cannot — research §4.2) MUST
 * throw instead of sending anything.
 */
export interface AtomicSwapForDeficit {
  /** The deficit swap. Its `amountInRaw` is the swap leg of the combined call. */
  readonly quote: SwapQuote;
  readonly atomic: true;
}

/**
 * §42 deadline. The `previousBlockhash` variant is preferred for unattended runs: it is immune
 * to clock drift, whereas a timestamp deadline can revert when the local clock is off.
 */
export type DeadlineSpec =
  | { readonly kind: 'timestamp'; readonly unixSeconds: number }
  | { readonly kind: 'previous-blockhash'; readonly blockhash: Hash };

/** §93 approval semantics. `exact` is required by default; `zero-then-max` for BSC USDT. */
export const APPROVAL_TYPES = {
  EXACT: 'exact',
  ZERO_THEN_MAX: 'zero-then-max',
} as const;
export type ApprovalType = (typeof APPROVAL_TYPES)[keyof typeof APPROVAL_TYPES];

export interface SwapExecutionResult {
  readonly txHash: Hash;
  readonly state: TxState;
  readonly amountInRaw: bigint;
  readonly amountOutRaw: bigint;
  readonly approvalType?: ApprovalType;
  /** Set when only part of the intent executed (e.g. swap ok, addLiquidity failed) §43. */
  readonly partial?: PartialExecutionInfo;
}

export interface PartialExecutionInfo {
  readonly completedSteps: readonly string[];
  readonly failedStep: string;
  readonly reason: string;
  /** §43: a partial fill parks the bot in `PARTIAL_POSITION`; it must not auto-retry. */
  readonly requiresManualReview: boolean;
}

/**
 * §33-§38 add liquidity. Amounts are RAW; the adapter converts to the SDK's expectations.
 *
 * `swapForDeficit` is what makes the §42 atomic build expressible: the combined calldata needs the
 * trade AND the position in one call, and the adapter that builds that calldata is the only place
 * that can decide how. Without it, `DexAdapter` could only offer swap-then-add as two transactions.
 */
export interface AddLiquidityRequest {
  readonly poolId: PoolId;
  readonly tickRange: TickRangeRef;
  /** RAW desired amounts; the adapter mints `L = min(L0, L1)` and refunds the remainder. */
  readonly amount0DesiredRaw: bigint;
  readonly amount1DesiredRaw: bigint;
  /** §40 slippage-derived minimums (RAW). */
  readonly amount0MinRaw: bigint;
  readonly amount1MinRaw: bigint;
  readonly recipient: Address;
  readonly deadline: DeadlineSpec;
  readonly idempotencyKey: string;
  readonly guard: TxGuardChecks;
  /**
   * When present, the adapter MUST swap `quote.amountInRaw` and mint the position in a single
   * transaction on venues that support it (PancakeSwap SmartRouter `swapAndAddCallParameters`), and
   * MUST throw — never silently split into swap + addLiquidity — when the venue cannot.
   *
   * The executor sets this on the atomic path only. On the plain path it calls `executeSwap` first
   * and then `addLiquidity` without this field, accepting two transactions plus the §43 partial
   * state that follows from them.
   */
  readonly swapForDeficit?: AtomicSwapForDeficit;
}

export interface TickRangeRef {
  readonly lowerTick: Tick;
  readonly upperTick: Tick;
  readonly tickSpacing: number;
}

export interface LiquidityExecutionResult {
  readonly txHash: Hash;
  readonly state: TxState;
  /** NFT tokenId for mint/increase/collect on position-manager-based DEXes. */
  readonly positionTokenId?: bigint;
  readonly liquidity?: bigint;
  readonly amount0Raw?: bigint;
  readonly amount1Raw?: bigint;
  readonly partial?: PartialExecutionInfo;
}

export interface RemoveLiquidityRequest {
  readonly poolId: PoolId;
  readonly positionTokenId: bigint;
  /** RAW `L` to burn; `null` = burn everything (full exit). */
  readonly liquidityRaw: bigint | null;
  readonly amount0MinRaw: bigint;
  readonly amount1MinRaw: bigint;
  readonly recipient: Address;
  readonly deadline: DeadlineSpec;
  readonly idempotencyKey: string;
  readonly guard: TxGuardChecks;
}

export interface CollectFeesRequest {
  readonly poolId: PoolId;
  readonly positionTokenId: bigint;
  readonly recipient: Address;
  readonly idempotencyKey: string;
  readonly guard: TxGuardChecks;
}

/** On-chain LP position as read from the position manager. */
export interface LpPositionView {
  readonly poolId: PoolId;
  readonly positionTokenId: bigint;
  readonly owner: Address;
  readonly token0: Address;
  readonly token1: Address;
  readonly feeTier: FeeTier;
  readonly tickLower: Tick;
  readonly tickUpper: Tick;
  readonly liquidity: bigint;
  /** RAW fee growth inside/outside, needed to project unclaimed fees off-chain. */
  readonly feeGrowthInside0LastX128: bigint;
  readonly feeGrowthInside1LastX128: bigint;
  readonly tokensOwed0Raw: bigint;
  readonly tokensOwed1Raw: bigint;
}

/** §76 swap purposes. */
export const SWAP_PURPOSES = {
  BUILD_POSITION: 'BUILD_POSITION',
  EXIT_POSITION: 'EXIT_POSITION',
  SWITCH_POOL: 'SWITCH_POOL',
  FEE_CONVERSION: 'FEE_CONVERSION',
} as const;
export type SwapPurpose = (typeof SWAP_PURPOSES)[keyof typeof SWAP_PURPOSES];

/**
 * §83 PoolDataProvider — market-data discovery layer (GeckoTerminal / DexPaprika / RPC).
 * Returns raw USD doubles; the consumer (PoolScanner) is responsible for degradation policy.
 * `token0`/`token1` are addresses so discovery can never rely on symbols.
 */
export interface PoolDataProvider {
  readonly name: string;
  /** Discover candidate pools for an address pair across whitelisted DEXes (§14). */
  getPools(query: PoolDiscoveryQuery): Promise<readonly PoolSnapshot[]>;
  getTVL(poolId: PoolId): Promise<Sourced<UsdAmount>>;
  getVolume24h(poolId: PoolId): Promise<Sourced<UsdAmount>>;
  getVolume7d(poolId: PoolId): Promise<Sourced<UsdAmount>>;
  /** May be `derived` (`volume * feeTier`) when the source does not report fees honestly. */
  getFees24h(poolId: PoolId): Promise<Sourced<UsdAmount>>;
  getFees7d(poolId: PoolId): Promise<Sourced<UsdAmount>>;
}

export interface PoolDiscoveryQuery {
  readonly chainId: ChainId;
  readonly tokenAddresses: readonly Address[];
  readonly stablecoinAddresses: readonly Address[];
  readonly dexes: readonly DexId[];
}

/**
 * §84 ReferencePriceProvider. Where the reference price comes from determines whether a depeg
 * verdict may trigger a hard exit: on closed markets V1 only alerts (§57), so `marketStatus`
 * and `usableForHardExit` travel with every price.
 */
export interface ReferencePriceProvider {
  /** Reference NAV for the stock leg; `null` when no trustworthy source is available. */
  getStockReferencePrice(tokenAddress: Address): Promise<Sourced<PriceUsd | null>>;
  getMarketStatus(): Promise<MarketStatus>;
  getLatestClose(tokenAddress: Address): Promise<Sourced<PriceUsd | null>>;
  getIndicativePrice(tokenAddress: Address): Promise<Sourced<PriceUsd | null>>;
}

export const MARKET_STATUSES = {
  OPEN: 'open',
  CLOSED: 'closed',
  WEEKEND: 'weekend',
  HOLIDAY: 'holiday',
  UNKNOWN: 'unknown',
} as const;
export type MarketStatus = (typeof MARKET_STATUSES)[keyof typeof MARKET_STATUSES];

/** §55 depeg severity ladder, derived from `tokenNAVDeviation` + market status. */
export const PEG_LEVELS = {
  NORMAL: 'NORMAL',
  WARNING: 'WARNING',
  STOP_NEW_CAPITAL: 'STOP_NEW_CAPITAL',
  EXIT_REVIEW: 'EXIT_REVIEW',
  EMERGENCY_EXIT: 'EMERGENCY_EXIT',
} as const;
export type PegLevel = (typeof PEG_LEVELS)[keyof typeof PEG_LEVELS];

export interface PegAssessment {
  readonly tokenId: TokenId;
  readonly deviation: Ratio | null;
  readonly marketStatus: MarketStatus;
  readonly level: PegLevel;
  /** §57: false during closed markets unless a reliable alternative reference exists. */
  readonly hardExitAllowed: boolean;
  readonly reason: string;
  readonly asOf: IsoTimestamp;
}
