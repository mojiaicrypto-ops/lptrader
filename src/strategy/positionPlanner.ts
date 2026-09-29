import { Price, Token } from '@pancakeswap/sdk';
import {
  SqrtPriceMath,
  TickMath,
  nearestUsableTick,
  priceToClosestTick,
} from '@pancakeswap/v3-sdk';
import type { PoolPriceView } from '../types/adapters.ts';
import { DEX_IDS, TOKEN_KINDS, type Address, type PriceUsd, type Tick, type UsdAmount } from '../types/primitives.ts';
import type { TokenMeta } from '../types/token.ts';

/**
 * §33-§38 position planning: price range, tick alignment, and the **optimal** token0/token1 split.
 *
 * ## Why this module exists (baseline §35)
 * The naive build is `capital/2 → token0, capital/2 → token1`. That is only correct when the
 * current price happens to sit at the geometric centre of the range. This module instead solves,
 * in one step, for the liquidity `L` implied by `(P, Pa, Pb, total USD capital)` and only then
 * derives how much of which token must be swapped (§36-§38).
 *
 * ## Conventions (UNITAGREEMENT, `src/types/primitives.ts`)
 * - `amount0`/`amount1`/`liquidity` are **raw bigint**; `decimals` come from the `TokenMeta` legs.
 * - `lowerPrice`/`upperPrice`/`priceToken1PerToken0` are **token1 per token0** (the pool's own
 *   orientation, i.e. `PoolPriceView.priceToken1PerToken0`) — *not* USD. `valueToken*Usd`,
 *   `rangeProgress` and `capitalUsd` are doubles.
 * - bStocks are BEP-677 scaled. The caller must pass a pool view whose `priceToken1PerToken0`
 *   and `sqrtPriceX96` are expressed consistently with the decimals in `TokenMeta`; no
 *   `uiMultiplier` is assumed or hardcoded here (the adapter layer owns UI/raw conversion).
 *
 * ## Which SDK helpers are used, and which are deliberately not
 * The CL math is orientation- and chain-agnostic, so `TickMath` / `SqrtPriceMath` /
 * `nearestUsableTick` / `priceToClosestTick` are used for both whitelisted DEXes. What is **not**
 * chain-agnostic is the fee→tickSpacing map (Pancake 100/500/2500/10000 → 1/10/50/200;
 * Uniswap additionally has 3000 → 60), so it is looked up per DEX from `poolId` and every pool
 * read must agree with it (research §5: mixing the two maps silently selects the wrong pool).
 * `Pool`/`Position` from `@pancakeswap/v3-sdk` are therefore **never** constructed here: their
 * `tickSpacing` getter is bound to Pancake's map and would mangle a Uniswap fee tier.
 */

/** Fixed-point scale (1e-12 USD resolution) used to lift USD doubles into exact integer arithmetic. */
const USD_SCALE = 10n ** 12n;

const Q192 = 1n << 192n;

/** Pancake fee → tickSpacing (research §5 / `TICK_SPACINGS` of `@pancakeswap/v3-sdk`). */
const PANCAKE_FEE_TO_TICK_SPACING: Readonly<Record<number, number>> = {
  100: 1,
  500: 10,
  2500: 50,
  10000: 200,
};

/**
 * Uniswap V3 fee → tickSpacing. Identical to Pancake's for the shared tiers, plus the tier Pancake
 * does not deploy (3000 → 60). Kept as a separate table on purpose: the two DEXes must never share
 * one lookup, or a cross-DEX fee would silently match (research §5).
 */
const UNISWAP_FEE_TO_TICK_SPACING: Readonly<Record<number, number>> = {
  100: 1,
  500: 10,
  3000: 60,
  10000: 200,
};

const FEE_TO_TICK_SPACING_BY_DEX: Readonly<Record<string, Readonly<Record<number, number>>>> = {
  [DEX_IDS.PANCAKESWAP_V3]: PANCAKE_FEE_TO_TICK_SPACING,
  [DEX_IDS.UNISWAP_V3]: UNISWAP_FEE_TO_TICK_SPACING,
};

/** Raised for any input the planner refuses to plan against (§ Fail Closed). */
export class PositionPlanError extends Error {
  /** Stable machine-readable discriminant, also prefixed onto `message` for log greppability. */
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(`${reason}: ${message}`);
    this.name = 'PositionPlanError';
    this.reason = reason;
  }
}

export interface PositionPlanInput {
  readonly pool: PoolPriceView;
  readonly token0: TokenMeta;
  readonly token1: TokenMeta;
  /** Total USD capital committed to the LP position (e.g. 7000). */
  readonly capitalUsd: UsdAmount;
  /** §33 `lower = current * lowerRatio` (0.85). */
  readonly lowerRatio: number;
  /** §33 `upper = current * upperRatio` (1.16). */
  readonly upperRatio: number;
  /** USD price of one whole token0. Required when neither leg is a stablecoin. */
  readonly referencePriceUsd?: PriceUsd;
}

export interface PositionPlan {
  /** §33 price bounds in token1-per-token0 units, before tick alignment. */
  readonly lowerPrice: PriceUsd;
  readonly upperPrice: PriceUsd;
  readonly lowerTick: Tick;
  readonly upperTick: Tick;
  readonly liquidity: bigint;
  /** RAW token0 required by the position (already includes the swap's output). */
  readonly amount0: bigint;
  /** RAW token1 required by the position (already includes the swap's output). */
  readonly amount1: bigint;
  readonly valueToken0Usd: UsdAmount;
  readonly valueToken1Usd: UsdAmount;
  /** §38: the leg to buy so that the wallet ends up with exactly `amount0`/`amount1`. */
  readonly swapNeeded: {
    readonly tokenIn: Address;
    readonly tokenOut: Address;
    readonly amountIn: bigint;
  } | null;
  /** §49 `(current - lower) / (upper - lower)`. An indicator only; never clamped. */
  readonly rangeProgress: number;
}

/** Fee → tickSpacing for a specific DEX (§34 + research §5). Throws on an unknown combination. */
export function tickSpacingForFee(dex: string, feeTier: number): number {
  const table = FEE_TO_TICK_SPACING_BY_DEX[dex];
  if (table === undefined) {
    throw new PositionPlanError(
      'UNKNOWN_DEX',
      `no fee->tickSpacing map for dex "${dex}" (poolId must be "<chainId>:<dex>:<poolAddress>")`,
    );
  }
  const spacing = Object.hasOwn(table, feeTier) ? table[feeTier] : undefined;
  if (spacing === undefined) {
    throw new PositionPlanError(
      'UNKNOWN_FEE_TIER',
      `fee tier ${feeTier} is not deployed by ${dex} (known: ${Object.keys(table).join(', ')})`,
    );
  }
  return spacing;
}

/** `poolId` is `${chainId}:${dex}:${poolAddress}` (primitives.ts) — parse rather than guess. */
function parsePoolId(poolId: string): { chainId: number; dex: string } {
  const parts = poolId.split(':');
  if (parts.length !== 3) {
    throw new PositionPlanError('MALFORMED_POOL_ID', `poolId "${poolId}" is not "<chainId>:<dex>:<poolAddress>"`);
  }
  const [chainIdText, dex] = parts as [string, string, string];
  const chainId = Number(chainIdText);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new PositionPlanError('MALFORMED_POOL_ID', `poolId "${poolId}" has a non-numeric chainId`);
  }
  return { chainId, dex };
}

function requirePositive(label: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new PositionPlanError('INVALID_INPUT', `${label} must be a finite positive number, got ${value}`);
  }
  return value;
}

/**
 * A price as an exact rational numerator/denominator for the SDK's `Price`.
 *
 * `Price` normalises by decimals (`adjusted = numerator/denominator * 10^baseDec / 10^quoteDec`),
 * so to obtain `quote per base` in whole-token terms the raw ratio must be
 * `price * 10^quoteDec / 10^baseDec`.
 */
function toRawPriceFraction(price: number, baseDecimals: number, quoteDecimals: number): {
  numerator: bigint;
  denominator: bigint;
} {
  // 1e12 of price resolution is far below the tick granularity (1e-4 relative) for any price
  // that can exist on chain, and keeps the tick round-trip exact vs. the SDK in practice.
  const scaled = BigInt(Math.round(price * Number(USD_SCALE)));
  if (scaled <= 0n) {
    throw new PositionPlanError('INVALID_INPUT', `price ${price} rounds to zero at 1e-12 resolution`);
  }
  return {
    numerator: scaled * 10n ** BigInt(quoteDecimals),
    denominator: USD_SCALE * 10n ** BigInt(baseDecimals),
  };
}

/**
 * Tick for `price` (token1 per token0), rounded to the **closest** tick that still represents a
 * price >= the input, matching `priceToClosestTick` and rounding to the given spacing (§34).
 */
function alignedTick(
  price: number,
  token0: Token,
  token1: Token,
  tickSpacing: number,
): Tick {
  const { numerator, denominator } = toRawPriceFraction(price, token0.decimals, token1.decimals);
  const price_ = new Price(token0, token1, denominator, numerator);
  const closest = priceToClosestTick(price_);
  const tick = nearestUsableTick(closest, tickSpacing);
  if (tick % tickSpacing !== 0) {
    throw new PositionPlanError('TICK_NOT_ALIGNED', `tick ${tick} is not a multiple of spacing ${tickSpacing}`);
  }
  return tick;
}

/** §37 amounts at a given `L`, using the same truncation as the SDK's `Position.amount0/amount1`. */
export function liquidityToAmounts(args: {
  readonly tick: Tick;
  readonly lowerTick: Tick;
  readonly upperTick: Tick;
  readonly sqrtPriceX96: bigint;
  readonly liquidity: bigint;
}): { readonly amount0: bigint; readonly amount1: bigint } {
  const { tick, lowerTick, upperTick, sqrtPriceX96, liquidity } = args;
  const sqrtLowerX96 = TickMath.getSqrtRatioAtTick(lowerTick);
  const sqrtUpperX96 = TickMath.getSqrtRatioAtTick(upperTick);
  if (tick < lowerTick) {
    // Price below the range: the position is 100% token0 across the whole width.
    return { amount0: SqrtPriceMath.getAmount0Delta(sqrtLowerX96, sqrtUpperX96, liquidity, false), amount1: 0n };
  }
  if (tick < upperTick) {
    // In range: both legs are live.
    return {
      amount0: SqrtPriceMath.getAmount0Delta(sqrtPriceX96, sqrtUpperX96, liquidity, false),
      amount1: SqrtPriceMath.getAmount1Delta(sqrtLowerX96, sqrtPriceX96, liquidity, false),
    };
  }
  // Price above the range: the position is 100% token1.
  return { amount0: 0n, amount1: SqrtPriceMath.getAmount1Delta(sqrtLowerX96, sqrtUpperX96, liquidity, false) };
}

/**
 * Solve `L` such that the position value just fits `capitalUsd` (§37 "根据 Total USD Capital 反推 L").
 *
 * `L ↦ value(L)` is a non-decreasing step function of the truncated amounts, so the largest `L`
 * that does not exceed the committed capital is found by bracketing and bisection on `fits()`
 * alone. `valueAt` is the only place the §37 branches are evaluated, so the solve can never
 * disagree with the amounts it returns. The result is never below the SDK's `min(L0, L1)` implied
 * by `(amount0, amount1)`, which keeps the §39 add-liquidity call faithful to the plan.
 */
function maxLiquidityForCapital(capitalTarget: bigint, valueAt: (liquidity: bigint) => bigint): bigint {
  const fits = (candidate: bigint): boolean => valueAt(candidate) <= capitalTarget;
  if (!fits(1n)) {
    throw new PositionPlanError('CAPITAL_TOO_SMALL', 'USD capital cannot fund even one unit of liquidity');
  }

  let low = 1n;
  let high = 2n;
  for (let doublings = 0; fits(high); doublings++) {
    if (doublings > 255) {
      throw new PositionPlanError('LIQUIDITY_SEARCH_FAILED', 'could not bracket the maximum affordable liquidity');
    }
    low = high;
    high *= 2n;
  }

  // Invariant on entry and exit: fits(low) && !fits(high).
  while (high - low > 1n) {
    const mid = low + (high - low) / 2n;
    if (fits(mid)) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return low;
}

/**
 * USD price of one whole token for each leg.
 *
 * `referencePriceUsd`, when given, is the token0 leg and the token1 leg is derived from the pool
 * ratio (no external assumption). Otherwise the leg that `TokenMeta.kind` identifies as a
 * stablecoin is the accounting unit (1.0) — identity comes from the address whitelist, never from
 * the symbol (§8). With no stablecoin leg and no reference price there is no trustworthy way to
 * value the capital, so the planner refuses (§ Fail Closed) rather than guess.
 */
function resolveUsdPrices(
  poolPriceToken1PerToken0: number,
  token0: TokenMeta,
  token1: TokenMeta,
  referencePriceUsd: PriceUsd | undefined,
): { price0Usd: number; price1Usd: number } {
  if (referencePriceUsd !== undefined) {
    const price0Usd = requirePositive('referencePriceUsd', referencePriceUsd);
    return { price0Usd, price1Usd: price0Usd / poolPriceToken1PerToken0 };
  }
  const token1IsStable = token1.kind === TOKEN_KINDS.STABLECOIN;
  const token0IsStable = token0.kind === TOKEN_KINDS.STABLECOIN;
  if (token1IsStable && !token0IsStable) {
    return { price0Usd: poolPriceToken1PerToken0, price1Usd: 1 };
  }
  if (token0IsStable && !token1IsStable) {
    return { price0Usd: 1, price1Usd: 1 / poolPriceToken1PerToken0 };
  }
  throw new PositionPlanError(
    'MISSING_REFERENCE_PRICE',
    `cannot value capital for ${token0.symbol}/${token1.symbol}: neither leg is a whitelisted ` +
      'stablecoin and no referencePriceUsd was supplied',
  );
}

/**
 * §33-§38 plan a concentrated-liquidity position for a single pool.
 *
 * Pure and side-effect free: no RPC, no signing, no global state. `swapNeeded.amountIn` is the
 * mid-price requirement only — fee, slippage and price-impact headroom are §40 concerns owned by
 * the swap planner (T9), which must add them before encoding.
 */
export function planPosition(input: PositionPlanInput): PositionPlan {
  const { pool, token0, token1, capitalUsd } = input;
  const { chainId, dex } = parsePoolId(pool.poolId);

  const capital = requirePositive('capitalUsd', capitalUsd);
  const currentPrice = requirePositive('pool.priceToken1PerToken0', pool.priceToken1PerToken0);
  const lowerRatio = requirePositive('lowerRatio', input.lowerRatio);
  const upperRatio = requirePositive('upperRatio', input.upperRatio);
  if (!(lowerRatio < 1 && upperRatio > 1)) {
    throw new PositionPlanError('INVALID_RANGE_RATIOS', `expected lowerRatio < 1 < upperRatio, got ${lowerRatio} / ${upperRatio}`);
  }
  if (pool.sqrtPriceX96 <= 0n) {
    throw new PositionPlanError('INVALID_INPUT', 'pool.sqrtPriceX96 must be positive');
  }
  if (token0.address.toLowerCase() === token1.address.toLowerCase()) {
    throw new PositionPlanError('INVALID_INPUT', 'token0 and token1 are the same address');
  }

  // §34 + research §5: the spacing must come from this DEX's own fee map. A pool view whose
  // `tickSpacing` disagrees means one of the two layers has the wrong DEX/fee pairing, which is
  // exactly the silent wrong-pool failure mode — refuse instead of aligning to the wrong grid.
  const tickSpacing = tickSpacingForFee(dex, pool.feeTier);
  if (pool.tickSpacing !== tickSpacing) {
    throw new PositionPlanError(
      'TICK_SPACING_MISMATCH',
      `pool reports tickSpacing ${pool.tickSpacing} but ${dex} fee ${pool.feeTier} maps to ${tickSpacing}`,
    );
  }

  const sdkToken0 = new Token(chainId, token0.address, token0.decimals, token0.symbol);
  const sdkToken1 = new Token(chainId, token1.address, token1.decimals, token1.symbol);

  // §33 range from the strategy config ratios — never hardcoded.
  const lowerPrice = currentPrice * lowerRatio;
  const upperPrice = currentPrice * upperRatio;
  const lowerTick = alignedTick(lowerPrice, sdkToken0, sdkToken1, tickSpacing);
  const upperTick = alignedTick(upperPrice, sdkToken0, sdkToken1, tickSpacing);
  if (lowerTick >= upperTick) {
    throw new PositionPlanError('EMPTY_RANGE', `aligned range is empty: [${lowerTick}, ${upperTick}]`);
  }

  const sqrtCurrentX96 = pool.sqrtPriceX96;

  const { price0Usd, price1Usd } = resolveUsdPrices(currentPrice, token0, token1, input.referencePriceUsd);
  const price0Scaled = BigInt(Math.round(price0Usd * Number(USD_SCALE)));
  const price1Scaled = BigInt(Math.round(price1Usd * Number(USD_SCALE)));
  // USD value carried to a common denominator of 10^(d0+d1) so the comparison against the
  // committed capital stays in exact integers (no float threshold can hide a wei of overspend).
  const scale0 = 10n ** BigInt(token0.decimals);
  const scale1 = 10n ** BigInt(token1.decimals);
  const capitalTarget = BigInt(Math.round(capital * Number(USD_SCALE))) * scale0 * scale1;

  const valueAt = (liquidity: bigint): bigint => {
    const { amount0, amount1 } = liquidityToAmounts({ tick: pool.tick, lowerTick, upperTick, sqrtPriceX96: sqrtCurrentX96, liquidity });
    return amount0 * price0Scaled * scale1 + amount1 * price1Scaled * scale0;
  };

  const liquidity = maxLiquidityForCapital(capitalTarget, valueAt);

  const { amount0, amount1 } = liquidityToAmounts({ tick: pool.tick, lowerTick, upperTick, sqrtPriceX96: sqrtCurrentX96, liquidity });

  const valueToken0Usd = (Number(amount0) / 10 ** token0.decimals) * price0Usd;
  const valueToken1Usd = (Number(amount1) / 10 ** token1.decimals) * price1Usd;

  // §38: the capital arrives as the quote/stablecoin leg (token1), so the shortfall is always
  // token0 bought with token1. Mid-price only; T9 adds the §40 guards.
  let swapNeeded: PositionPlan['swapNeeded'] = null;
  if (amount0 > 0n) {
    // token1 needed = ceil(amount0 * P) with P = sqrtPriceX96^2 / 2^192. Round the input UP so the
    // swap can never under-deliver the token0 the position needs.
    const amountIn = (amount0 * sqrtCurrentX96 * sqrtCurrentX96 + Q192 - 1n) / Q192;
    if (amountIn > 0n) {
      swapNeeded = { tokenIn: token1.address, tokenOut: token0.address, amountIn };
    }
  }

  // §49, on the same price scale as `lowerPrice`/`upperPrice`.
  const rangeProgress = (currentPrice - lowerPrice) / (upperPrice - lowerPrice);

  return {
    lowerPrice,
    upperPrice,
    lowerTick,
    upperTick,
    liquidity,
    amount0,
    amount1,
    valueToken0Usd,
    valueToken1Usd,
    swapNeeded,
    rangeProgress,
  };
}
