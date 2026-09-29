/**
 * §5 Portfolio NAV and §65-§67 drawdown.
 *
 * Pure arithmetic: everything comes in as a value already read from the chain or a price source,
 * so this module is unit-testable and cannot accidentally invent a number.
 *
 * ---------------------------------------------------------------------------------------------
 * NAV DEFINITION — read this before changing the formula.
 *
 * Baseline §5 states `TotalNAV = Wallet Assets + LP Position Value + Unclaimed Fees + Realized Fees`.
 * We deliberately do NOT add `realizedFees` a second time, because §64 settles the meaning of that
 * field: `Reserve Principal + Profit Vault` IS the reserve, and `Profit Vault = realised fees`.
 * The reserve is a wallet balance, so collected fees are already inside `walletStablecoinValue`.
 * Adding them again would inflate NAV by every dollar of fee ever collected, which would push NAV
 * above the §66 risk-off line and silently disable the loss protection — the one failure mode this
 * project treats as unacceptable.
 *
 * `realizedFees` is still computed and reported (it is a §5/§7/§90 requirement and the §64 Profit
 * Vault input); it simply is not a NAV term.
 *
 * Omitting it is also the conservative direction: an understated NAV triggers §66 earlier.
 * Flagged as a spec inconsistency for user confirmation — see docs/known-issues.md KI-15.
 * ---------------------------------------------------------------------------------------------
 */
import type { PortfolioSnapshot, DrawdownState } from '../types/portfolio.ts';
import type { TokenAmount, TokenMeta } from '../types/token.ts';
import type { TokenRegistry } from '../types/registry.ts';
import type {
  Address,
  ChainId,
  IsoTimestamp,
  PriceUsd,
  Ratio,
  TokenId,
  UnixSeconds,
  UsdAmount,
} from '../types/primitives.ts';
import { toFloat } from '../util/decimal.ts';

/** USD price per one whole (UI) token, keyed by token id. Missing ⇒ not valued. */
export type PriceTable = ReadonlyMap<TokenId, PriceUsd>;

/** §6 benchmark: the entry-time legs, held unchanged. */
export interface BenchmarkPosition {
  /** UI amounts held at entry (the LP's token mix at open). */
  readonly token0: TokenAmount;
  readonly token1: TokenAmount;
}

export interface NavInputs {
  readonly chainId: ChainId;
  readonly walletAddress: Address;
  readonly timestamp: IsoTimestamp;

  readonly registry: TokenRegistry;
  readonly prices: PriceTable;

  /** Every wallet holding worth counting; stablecoins and stock tokens are classified by kind. */
  readonly walletBalances: readonly TokenAmount[];
  readonly nativeBalanceWei: bigint;

  readonly lpToken0: TokenAmount;
  readonly lpToken1: TokenAmount;
  /** When the position manager reports a value directly, it wins over the leg-by-leg estimate. */
  readonly lpPositionValueOverride?: UsdAmount | null;

  readonly unclaimedFeeToken0: TokenAmount;
  readonly unclaimedFeeToken1: TokenAmount;

  readonly realizedFees: UsdAmount;
  readonly gasCost: UsdAmount;
  readonly swapCost: UsdAmount;
  readonly slippageCost: UsdAmount;

  /** §68 fixed capital; the §65/§66 risk line is derived from it. */
  readonly initialNAV: UsdAmount;
  /** §4 `reserve_ratio` (0.30) — the §64 principal/profit split point, not a hardcoded constant. */
  readonly reserveRatio: Ratio;
  /** Prior high-water mark; `null` on the first snapshot (then `totalNAV` seeds it). */
  readonly priorPeakNAV: UsdAmount | null;
  readonly benchmark?: BenchmarkPosition | null;
}

/**
 * USD value of a UI amount. Returns `0` for a token we cannot price AND records it, because a
 * silently-zero leg is how a NAV ends up understating a real holding. Callers that need strictness
 * should check `unpricedTokens` on the result.
 */
function valueOf(
  amount: TokenAmount,
  prices: PriceTable,
  unpriced: TokenId[],
): UsdAmount {
  if (amount.ui === 0n) return 0;
  const price = prices.get(amount.tokenId);
  if (price === undefined || !Number.isFinite(price)) {
    unpriced.push(amount.tokenId);
    return 0;
  }
  return toFloat(amount.ui, amount.decimals) * price;
}

function classify(
  registry: TokenRegistry,
  chainId: ChainId,
  tokenId: TokenId,
): TokenMeta | null {
  const address = tokenId.slice(tokenId.indexOf(':') + 1);
  return registry.getTokenByAddress(chainId, address as Address);
}

/** Result carries the snapshot plus the diagnostic the caller needs to decide whether to proceed. */
export interface NavResult {
  readonly snapshot: PortfolioSnapshot;
  /** Token ids that had a non-zero balance but no usable price — NAV is understated by these. */
  readonly unpricedTokens: readonly TokenId[];
}

export function buildPortfolioSnapshot(inputs: NavInputs): NavResult {
  const unpriced: TokenId[] = [];

  let walletStablecoinValue = 0;
  let walletStockTokenValue = 0;
  for (const balance of inputs.walletBalances) {
    const meta = classify(inputs.registry, inputs.chainId, balance.tokenId);
    if (meta === null) {
      // Not whitelisted ⇒ we must not assume a kind. Count it as a stock-token leg? No: refuse to
      // guess. It is reported unpriced so the caller fails closed instead of silently mis-bucketing.
      unpriced.push(balance.tokenId);
      continue;
    }
    const value = valueOf(balance, inputs.prices, unpriced);
    if (meta.kind === 'stablecoin') walletStablecoinValue += value;
    else walletStockTokenValue += value;
  }

  const lpLegs = valueOf(inputs.lpToken0, inputs.prices, unpriced) + valueOf(inputs.lpToken1, inputs.prices, unpriced);
  const lpPositionValue =
    inputs.lpPositionValueOverride === undefined || inputs.lpPositionValueOverride === null
      ? lpLegs
      : inputs.lpPositionValueOverride;

  const unclaimedFeeValue =
    valueOf(inputs.unclaimedFeeToken0, inputs.prices, unpriced) +
    valueOf(inputs.unclaimedFeeToken1, inputs.prices, unpriced);

  // See the header note: realized fees are NOT re-added (they are already in the wallet reserve).
  const totalNAV =
    walletStablecoinValue + walletStockTokenValue + lpPositionValue + unclaimedFeeValue;

  const peakNAV = Math.max(inputs.priorPeakNAV ?? totalNAV, totalNAV);

  const lpAllocationRatio: Ratio = totalNAV > 0 ? lpPositionValue / totalNAV : 0;
  const reserveRatio: Ratio = totalNAV > 0 ? walletStablecoinValue / totalNAV : 0;

  // §64: the first `initialStrategyCapital * reserve_ratio` of free stablecoin is principal;
  // anything above it is realised profit. We cannot tell fee-derived dollars from a deposit, so we
  // take the conservative reading: profit is only what exceeds the configured principal.
  const reservePrincipal = Math.min(walletStablecoinValue, inputs.initialNAV * inputs.reserveRatio);
  const profitVault = Math.max(0, walletStablecoinValue - reservePrincipal);

  const benchmarkNAV =
    inputs.benchmark === undefined || inputs.benchmark === null
      ? totalNAV
      : valueOf(inputs.benchmark.token0, inputs.prices, unpriced) +
        valueOf(inputs.benchmark.token1, inputs.prices, unpriced);

  const snapshot: PortfolioSnapshot = {
    timestamp: inputs.timestamp,
    chainId: inputs.chainId,
    walletAddress: inputs.walletAddress,
    walletStablecoinValue,
    walletStockTokenValue,
    walletBalances: inputs.walletBalances,
    lpToken0Amount: inputs.lpToken0,
    lpToken1Amount: inputs.lpToken1,
    lpPositionValue,
    unclaimedFeeToken0: inputs.unclaimedFeeToken0,
    unclaimedFeeToken1: inputs.unclaimedFeeToken1,
    unclaimedFeeValue,
    realizedFees: inputs.realizedFees,
    gasCost: inputs.gasCost,
    swapCost: inputs.swapCost,
    slippageCost: inputs.slippageCost,
    totalNAV,
    initialNAV: inputs.initialNAV,
    peakNAV,
    benchmarkNAV,
    lpAllocationRatio,
    reserveRatio,
    reservePrincipal,
    profitVault,
    nativeBalanceWei: inputs.nativeBalanceWei,
  };

  return { snapshot, unpricedTokens: unpriced };
}

/**
 * §65-§67 drawdown assessment.
 *
 * `breached` uses `<=` on the risk line: the baseline writes `TotalNAV <= InitialNAV * 0.85`, and a
 * NAV landing exactly on the line must stop the strategy rather than be treated as safe.
 *
 * `windowSeconds` is the observation window this assessment covers (normally the §46 portfolio
 * monitoring interval, or the lookback the caller aggregated over). It is carried so a recorded
 * `DrawdownState` is self-describing: a drawdown measured over 5 minutes and one measured over a
 * week mean different things, and §77 has to be able to tell them apart.
 */
export function buildDrawdownState(
  snapshot: PortfolioSnapshot,
  maxDrawdown: Ratio,
  asOf: IsoTimestamp,
  windowSeconds: UnixSeconds,
): DrawdownState {
  if (!Number.isFinite(maxDrawdown) || maxDrawdown <= 0 || maxDrawdown >= 1) {
    throw new Error(`maxDrawdown out of range: ${String(maxDrawdown)}`);
  }
  if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) {
    throw new Error(`windowSeconds out of range: ${String(windowSeconds)}`);
  }
  const riskOffLineNAV = snapshot.initialNAV * (1 - maxDrawdown);
  return {
    initialNAV: snapshot.initialNAV,
    peakNAV: snapshot.peakNAV,
    currentNAV: snapshot.totalNAV,
    drawdownFromPeak: snapshot.peakNAV > 0 ? 1 - snapshot.totalNAV / snapshot.peakNAV : 0,
    drawdownFromInitial:
      snapshot.initialNAV > 0 ? 1 - snapshot.totalNAV / snapshot.initialNAV : 0,
    riskOffLineNAV,
    breached: snapshot.totalNAV <= riskOffLineNAV,
    asOf,
    windowSeconds,
  };
}

/**
 * §6-§7-§90 benchmark metrics, computed together so the three figures can never disagree about
 * which value was the "actual" one.
 *
 * - `impermanentLossUsd = benchmarkNAV - lpPositionValue`: positive means the LP is behind simply
 *   holding the entry mix, which is exactly the cost the fees must justify.
 * - `feeIlRatio` is `§7 Accumulated Fees / |IL|`. `null` while IL is zero (undefined, not infinite).
 *   The magnitude is used because a favourable divergence would otherwise flip the sign and make a
 *   losing strategy look healthy.
 * - `lpAlpha = totalNAV - benchmarkNAV` (§6), using total NAV so the reserve's opportunity cost is
 *   not hidden.
 */
export interface BenchmarkMetrics {
  readonly benchmarkNAV: UsdAmount;
  readonly impermanentLossUsd: UsdAmount;
  readonly lpAlphaUsd: UsdAmount;
  readonly accumulatedFeesUsd: UsdAmount;
  readonly feeIlRatio: Ratio | null;
  /** §104-§107 health band for the ratio itself. */
  readonly feeIlHealth: 'healthy' | 'acceptable' | 'warning' | 'unknown';
}

export function computeBenchmarkMetrics(params: {
  readonly snapshot: PortfolioSnapshot;
  readonly accumulatedFeesUsd: UsdAmount;
}): BenchmarkMetrics {
  const { snapshot, accumulatedFeesUsd } = params;
  const benchmarkNAV = snapshot.benchmarkNAV;
  const impermanentLossUsd = benchmarkNAV - snapshot.lpPositionValue;
  const div = Math.abs(impermanentLossUsd);
  const feeIlRatio =
    Number.isFinite(accumulatedFeesUsd) && div > 0 ? accumulatedFeesUsd / div : null;

  const feeIlHealth: BenchmarkMetrics['feeIlHealth'] =
    feeIlRatio === null ? 'unknown' : feeIlRatio > 2 ? 'healthy' : feeIlRatio >= 1 ? 'acceptable' : 'warning';

  return {
    benchmarkNAV,
    impermanentLossUsd,
    lpAlphaUsd: snapshot.totalNAV - benchmarkNAV,
    accumulatedFeesUsd,
    feeIlRatio,
    feeIlHealth,
  };
}
