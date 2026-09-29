import type { TokenAmount } from './token.ts';
import type { SwapPurpose } from './adapters.ts';
import type { BotState } from './state.ts';
import type {
  Address,
  ChainId,
  IsoTimestamp,
  PoolId,
  Ratio,
  Tick,
  TokenId,
  UnixSeconds,
  UsdAmount,
} from './primitives.ts';

/**
 * §5 PortfolioSnapshot — `TotalNAV = Wallet Assets + LP Position Value + Unclaimed Fees + Realized Fees`.
 *
 * Units: every balance is a `TokenAmount` (raw+sui) so bStocks UI conversion cannot be lost;
 * `*Value`/`*Cost` fields are USD doubles for reporting only. `totalNAV` is authoritative for
 * §65/§66 drawdown. `peakNAV` is the running high-water mark used by the drawdown line.
 */
export interface PortfolioSnapshot {
  readonly timestamp: IsoTimestamp;
  readonly chainId: ChainId;
  /** Strategy wallet address (audit). */
  readonly walletAddress: Address;

  readonly walletStablecoinValue: UsdAmount;
  readonly walletStockTokenValue: UsdAmount;
  /** Wallet holdings in raw token form, keyed by token id. */
  readonly walletBalances: readonly TokenAmount[];

  /** LP position legs (UI amounts) for the active position, `0n` when flat. */
  readonly lpToken0Amount: TokenAmount;
  readonly lpToken1Amount: TokenAmount;
  readonly lpPositionValue: UsdAmount;

  readonly unclaimedFeeToken0: TokenAmount;
  readonly unclaimedFeeToken1: TokenAmount;
  readonly unclaimedFeeValue: UsdAmount;

  /** Cumulative realised fees since inception (§64 Profit Vault input). */
  readonly realizedFees: UsdAmount;
  readonly gasCost: UsdAmount;
  readonly swapCost: UsdAmount;
  readonly slippageCost: UsdAmount;

  readonly totalNAV: UsdAmount;
  /** `InitialStrategyCapital`-derived baseline NAV; the §65/§66 risk line is `initialNAV * (1 - maxDrawdown)`. */
  readonly initialNAV: UsdAmount;
  readonly peakNAV: UsdAmount;

  /** §6 buy-and-hold benchmark NAV at the entry ratio (required for IL / FeeILRatio, §7). */
  readonly benchmarkNAV: UsdAmount;

  /** §3 `lpAllocationRatio <= max_lp_ratio` (default 0.70). */
  readonly lpAllocationRatio: Ratio;
  /** §4/§60 `reserveRatio >= reserve_ratio` (default 0.30); `< 0.25` blocks new capital. */
  readonly reserveRatio: Ratio;

  /** Split of free stablecoins for §64 (principal vs realised profit). */
  readonly reservePrincipal: UsdAmount;
  readonly profitVault: UsdAmount;

  /** Gas/native balance, raw wei. */
  readonly nativeBalanceWei: bigint;
}

/** §75 Position record — mirrored 1:1 by the SQLite `positions` table (store task). */
export interface Position {
  readonly id: string;
  readonly chainId: ChainId;
  readonly dex: string;
  readonly poolAddress: Address;
  /** §13 canonical key. */
  readonly poolId: PoolId;
  readonly token0: Address;
  readonly token1: Address;
  readonly token0Id: TokenId;
  readonly token1Id: TokenId;

  readonly openedAt: IsoTimestamp;
  /** NAV at the moment of opening; the §65 risk line is derived from this. */
  readonly initialNAV: UsdAmount;
  readonly entryPrice: UsdAmount;
  readonly lowerPrice: UsdAmount;
  readonly upperPrice: UsdAmount;
  readonly lowerTick: Tick;
  readonly upperTick: Tick;

  readonly initialToken0: TokenAmount;
  readonly initialToken1: TokenAmount;
  /** `L` minted, raw bigint (uint128 on chain). */
  readonly liquidity: bigint;
  /** §44 bot state the position is currently in (`state.ts` imports nothing, so no cycle). */
  readonly status: BotState;

  readonly totalFeesUSD: UsdAmount;
  readonly realizedPnL: UsdAmount;
  readonly unrealizedPnL: UsdAmount;
  readonly benchmarkValue: UsdAmount;
  /** §7 `Accumulated Fees / Impermanent Loss`; `null` until IL is non-zero. */
  readonly feeILRatio: Ratio | null;

  /** §73 minimum holding period gate. */
  readonly minHoldingUntil?: IsoTimestamp;
  /** §32 switch cooldown gate (Phase 5). */
  readonly cooldownUntil?: IsoTimestamp;
  /** Set while the position is inside a §58 emergency window. */
  readonly emergencyReason?: string;
}

/** §76 SwapRecord. `purpose` distinguishes build/exit/switch/fee conversion for reporting. */
export interface SwapRecord {
  readonly txHash: string;
  readonly timestamp: IsoTimestamp;
  readonly chainId: ChainId;
  readonly poolId?: PoolId;
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly tokenInId: TokenId;
  readonly tokenOutId: TokenId;
  /** Raw amounts actually transferred (as reported by the receipt/event). */
  readonly amountIn: TokenAmount;
  readonly amountOut: TokenAmount;
  /** Quote that was signed; compared against `amountOut` for realised slippage. */
  readonly expectedAmountOut: TokenAmount;
  readonly slippage: Ratio;
  readonly priceImpact: Ratio;
  readonly gasCostUSD: UsdAmount;
  readonly purpose: SwapPurpose;
  /** Idempotency key (§97) — unique per intended operation. */
  readonly idempotencyKey: string;
}

/** §77 DecisionLog — must answer "why did the bot switch pool on day X". */
export interface DecisionLog {
  readonly timestamp: IsoTimestamp;
  /** §44 state that produced this decision. */
  readonly state: BotState;
  readonly action: string;
  readonly reason: string;
  readonly currentPool?: PoolId;
  readonly candidatePool?: PoolId;
  readonly currentAPR?: Ratio;
  readonly candidateAPR?: Ratio;
  readonly poolScore?: number;
  readonly tokenDeviation?: Ratio | null;
  readonly totalNAV?: UsdAmount;
  readonly switchingCost?: UsdAmount;
  readonly breakEvenDays?: number;
  /** Machine-readable outcome, e.g. `executed` | `blocked_fail_closed` | `skipped_low_apr`. */
  readonly result: string;
  /** Extra structured context (threshold values, tx hash, approval id). */
  readonly detail?: Readonly<Record<string, unknown>>;
}

/** §65-§67 global drawdown assessment. */
export interface DrawdownState {
  readonly initialNAV: UsdAmount;
  readonly peakNAV: UsdAmount;
  readonly currentNAV: UsdAmount;
  /** `1 - currentNAV / peakNAV`. */
  readonly drawdownFromPeak: Ratio;
  /** `1 - currentNAV / initialNAV`. */
  readonly drawdownFromInitial: Ratio;
  /** NAV at which §66 GLOBAL_RISK_OFF triggers: `initialNAV * (1 - max_drawdown)`. */
  readonly riskOffLineNAV: UsdAmount;
  readonly breached: boolean;
  readonly asOf: IsoTimestamp;
  readonly windowSeconds: UnixSeconds;
}
