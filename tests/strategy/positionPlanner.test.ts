import { Price, Token } from '@pancakeswap/sdk';
import {
  Pool,
  Position,
  TickMath,
  encodeSqrtRatioX96,
  maxLiquidityForAmounts,
  nearestUsableTick,
  priceToClosestTick,
} from '@pancakeswap/v3-sdk';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.ts';
import {
  PositionPlanError,
  liquidityToAmounts,
  planPosition,
  tickSpacingForFee,
} from '../../src/strategy/positionPlanner.ts';
import type { PoolPriceView } from '../../src/types/adapters.ts';
import { DEX_IDS, TOKEN_KINDS } from '../../src/types/primitives.ts';
import type { TokenMeta } from '../../src/types/token.ts';

/**
 * T8 acceptance: §33 upper/lower, §34 tick alignment, §35-§37 optimal (not 50/50) ratio,
 * §38 swap amount, §49 range progress.
 *
 * The cross-check target is `@pancakeswap/v3-sdk` — the same library the executor will use — so
 * "correct" here means "agrees with the SDK on the same input", not "matches a re-derivation".
 */

/** Real addresses (research `onchain-facts-2026-09-29.md` §1/§4.1). */
const QQQB = '0x205812cdbed920aff76c6580abd681a46d11efc7';
const USDT = '0x55d398326f99059ff775485246999027b3197955';
const USDC = '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d';
/** QQQB/USDT PancakeSwap V3, fee 0.01% → tickSpacing 1. */
const PANCAKE_QQQB_USDT = '0xe531fcb1f5a195de7608b9f4f9518544c2cdb693';
/** QQQB/USDC Uniswap V3 (BSC), fee 0.3% → tickSpacing 60. */
const UNISWAP_QQQB_USDC = '0xfc4e77248b76fefc27c4cac7151a2ee5b5cc590e';

const AS_OF = '2026-09-29T09:46:00.000Z';
const DECIMALS_18 = 10n ** 18n;

function tokenMeta(address: string, symbol: string, kind: string): TokenMeta {
  return {
    id: `56:${address}`,
    chainId: 56,
    address: address as `0x${string}`,
    kind: kind as TokenMeta['kind'],
    decimals: 18,
    symbol,
    riskTier: 'CORE',
    autoTrade: true,
    isStockToken: kind === TOKEN_KINDS.BSTOCKS,
    uiAmount:
      kind === TOKEN_KINDS.BSTOCKS
        ? { mode: 'bep677-scaled', multiplierDecimals: 18 }
        : { mode: 'plain', multiplierDecimals: 0 },
  };
}

const QQQB_META = tokenMeta(QQQB, 'QQQB', TOKEN_KINDS.BSTOCKS);
const USDT_META = tokenMeta(USDT, 'USDT', TOKEN_KINDS.STABLECOIN);
const USDC_META = tokenMeta(USDC, 'USDC', TOKEN_KINDS.STABLECOIN);

/**
 * A pool view for `quotePerBase` (token1 per token0) with `sqrtPriceX96`/`tick` derived from that
 * same price, exactly as the adapters derive them from `slot0()`.
 */
function poolView(args: {
  dex: string;
  poolAddress: string;
  feeTier: number;
  tickSpacing: number;
  priceToken1PerToken0: number;
}): PoolPriceView {
  const sqrtPriceX96 = encodeSqrtRatioX96(
    BigInt(Math.round(args.priceToken1PerToken0 * 1e9)) * DECIMALS_18,
    10n ** 9n * DECIMALS_18,
  );
  return {
    poolId: `56:${args.dex}:${args.poolAddress}`,
    sqrtPriceX96,
    tick: TickMath.getTickAtSqrtRatio(sqrtPriceX96),
    liquidity: 0n,
    feeTier: args.feeTier,
    tickSpacing: args.tickSpacing,
    priceToken1PerToken0: args.priceToken1PerToken0,
    asOf: AS_OF,
  };
}

/** The Pancake QQQB/USDT case: price 700 USDT per QQQB, fee 0.01%, spacing 1. */
function pancakePool(price = 700, overrides: Partial<PoolPriceView> = {}): PoolPriceView {
  return {
    ...poolView({
      dex: DEX_IDS.PANCAKESWAP_V3,
      poolAddress: PANCAKE_QQQB_USDT,
      feeTier: 100,
      tickSpacing: 1,
      priceToken1PerToken0: price,
    }),
    ...overrides,
  };
}

/** The Uniswap QQQB/USDC case: price 700 USDC per QQQB, fee 0.3%, **spacing 60**. */
function uniswapPool(price = 700, overrides: Partial<PoolPriceView> = {}): PoolPriceView {
  return {
    ...poolView({
      dex: DEX_IDS.UNISWAP_V3,
      poolAddress: UNISWAP_QQQB_USDC,
      feeTier: 3000,
      tickSpacing: 60,
      priceToken1PerToken0: price,
    }),
    ...overrides,
  };
}

const DEFAULT_RANGE = { lowerRatio: 0.85, upperRatio: 1.16 } as const;

function plan(pool: PoolPriceView, overrides: Partial<Parameters<typeof planPosition>[0]> = {}) {
  return planPosition({
    pool,
    token0: QQQB_META,
    token1: USDT_META,
    capitalUsd: 7000,
    ...DEFAULT_RANGE,
    ...overrides,
  });
}

const sdkTokens = { qqqb: new Token(56, QQQB, 18, 'QQQB'), usdt: new Token(56, USDT, 18, 'USDT') };

/** SDK `Pool` for cross-checks. Only usable for fee tiers Pancake actually deploys. */
function sdkPool(pool: PoolPriceView): Pool {
  return new Pool(
    sdkTokens.qqqb,
    sdkTokens.usdt,
    pool.feeTier as 100,
    pool.sqrtPriceX96,
    0n,
    pool.tick,
  );
}

/** SDK's own tick for a target price, for alignment cross-checks. */
function sdkTickFor(price: number): number {
  const numerator = BigInt(Math.round(price * 1e9)) * DECIMALS_18;
  const denominator = 10n ** 9n * DECIMALS_18;
  return priceToClosestTick(new Price(sdkTokens.qqqb, sdkTokens.usdt, denominator, numerator));
}

describe('positionPlanner — §33 upper/lower price', () => {
  it('applies lower = current*0.85 and upper = current*1.16 to the exact value', () => {
    const result = plan(pancakePool(700));

    expect(result.lowerPrice).toBe(595);
    expect(result.upperPrice).toBe(812);
  });

  it('takes the ratios from StrategyConfig.range instead of hardcoding them', async () => {
    const config = await loadConfig();
    const price = 700;
    const result = plan(pancakePool(price));

    // If either side hardcoded 0.85/1.16 this would drift from the YAML-derived ratios.
    expect(result.lowerPrice).toBe(price * config.range.lowerRatio);
    expect(result.upperPrice).toBe(price * config.range.upperRatio);
    expect(config.range.lowerRatio).toBe(0.85);
    expect(config.range.upperRatio).toBe(1.16);
  });

  it('§49 rangeProgress = (current - lower) / (upper - lower)', () => {
    const result = plan(pancakePool(700));

    expect(result.rangeProgress).toBeCloseTo((700 - 595) / (812 - 595), 12);
    expect(result.rangeProgress).toBeCloseTo(0.4838709677419355, 12);
  });
});

describe('positionPlanner — §34 tick alignment', () => {
  it.each([
    [DEX_IDS.PANCAKESWAP_V3, 100, 1],
    [DEX_IDS.PANCAKESWAP_V3, 500, 10],
    [DEX_IDS.PANCAKESWAP_V3, 2500, 50],
    [DEX_IDS.PANCAKESWAP_V3, 10000, 200],
    [DEX_IDS.UNISWAP_V3, 3000, 60],
  ])('%s fee %i → tickSpacing %i', (dex, fee, spacing) => {
    expect(tickSpacingForFee(dex, fee)).toBe(spacing);
  });

  it('does not share one fee→spacing table across DEXes (research §5)', () => {
    // 3000 exists on Uniswap (60) but not on Pancake. A shared table would silently return 60
    // for Pancake too, which is exactly the "silently selects the wrong pool" failure mode.
    expect(tickSpacingForFee(DEX_IDS.UNISWAP_V3, 3000)).toBe(60);
    expect(() => tickSpacingForFee(DEX_IDS.PANCAKESWAP_V3, 3000)).toThrow(PositionPlanError);
  });

  it('aligns both ticks to a multiple of tickSpacing and matches the SDK round trip', () => {
    const pool = uniswapPool(700);
    const result = plan(pool, { token1: USDC_META });
    const spacing = 60;

    expect(result.lowerTick % spacing).toBe(0);
    expect(result.upperTick % spacing).toBe(0);
    // Uniswap fee 3000 / spacing 60 — the Pancake-bound `Pool` class would reject this spacing.
    expect(result.lowerTick).toBe(nearestUsableTick(sdkTickFor(result.lowerPrice), spacing));
    expect(result.upperTick).toBe(nearestUsableTick(sdkTickFor(result.upperPrice), spacing));
    expect(result.lowerTick).toBe(63900);
    expect(result.upperTick).toBe(67020);
  });

  it('rounds a non-aligned price onto the grid instead of passing it through', () => {
    // Spacing 10 (Pancake fee 0.05%): the raw ticks for 595/812 are not multiples of 10.
    const pool = poolView({
      dex: DEX_IDS.PANCAKESWAP_V3,
      poolAddress: '0x47bc06722295ac316a569eef87ac32faa455f441',
      feeTier: 500,
      tickSpacing: 10,
      priceToken1PerToken0: 700,
    });
    const result = plan(pool);

    expect(Math.abs(sdkTickFor(595)) % 10).not.toBe(0);
    expect(result.lowerTick % 10).toBe(0);
    expect(result.upperTick % 10).toBe(0);
    // The aligned range must still bracket the current price.
    expect(result.lowerTick).toBeLessThan(pool.tick);
    expect(result.upperTick).toBeGreaterThan(pool.tick);
  });

  it('alignment never produces a tick the SDK Position would reject', () => {
    for (const price of [0.42, 17.5, 700, 4830.25]) {
      const pool = pancakePool(price);
      const result = plan(pool);

      // Position's constructor asserts tickLower < tickUpper and both % tickSpacing == 0.
      // (Negative ticks yield `-0` from `%`, which is `=== 0` but not `Object.is(0)`.)
      const position = new Position({
        pool: sdkPool(pool),
        tickLower: result.lowerTick,
        tickUpper: result.upperTick,
        liquidity: 1n,
      });
      expect(position.tickLower % pool.tickSpacing === 0).toBe(true);
      expect(position.tickUpper % pool.tickSpacing === 0).toBe(true);
    }
  });

  it('refuses when the pool view disagrees with its own DEX fee map', () => {
    // Uniswap fee 3000 with Pancake's spacing 1: one of the two layers is wrong, so planning on
    // either grid would be a guess.
    expect(() => plan(uniswapPool(700, { tickSpacing: 1 }), { token1: USDC_META })).toThrow(
      /TICK_SPACING_MISMATCH/,
    );
  });
});

describe('positionPlanner — §35-§37 optimal ratio (cross-checked against the SDK)', () => {
  it('solves L from the total USD capital and agrees with the SDK to within 1 wei of liquidity', () => {
    const pool = pancakePool(700);
    const result = plan(pool);
    const sdk = sdkPool(pool);

    // Same inputs through the SDK: L0/L1 from the planner's own amounts must reproduce the
    // planner's L. `maxLiquidityForAmounts` and `Position.fromAmounts` share that code path.
    const sdkLiquidity = maxLiquidityForAmounts(
      pool.sqrtPriceX96,
      TickMath.getSqrtRatioAtTick(result.lowerTick),
      TickMath.getSqrtRatioAtTick(result.upperTick),
      result.amount0,
      result.amount1,
      false,
    );
    const fromAmounts = Position.fromAmounts({
      pool: sdk,
      tickLower: result.lowerTick,
      tickUpper: result.upperTick,
      amount0: result.amount0,
      amount1: result.amount1,
      useFullPrecision: false,
    });

    expect(fromAmounts.liquidity).toBe(sdkLiquidity);

    // The planner returns the largest L whose *truncated* value still fits the capital, so it is
    // never below the SDK's `min(L0, L1)` and the gap is a sub-wei rounding residual.
    const gap = result.liquidity - sdkLiquidity;
    expect(gap >= 0n).toBe(true);
    expect(Number(gap) / Number(sdkLiquidity)).toBeLessThan(1e-12);
    expect(result.liquidity).toBe(1768671767819460977256n);
    expect(sdkLiquidity).toBe(1768671767819460976912n);
  });

  it('§37 amount0/amount1 are exactly the SDK Position amounts (0 wei difference)', () => {
    const pool = pancakePool(700);
    const result = plan(pool);
    const position = new Position({
      pool: sdkPool(pool),
      tickLower: result.lowerTick,
      tickUpper: result.upperTick,
      liquidity: result.liquidity,
    });

    expect(position.amount0.quotient).toBe(result.amount0);
    expect(position.amount1.quotient).toBe(result.amount1);
    expect(result.amount0).toBe(4780202358713309947n);
    expect(result.amount1).toBe(3653858348900683037099n);
  });

  it('the solved L is maximal: L+1 would exceed the committed capital', () => {
    const pool = pancakePool(700);
    const result = plan(pool);
    /** Exact integer USD (1e-12) value of an arbitrary liquidity, independent of the float report. */
    const scaledValueAt = (liquidity: bigint): bigint => {
      const { amount0, amount1 } = liquidityToAmounts({
        tick: pool.tick,
        lowerTick: result.lowerTick,
        upperTick: result.upperTick,
        sqrtPriceX96: pool.sqrtPriceX96,
        liquidity,
      });
      // price0 = 700, price1 = 1, both 18 decimals ⇒ value = amount0*700 + amount1 (raw = 1e18 USD).
      return amount0 * 700n + amount1;
    };

    const capitalRaw = 7000n * DECIMALS_18;
    const atL = scaledValueAt(result.liquidity);
    const atLPlusOne = scaledValueAt(result.liquidity + 1n);

    // The plan never asks for more than the committed capital…
    expect(atL <= capitalRaw).toBe(true);
    // …and it can never be raised by one unit without breaking that guarantee.
    expect(atLPlusOne > capitalRaw).toBe(true);
    // Amounts must actually change at L+1, i.e. L sits on the accounting grid rather than inside a
    // truncation plateau where "largest affordable L" would be vacuous.
    expect(atLPlusOne !== atL).toBe(true);

    expect(result.valueToken0Usd + result.valueToken1Usd).toBeCloseTo(7000, 6);
    expect(result.valueToken0Usd + result.valueToken1Usd).toBeLessThanOrEqual(7000);
  });

  it('uses the whole capital: the position value fills the budget, not just the 50% leg', () => {
    const result = plan(pancakePool(700));

    expect(result.valueToken0Usd).toBeCloseTo(3346.1416510993167, 6);
    expect(result.valueToken1Usd).toBeCloseTo(3653.8583489006833, 6);
    expect(result.valueToken0Usd + result.valueToken1Usd).toBeCloseTo(7000, 6);
  });

  it('values both legs consistently when a reference price is supplied instead of a stablecoin', () => {
    // QQQB/WBNB shape: neither leg is a stablecoin, so the caller must supply the reference.
    const pool = poolView({
      dex: DEX_IDS.PANCAKESWAP_V3,
      poolAddress: '0x47bc06722295ac316a569eef87ac32faa455f441',
      feeTier: 500,
      tickSpacing: 10,
      priceToken1PerToken0: 1.2,
    });
    const result = plan(pool, {
      token1: tokenMeta('0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', 'WBNB', TOKEN_KINDS.WRAPPED_NATIVE),
      referencePriceUsd: 700,
    });

    // The token1 leg must be valued at referencePriceUsd / poolPrice = 700/1.2, not assumed 1.
    // An implementation that treated token1 as a stablecoin would report amount1_ui here.
    const token1PriceUsd = 700 / 1.2;
    expect(result.valueToken1Usd).toBeCloseTo((Number(result.amount1) / 1e18) * token1PriceUsd, 6);
    expect(result.valueToken1Usd).not.toBeCloseTo(Number(result.amount1) / 1e18, 3);
    expect(result.valueToken0Usd).toBeCloseTo((Number(result.amount0) / 1e18) * 700, 6);
    expect(result.valueToken0Usd + result.valueToken1Usd).toBeCloseTo(7000, 6);
  });
});

describe('positionPlanner — §35 counterexample: fixed 50/50 is provably not optimal', () => {
  it('shows the default §33 range already deviates from 50/50', () => {
    const result = plan(pancakePool(700));
    const fixedHalfToken0Value = 3500;
    const deviation = Math.abs(fixedHalfToken0Value - result.valueToken0Usd) / result.valueToken0Usd;

    expect(result.valueToken0Usd).not.toBe(fixedHalfToken0Value);
    expect(deviation).toBeGreaterThan(0.01);
    expect(deviation).toBeCloseTo(0.04598, 4);
  });

  it('shows a > 5% deviation for a wider range, so 50/50 is wrong by a measurable margin', () => {
    const result = plan(pancakePool(700), { lowerRatio: 0.5, upperRatio: 3 });
    const fixedHalfToken0Value = 3500;
    const deviation = Math.abs(fixedHalfToken0Value - result.valueToken0Usd) / result.valueToken0Usd;

    // 50/50 would buy 3500 USD of QQQB. The optimal split buys ~4134.55 USD of it.
    expect(deviation).toBeGreaterThan(0.05);
    expect(deviation).toBeCloseTo(0.15347, 4);
    expect(result.valueToken0Usd).toBeCloseTo(4134.549749, 5);
    expect(result.valueToken0Usd).not.toBe(fixedHalfToken0Value);

    // The optimal token0 leg is what §37/§38 implies for this range, not half the capital.
    expect(result.valueToken0Usd).not.toBeCloseTo(3500, 0);
  });

  it('leaves the 50/50 ratio only barely right when the range is nearly symmetric', () => {
    // A narrower range pulls the split away from 50/50 even harder: the token0 share is a
    // function of where the current price sits inside the range, not a constant.
    const narrow = plan(pancakePool(700), { lowerRatio: 0.9, upperRatio: 1.25 });

    expect(narrow.valueToken0Usd / 7000).toBeCloseTo(0.672768, 5);
    expect(Math.abs(3500 - narrow.valueToken0Usd) / narrow.valueToken0Usd).toBeGreaterThan(0.05);
  });
});

describe('positionPlanner — §38 swap amount', () => {
  it('asks for the token0 shortfall, priced at the pool mid, and never for half the capital', () => {
    const pool = pancakePool(700);
    const result = plan(pool);

    expect(result.amount0).toBeGreaterThan(0n);
    expect(result.swapNeeded).not.toBeNull();
    expect(result.swapNeeded?.tokenIn).toBe(USDT_META.address);
    expect(result.swapNeeded?.tokenOut).toBe(QQQB_META.address);

    // amountIn = ceil(amount0 * P) at the mid price, so it covers exactly the token0 the position
    // needs; T9 adds the §40 fee/slippage/impact headroom on top of this figure.
    const expected = (result.amount0 * pool.sqrtPriceX96 * pool.sqrtPriceX96 + (1n << 192n) - 1n) / (1n << 192n);
    expect(result.swapNeeded?.amountIn).toBe(expected);

    const swapValueUsd = (Number(result.swapNeeded?.amountIn ?? 0n) / 1e18) * 1;
    expect(swapValueUsd).toBeCloseTo(result.valueToken0Usd, 3);
    // Baseline §35 wrong build would swap 3500 USD.
    expect(swapValueUsd).not.toBeCloseTo(3500, 0);
    expect(swapValueUsd).toBeGreaterThan(3300);
    expect(swapValueUsd).toBeLessThan(3400);
  });

  it('returns null when the position needs no token0 (price above the range)', () => {
    const pool = pancakePool(700);
    const planned = plan(pool);
    const above = liquidityToAmounts({
      tick: planned.upperTick + 1,
      lowerTick: planned.lowerTick,
      upperTick: planned.upperTick,
      sqrtPriceX96: TickMath.getSqrtRatioAtTick(planned.upperTick + 1),
      liquidity: planned.liquidity,
    });

    expect(above.amount0).toBe(0n);
    expect(above.amount1).toBeGreaterThan(0n);
  });
});

describe('positionPlanner — §37 branch boundaries', () => {
  /**
   * With ordinary ratios the current price is always inside [lower, upper], so the out-of-range
   * branches describe an *existing* position as price moves. They are exercised on the CL math
   * seam (`liquidityToAmounts`) that risk/valuation reuse, keyed on `tick` vs the bounds exactly
   * as `Position.getToken0Amount`/`getToken1Amount` are.
   */
  const pool = pancakePool(700);
  const planned = plan(pool);
  const { lowerTick, upperTick, liquidity } = planned;
  const sqrtLower = TickMath.getSqrtRatioAtTick(lowerTick);
  const sqrtUpper = TickMath.getSqrtRatioAtTick(upperTick);
  const sqrtAtLowerMinus1 = TickMath.getSqrtRatioAtTick(lowerTick - 1);

  const amountsAt = (tick: number, sqrtPriceX96: bigint) =>
    liquidityToAmounts({ tick, lowerTick, upperTick, sqrtPriceX96, liquidity });

  /**
   * The SDK's own answer for the same position at an arbitrary current tick. Only the fee tier
   * matters here (it fixes the SDK `Pool`'s spacing), and this fixture is spacing 1.
   */
  const amountsFromSdkAtTick = (tick: number) => {
    const position = new Position({
      pool: new Pool(
        sdkTokens.qqqb,
        sdkTokens.usdt,
        100 as 100,
        pool.sqrtPriceX96,
        0n,
        tick,
      ),
      tickLower: lowerTick,
      tickUpper: upperTick,
      liquidity,
    });
    return { amount0: position.amount0.quotient, amount1: position.amount1.quotient };
  };

  it('currentPrice == lowerPrice (tick at the lower bound): in-range, zero token1', () => {
    const at = amountsAt(lowerTick, sqrtLower);

    expect(at.amount1).toBe(0n);
    expect(at.amount0).toBeGreaterThan(0n);
    expect(at.amount0).toBe(
      planned.amount0 + planned.amount1 > 0n
        ? (liquidity << 96n) * (sqrtUpper - sqrtLower) / sqrtUpper / sqrtLower
        : at.amount0,
    );
  });

  it('currentPrice < lowerPrice (tick below the bound): 100% token0 across the full width', () => {
    const at = amountsAt(lowerTick - 1, sqrtAtLowerMinus1);
    const fullWidthToken0 = (liquidity << 96n) * (sqrtUpper - sqrtLower) / sqrtUpper / sqrtLower;

    expect(at.amount1).toBe(0n);
    expect(at.amount0).toBe(fullWidthToken0);
    // Below the range the position is entirely token0; there is no token0 left to gain, so the
    // value equals the "all token0" case and is the maximum over the range.
    expect(at.amount0).toBeGreaterThan(planned.amount0);
    // And it must match what the SDK's Position reports for an out-of-range price.
    expect(at.amount0).toBe(amountsFromSdkAtTick(lowerTick - 1).amount0);
  });

  it('currentPrice == upperPrice (tick at the upper bound): in-range, zero token0', () => {
    const at = amountsAt(upperTick, sqrtUpper);

    expect(at.amount0).toBe(0n);
    expect(at.amount1).toBeGreaterThan(0n);
  });

  it('currentPrice > upperPrice (tick above the bound): 100% token1 across the full width', () => {
    const above = amountsAt(upperTick + 1, TickMath.getSqrtRatioAtTick(upperTick + 1));
    const fullWidthToken1 = liquidity * (sqrtUpper - sqrtLower) / (1n << 96n);

    expect(above.amount0).toBe(0n);
    expect(above.amount1).toBe(fullWidthToken1);
    expect(above.amount1).toBeGreaterThan(planned.amount1);
    expect(above.amount1).toBe(amountsFromSdkAtTick(upperTick + 1).amount1);
  });

  it('amounts shrink monotonically and never go negative across the whole range', () => {
    const samples = [lowerTick - 5, lowerTick, lowerTick + 1, pool.tick, upperTick - 1, upperTick, upperTick + 5];
    let previousToken0 = (1n << 256n) as bigint;

    for (const tick of samples) {
      const at = amountsAt(tick, TickMath.getSqrtRatioAtTick(tick));
      expect(at.amount0 >= 0n).toBe(true);
      expect(at.amount1 >= 0n).toBe(true);
      expect(at.amount0 <= previousToken0).toBe(true);
      previousToken0 = at.amount0;
    }
  });
});

describe('positionPlanner — real pool parameters', () => {
  it('PancakeSwap QQQB/USDT fee 100 (spacing 1)', () => {
    const pool = pancakePool(700);
    const result = plan(pool);

    expect(pool.feeTier).toBe(100);
    expect(pool.tickSpacing).toBe(1);
    expect(result.lowerTick % 1).toBe(0);
    expect(result.upperTick % 1).toBe(0);
    expect(result.lowerTick).toBe(63888);
    expect(result.upperTick).toBe(66998);
    expect(result.liquidity).toBe(1768671767819460977256n);
    expect(result.valueToken0Usd + result.valueToken1Usd).toBeCloseTo(7000, 6);
  });

  it('Uniswap QQQB/USDC fee 3000 (spacing 60)', () => {
    const pool = uniswapPool(700);
    const result = plan(pool, { token1: USDC_META });

    expect(pool.feeTier).toBe(3000);
    expect(pool.tickSpacing).toBe(60);
    expect(result.lowerTick).toBe(63900);
    expect(result.upperTick).toBe(67020);
    expect(result.lowerTick % 60).toBe(0);
    expect(result.upperTick % 60).toBe(0);
    expect(result.valueToken0Usd + result.valueToken1Usd).toBeCloseTo(7000, 6);
    // Coarser spacing ⇒ a slightly different optimal split than the spacing-1 pool.
    expect(result.valueToken0Usd / 7000).toBeCloseTo(0.483333, 5);
  });
});

describe('positionPlanner — fail closed', () => {
  it('refuses a malformed poolId', () => {
    expect(() => plan({ ...pancakePool(700), poolId: 'not-a-pool-id' })).toThrow(/MALFORMED_POOL_ID/);
  });

  it('refuses an unknown DEX', () => {
    expect(() => plan({ ...pancakePool(700), poolId: '56:sushiswap-v3:0xdead' })).toThrow(/UNKNOWN_DEX/);
  });

  it('refuses a fee tier the DEX does not deploy', () => {
    expect(() => plan({ ...pancakePool(700), feeTier: 3000, tickSpacing: 60 })).toThrow(/UNKNOWN_FEE_TIER/);
  });

  it('refuses when neither leg is a stablecoin and no reference price is given', () => {
    expect(() =>
      plan(pancakePool(700), {
        token1: tokenMeta('0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', 'WBNB', TOKEN_KINDS.WRAPPED_NATIVE),
      }),
    ).toThrow(/MISSING_REFERENCE_PRICE/);
  });

  it('refuses non-positive capital, price and ratios', () => {
    expect(() => plan(pancakePool(700), { capitalUsd: 0 })).toThrow(/capitalUsd/);
    expect(() => plan({ ...pancakePool(700), priceToken1PerToken0: 0 })).toThrow(/priceToken1PerToken0/);
    expect(() => plan(pancakePool(700), { lowerRatio: 1.1 })).toThrow(/INVALID_RANGE_RATIOS/);
    expect(() => plan(pancakePool(700), { upperRatio: 0.9 })).toThrow(/INVALID_RANGE_RATIOS/);
  });

  it('refuses a zero sqrtPriceX96 or identical legs', () => {
    expect(() => plan({ ...pancakePool(700), sqrtPriceX96: 0n })).toThrow(/sqrtPriceX96/);
    expect(() => plan(pancakePool(700), { token1: QQQB_META })).toThrow(/same address/);
  });
});
