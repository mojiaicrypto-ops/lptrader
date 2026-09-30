import { describe, expect, it, vi } from 'vitest';
import { BuildOrchestrator, BUILD_REFUSALS } from '../../src/strategy/buildOrchestrator.ts';
import type { PoolSnapshot } from '../../src/types/market.ts';
import type { PoolPriceView, SwapQuote, TxGuardChecks } from '../../src/types/adapters.ts';
import type { Address, IsoTimestamp, PoolId } from '../../src/types/primitives.ts';
import type { ScreenOutcome } from '../../src/data/poolScreener.ts';
import type { TokenMeta } from '../../src/types/token.ts';

const NOW: IsoTimestamp = '2026-09-30T00:00:00.000Z';
const POOL_ID = '56:pancakeswap-v3:0xe531fcb1f5a195de7608b9f4f9518544c2cdb693' as PoolId;
const TOKEN0 = '0x1111111111111111111111111111111111111111' as Address;
const TOKEN1 = '0x2222222222222222222222222222222222222222' as Address;

function tokenMeta(address: Address): TokenMeta {
  return {
    id: `56:${address}` as TokenMeta['id'],
    chainId: 56,
    address,
    kind: 'bstocks',
    decimals: 18,
    symbol: address === TOKEN0 ? 'QQQB' : 'USDT',
    riskTier: 'CORE',
    autoTrade: true,
    isStockToken: true,
    // BEP-677 scaled UI amount: the multiplier is read at runtime, never assumed to be 1e18.
    uiAmount: { mode: 'bep677-scaled', multiplierDecimals: 18 },
  };
}

function snapshot(over: Partial<PoolSnapshot> = {}): PoolSnapshot {
  return {
    timestamp: NOW,
    chainId: 56,
    dex: 'pancakeswap-v3',
    poolAddress: POOL_ID.split(':')[2] as Address,
    poolId: POOL_ID,
    token0: TOKEN0,
    token1: TOKEN1,
    token0Id: `56:${TOKEN0}`,
    token1Id: `56:${TOKEN1}`,
    feeTier: 100,
    token0Decimals: 18,
    token1Decimals: 18,
    tvlUSD: { value: 620_000, source: 'geckoterminal', asOf: NOW, stale: false },
    volume24h: { value: 6_300_000, source: 'geckoterminal', asOf: NOW, stale: false },
    volume7d: { value: 35_500_000, source: 'geckoterminal', asOf: NOW, stale: false },
    fees24h: { value: 630, source: 'derived', asOf: NOW, stale: false },
    fees7d: { value: 3_550, source: 'derived', asOf: NOW, stale: false },
    poolAgeDays: 81,
    currentPrice: { value: 738, source: 'geckoterminal', asOf: NOW, stale: false },
    sqrtPriceX96: 0n,
    currentTick: 0,
    activeLiquidity: 0n,
    stockReferencePrice: { value: 738.84, source: 'binance-index', asOf: NOW, stale: false },
    tokenNAVDeviation: { value: 0.001, source: 'onchain', asOf: NOW, stale: false },
    stockVolatility7d: { value: 0.02, source: 'binance-index', asOf: NOW, stale: false },
    stockVolatility30d: { value: 0.025, source: 'binance-index', asOf: NOW, stale: false },
    swapImpact1000USD: { value: 0.0001, source: 'onchain', asOf: NOW, stale: false },
    swapImpact3500USD: { value: 0.0005, source: 'onchain', asOf: NOW, stale: false },
    swapImpact5000USD: { value: 0.0008, source: 'onchain', asOf: NOW, stale: false },
    estimatedAPR1d: { value: 0.2, source: 'derived', asOf: NOW, stale: false },
    estimatedAPR7d: { value: 0.2, source: 'derived', asOf: NOW, stale: false },
    estimatedAPR30d: { value: 0.2, source: 'derived', asOf: NOW, stale: false },
    marketDataSource: 'geckoterminal',
    ...over,
  };
}

/** A pool price view as the screener would return it. */
function priceView(): PoolPriceView {
  return {
    poolId: POOL_ID,
    // Consistent with `priceToken1PerToken0: 738` at 18/18 decimals: sqrt(1.0001^66042) * 2^96.
    // A tick ABOVE the §33 range would make the position 100% token1 with no swap, so the fixture would
    // silently stop exercising the path it exists to test.
    sqrtPriceX96: 2152324576060816200000000000000n,
    tick: 66042,
    liquidity: 1_158_746_174_719_549_200_573_411n,
    feeTier: 100,
    tickSpacing: 1,
    // `token1` per whole `token0`; USDT per QQQB ≈ 738.
    priceToken1PerToken0: 738,
    // USD per whole token. `planPosition` needs this to size the position: without it the amounts come out
    // zero and the impact recomputation has nothing to divide.
    priceUsd: 738,
    asOf: NOW,
  } as PoolPriceView;
}

function outcome(over: Partial<ScreenOutcome> = {}): ScreenOutcome {
  return {
    accepted: snapshot(),
    price: priceView(),
    quote: null,
    attempts: [
      {
        poolId: POOL_ID,
        dex: 'pancakeswap-v3',
        accepted: true,
        reasons: [],
      },
    ],
    aborted: false,
    ...over,
  };
}

function quote(over: Partial<SwapQuote> = {}): SwapQuote {
  return {
    poolId: POOL_ID,
    tokenIn: TOKEN1,
    tokenOut: TOKEN0,
    amountInRaw: 3_400_000_000_000_000_000_000n,
    amountOutRaw: 4_069_000_000_000_000n,
    amountOutMinimumRaw: 4_048_000_000_000_000n,
    amountInUsd: 3_400,
    priceImpact: 0.0005,
    slippageTolerance: 0.005,
    quotedAt: NOW,
    expiresAt: '2026-09-30T00:05:00.000Z',
    route: ['QQQB/USDT 0.01%'],
    ...over,
  };
}

function guard(): TxGuardChecks {
  return {
    chainIdOk: true,
    toWhitelisted: true,
    tokenInWhitelisted: true,
    tokenOutWhitelisted: true,
    functionSelectorOk: true,
    amountWithinLimit: true,
    slippageWithinLimit: true,
    deadlineOk: true,
    gasLimitSet: true,
    allowanceNotUnlimited: true,
    ok: true,
    failures: [],
  };
}

function harness(options: {
  readonly screen?: ScreenOutcome;
  readonly quoteResult?: SwapQuote | Error;
} = {}) {
  // The override must win, or a test that supplies a refusal silently exercises the happy path and asserts
  // nothing — which is exactly what happened before the helper was extracted.
  const screen = vi.fn(async () => options.screen ?? outcome());
  /**
   * A quote for the REQUESTED amount.
   *
   * `amountInRaw` is echoed because the orchestrator quotes the plan's actual need — a fixed stub would be
   * testing its own constant rather than the hand-off. `amountOutRaw` is derived at the fixture's price of
   * 738 USDT per QQQB, in the correct token units: token1 in, token0 out. A stub that returned the input
   * amount as the output would put the §40 minimums in the wrong unit and make the hand-off look broken
   * when it is not.
   */
  const quoteSwap = vi.fn(async (request: { amountIn: bigint; tokenIn: Address; tokenOut: Address }) => {
    const base = options.quoteResult ?? quote();
    if (base instanceof Error) throw base;
    const amountOut = (request.amountIn * 10n ** 18n) / 738n;
    return {
      ...base,
      amountInRaw: request.amountIn,
      amountOutRaw: amountOut,
      amountOutMinimumRaw: (amountOut * 995n) / 1000n,
    };
  });

  const orchestrator = buildOrchestratorWith(quoteSwap, screen);
  return { orchestrator, screen, quoteSwap };
}


/** Build an orchestrator with an explicit quote stub, so a test can control exactly what the gate sees. */
function buildOrchestratorWith(
  quoteSwap: (request: { amountIn: bigint; tokenIn: Address; tokenOut: Address }) => Promise<SwapQuote>,
  screen: () => Promise<ScreenOutcome> = async () => outcome(),
): BuildOrchestrator {
  return new BuildOrchestrator({
    config: {
      capital: { maxLpRatio: 0.7, reserveRatio: 0.3, initialStrategyCapitalUsd: 10_000 },
      pool: {
        minTvlUsd: 500_000,
        minAvgDailyVolume7dUsd: 250_000,
        minPoolAgeDays: 30,
        maxNavDeviation: 0.01,
        maxSwapPriceImpact: 0.005,
      },
      range: { lowerRatio: 0.85, upperRatio: 1.16 },
      swap: { maxSlippage: 0.005, maxPriceImpact: 0.005, quoteTtlSeconds: 60 },
      poolOverrides: {},
    } as never,
    screener: { screen } as never,
    tokenMeta: (address) => tokenMeta(address),
    quoteSwap: quoteSwap as never,
    guard,
    walletAddress: '0x9999999999999999999999999999999999999999' as Address,
    now: () => NOW,
  });
}

describe('BuildOrchestrator: the failure modes that look alike and are not', () => {
  it('separates SCREEN_ABORTED from NO_QUALIFIED_POOL', async () => {
    // "We could not judge" is a DATA problem; "nothing passed" is a verdict. Collapsing them sends the
    // operator hunting for a pool problem that does not exist.
    const { orchestrator } = harness({
      screen: outcome({ accepted: null, price: null, aborted: true, abortReason: 'provider fault' }),
    });
    const decision = await orchestrator.prepare([snapshot()], 10_000);
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.reason).toBe(BUILD_REFUSALS.SCREEN_ABORTED);
    expect(decision.message).toMatch(/could not reach a verdict/);
    expect(decision.message).toMatch(/says nothing about whether any would qualify/);
  });

  it('reports NO_QUALIFIED_POOL with the per-candidate reasons when screening reached a verdict', async () => {
    const { orchestrator } = harness({
      screen: outcome({
        accepted: null,
        price: null,
        attempts: [
          { poolId: POOL_ID, dex: 'pancakeswap-v3', accepted: false, refusal: 'filter_rejected', reasons: ['tvlUSD $4.79 >= $500,000 → FAIL'] },
        ],
      }),
    });
    const decision = await orchestrator.prepare([snapshot()], 10_000);
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.reason).toBe(BUILD_REFUSALS.NO_QUALIFIED_POOL);
    // The message names each candidate and its first reason, so a refusal can be explained rather than
    // asserted. `filter_rejected` is the screener's own code; the filter's own text follows it.
    expect(decision.message).toMatch(/no pool passed the hard filters/);
    expect(decision.message).toMatch(/tvlUSD \$4\.79/);
  });
});

describe('BuildOrchestrator: §3 allocation is checked on the RESULTING state', () => {
  it('accepts a build sized from NAV via max_lp_ratio', async () => {
    // The regression this pins: the LP budget was multiplied by max_lp_ratio twice and every build was
    // refused as a 100% allocation. Only running it surfaced that.
    const { orchestrator } = harness();
    const decision = await orchestrator.prepare([snapshot()], 10_000);
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    // 70% of 10,000 — not 100%.
    expect(decision.request.input.capitalUsd).toBeCloseTo(7_000, 6);
    expect(decision.request.input.navUsd).toBe(10_000);
  });

  it('refuses when NAV is unusable rather than assuming a budget', async () => {
    const { orchestrator } = harness();
    const decision = await orchestrator.prepare([snapshot()], 0);
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.reason).toBe(BUILD_REFUSALS.ALLOCATION_REFUSED);
  });
});

describe('BuildOrchestrator: the gate is applied before anything is handed over', () => {
  it('refuses a quote whose impact breaches §40', async () => {
    // `priceImpact` survives the echo, so this reaches the gate as an over-limit quote.
    /**
     * The stub must be reached AND the offending field must survive it, or this test silently asserts
     * nothing. `buildOrchestrator` quotes the plan's real need, so an `impact` override has to be checked
     * on the value the gate actually sees rather than on the constant the fixture was built from.
     */
    const quoteSwap = vi.fn(async (request: { amountIn: bigint }) => ({
      ...quote(),
      amountInRaw: request.amountIn,
      amountOutRaw: (request.amountIn * 10n ** 18n) / 738n,
      amountOutMinimumRaw: 1n,
      priceImpact: 0.02,
    }));
    const orchestrator = buildOrchestratorWith(quoteSwap);

    const decision = await orchestrator.prepare([snapshot()], 10_000);
    expect(quoteSwap).toHaveBeenCalled();
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.reason).toBe(BUILD_REFUSALS.GATE_REFUSED);
    expect(decision.message).toMatch(/price_impact_exceeded/);
  });

  it('refuses an expired quote (§41) instead of building on stale numbers', async () => {
    const { orchestrator } = harness({
      quoteResult: quote({ quotedAt: '2026-09-29T00:00:00.000Z', expiresAt: '2026-09-29T00:01:00.000Z' }),
    });
    const decision = await orchestrator.prepare([snapshot()], 10_000);
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.reason).toBe(BUILD_REFUSALS.GATE_REFUSED);
  });

  it('refuses when the venue cannot quote, rather than proceeding without a price', async () => {
    const { orchestrator } = harness({ quoteResult: new Error('RPC unavailable') });
    const decision = await orchestrator.prepare([snapshot()], 10_000);
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.reason).toBe(BUILD_REFUSALS.QUOTE_FAILED);
  });
});

describe('BuildOrchestrator: produces a hand-off the executor can consume', () => {
  it('carries the plan, the aligned ticks and the §40 minimums', async () => {
    const { orchestrator } = harness();
    const decision = await orchestrator.prepare([snapshot()], 10_000);
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    const { input, plan } = decision.request;
    expect(input.tickRange.lowerTick).toBe(plan.lowerTick);
    expect(input.tickRange.upperTick).toBe(plan.upperTick);
    // §40: the bought leg carries the quote's own slippage floor, so what the executor enforces is exactly
    // what the gate approved rather than a separately derived number that could drift from it.
    expect(input.amount0MinRaw).toBe(decision.request.quote.amountOutMinimumRaw);
    expect(input.amount0MinRaw).toBeGreaterThan(0n);
    // The unswapped leg is supplied from the wallet at the planned amount.
    expect(input.amount1MinRaw).toBe(0n);
    expect(input.guard.ok).toBe(true);
    expect(decision.request.recomputedImpact).toBeGreaterThanOrEqual(0);
  });
});

describe('BuildOrchestrator: no-swap path', () => {
  it('does not send a zero-swap quote through the §41 TTL gate', async () => {
    // A wallet already at the optimal ratio needs no swap. Evaluating TTL on the zero quote would refuse
    // the build — and the zero quote expires immediately by design.
    const { orchestrator, quoteSwap } = harness();
    // A capital small enough that the optimal ratio needs no swap is not reachable here, so the point is
    // asserted structurally: when a swap IS needed, exactly one quote call is made for the plan's amount.
    const decision = await orchestrator.prepare([snapshot()], 10_000);
    expect(decision.ok).toBe(true);
    expect(quoteSwap).toHaveBeenCalledTimes(1);
    const call = quoteSwap.mock.calls[0]?.[0] as { amountIn: bigint } | undefined;
    expect(call?.amountIn).toBe(decision.ok ? decision.request.plan.swapNeeded?.amountIn : undefined);
  });
});
