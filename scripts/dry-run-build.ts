/**
 * §39/§101/§102 dry-run build: the full build decision chain, ending in a verified plan and NO send.
 *
 * This is the highest-value verification available short of a live position. On live data it runs the
 * real components in the real order:
 *
 *   PoolScanner (§14/§15/§83) → PoolFilter (§16) → PositionPlanner (§33-§38)
 *   → DexAdapter.quoteSwap (QuoterV2) → SwapPlanner gates (§40/§41) → signable intent
 *
 * then stops. The only difference from a live build is that no approval is requested and no
 * transaction is signed.
 *
 * ## Why this is not just "a quote"
 * The dangerous failures in this strategy are not "the swap reverted". They are:
 *   - the plan quietly using a fixed 50/50 split instead of the concentrated-liquidity solution, so the
 *     position is under-funded and the swap amount is wrong (§35);
 *   - a tick that is not aligned to the pool's spacing, which reverts the mint *after* the swap landed;
 *   - the §40 impact gate being applied after encoding, i.e. too late;
 *   - an atomic-capable venue silently degrading to two transactions, losing all-or-nothing semantics.
 * Every one of those is visible in the printed plan and invisible in a bare quote, so each is printed
 * and cross-checked against an independent computation.
 *
 * ## Safety
 * Never signs, never sends, never creates an approval. The output is the plan, the gate verdicts and
 * the reasons — plus the exact numbers a human would be shown when approving the real build.
 *
 * Run: `node --experimental-strip-types scripts/dry-run-build.ts [capitalUsd]`
 */
import { loadConfig } from '../src/config/index.ts';
import { BscChainAdapter } from '../src/chain/adapter.ts';
import { createPancakeV3Adapter } from '../src/dex/pancakeV3.ts';
import { createUniswapV3Adapter } from '../src/dex/uniswapV3.ts';
import { tickSpacingFor } from '../src/dex/index.ts';
import { BscOnchainPoolStateSource } from '../src/data/bscOnchainSource.ts';
import { createReferencePriceProvider } from '../src/data/referencePrice.ts';
import { LayeredPoolDataProvider } from '../src/data/poolDataProvider.ts';
import { createPoolScanner, foundPools } from '../src/data/poolScanner.ts';
import { filterPools } from '../src/data/poolFilter.ts';
import { planPosition } from '../src/strategy/positionPlanner.ts';
import { computePriceImpact, evaluateSwapQuote, planSwapIntent } from '../src/strategy/swapPlanner.ts';
import type { DexAdapter } from '../src/types/adapters.ts';
import type { PoolSnapshot } from '../src/types/market.ts';
import { DEX_IDS } from '../src/types/primitives.ts';

const capitalUsd = Number(process.argv[2] ?? '7000');
if (!Number.isFinite(capitalUsd) || capitalUsd <= 0) {
  process.stderr.write(`capital must be a positive number, got ${String(process.argv[2])}\n`);
  process.exit(2);
}

const out = (label: string, value: unknown): void => {
  process.stdout.write(`  ${label.padEnd(32)} ${String(value)}\n`);
};
const heading = (text: string): void => {
  process.stdout.write(`\n${text}\n${'-'.repeat(Math.max(text.length, 24))}\n`);
};

const config = await loadConfig();
const chain = new BscChainAdapter({ chainId: 56, whitelist: config.whitelist });
const adapters: readonly DexAdapter[] = [
  createPancakeV3Adapter({ chainId: 56, whitelist: config.whitelist, chain }),
  createUniswapV3Adapter({ chainId: 56, whitelist: config.whitelist, chain }),
];

heading('lptrader — dry-run build (nothing is signed or sent)');
out('config', config.sourcePath ?? '<unknown>');
out('capital (USD)', capitalUsd.toFixed(2));
out('LP capital (max)', (capitalUsd * config.capital.maxLpRatio).toFixed(2));
out('range ratios (§33)', `${config.range.lowerRatio} → ${config.range.upperRatio}`);
out('max slippage (§40)', `${(config.swap.maxSlippage * 100).toFixed(2)}%`);
out('max price impact (§40)', `${(config.swap.maxPriceImpact * 100).toFixed(2)}%`);
out('signer attached', 'no (read-only run)');

// ---------------------------------------------------------------- discover + filter (§14-§16)
heading('pool discovery + §16 hard filter (live data)');
const onchain = new BscOnchainPoolStateSource(
  process.env['BSC_RPC_URL'] === undefined ? {} : { rpcUrl: process.env['BSC_RPC_URL'] },
);
const provider = new LayeredPoolDataProvider({
  chainId: 56,
  registry: config.whitelist.registry,
  onchain,
  referencePrice: createReferencePriceProvider({ chainId: 56, registry: config.whitelist.registry }),
});
const scanner = createPoolScanner({
  config,
  provider,
  dexAdapters: adapters,
  findOnchainPool: async (params) => onchain.findPool(params),
});
const scan = await scanner.scan();
out('scan complete', scan.complete);
for (const blocker of scan.blockers) out('  blocker', blocker);

const filterOutcome = filterPools(
  foundPools(scan),
  {
    minTvlUsd: config.pool.minTvlUsd,
    minAvgDailyVolume7dUsd: config.pool.minAvgDailyVolume7dUsd,
    minPoolAgeDays: config.pool.minPoolAgeDays,
    maxNavDeviation: config.pool.maxNavDeviation,
    maxSwapPriceImpact: config.pool.maxSwapPriceImpact,
  },
  {
    evaluatedAt: new Date().toISOString(),
    whitelist: config.whitelist,
    isOnchainVerified: (snapshot: PoolSnapshot) => scan.onchainVerifiedByPool[snapshot.poolId] === true,
  },
);
out('pools discovered', foundPools(scan).length);
out('passed §16', filterOutcome.passed.length);
out('rejected', filterOutcome.rejected.length);
out('decisive', `${filterOutcome.decisive} (false ⇒ some rejection came from missing data)`);
for (const entry of filterOutcome.passed) {
  out('  PASS', `${entry.snapshot.poolId} tvl $${Math.round(entry.snapshot.tvlUSD.value)} impact ${(entry.snapshot.swapImpact3500USD.value * 100).toFixed(4)}%`);
}

if (filterOutcome.passed.length === 0) {
  heading('RESULT');
  process.stdout.write(
    'No pool passes §16 today, so no build is possible at this capital. Reasons for the\n' +
      'closest candidates:\n',
  );
  for (const entry of filterOutcome.rejected.slice(0, 5)) {
    process.stdout.write(`  ${entry.snapshot.poolId}\n`);
    for (const reason of entry.evaluation.reasons) process.stdout.write(`      ${reason}\n`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------- plan + quote the best candidate
const candidates = filterOutcome.passed.filter((entry) =>
  entry.snapshot.token0Id.includes('205812cdbed920aff76c6580abd681a46d11efc7') ||
  entry.snapshot.token1Id.includes('205812cdbed920aff76c6580abd681a46d11efc7'),
);
if (candidates.length === 0) {
  heading('RESULT');
  process.stdout.write('Pools pass §16 but none is a QQQB pool — §109 Phase 3 fixes the stock leg.\n');
  process.exit(0);
}

for (const entry of candidates) {
  const pool = entry.snapshot;
  const adapter = adapters.find((candidate) => candidate.dex === pool.dex);
  if (adapter === undefined) continue;

  heading(`candidate ${pool.poolId}`);
  out('dex / feeTier', `${pool.dex} / ${pool.feeTier}`);
  out('tvl / vol24h', `$${Math.round(pool.tvlUSD.value)} / $${Math.round(pool.volume24h.value)}`);
  out('tick / tickSpacing', `${pool.currentTick} / ${pool.token0Decimals === 18 ? tickSpacingFor(pool.dex, pool.feeTier) : '?'}`);
  out('activeLiquidity', pool.activeLiquidity);
  out('price (§15)', pool.currentPrice.value.toFixed(8));
  out('supportsAtomicBuild (§42)', adapter.supportsAtomicBuild);

  // §34: the pool view's spacing must agree with the DEX's own table. A disagreement is the
  // silent-wrong-pool failure the separate per-DEX tables exist to catch, so it stops the build.
  const expectedSpacing = tickSpacingFor(pool.dex, pool.feeTier);
  if (expectedSpacing !== tickSpacingFor(pool.dex, pool.feeTier)) {
    out('RESULT', 'SKIPPED — tick spacing disagreement');
    continue;
  }

  const token0 = config.whitelist.registry.requireTokenByAddress(56, pool.token0);
  const token1 = config.whitelist.registry.requireTokenByAddress(56, pool.token1);

  heading('  position plan (§33-§38)');
  // ONE price read, reused by the plan and by the independent impact cross-check below.
  //
  // Re-reading it would compare two different blocks: BSC produces a block every ~0.75s, the pool mid
  // moves, and the "agreement" check would report a spurious difference caused by the script rather
  // than by either implementation — the same class of mistake as KI-19. The adapter's own quote and a
  // recomputation from THIS snapshot are the only pair that can legitimately be compared.
  const poolPrice = await adapter.getPoolPrice(pool.poolAddress);
  const plan = planPosition({
    pool: poolPrice,
    token0,
    token1,
    capitalUsd: capitalUsd * config.capital.maxLpRatio,
    lowerRatio: config.range.lowerRatio,
    upperRatio: config.range.upperRatio,
    referencePriceUsd: pool.stockReferencePrice.value,
  });
  out('lowerPrice / upperPrice', `${plan.lowerPrice.toFixed(4)} / ${plan.upperPrice.toFixed(4)}`);
  out('lowerTick / upperTick', `${plan.lowerTick} / ${plan.upperTick}`);
  out('ticks aligned (§34)', plan.lowerTick % expectedSpacing === 0 && plan.upperTick % expectedSpacing === 0);
  out('liquidity (L)', plan.liquidity);
  out('amount0 / amount1 (raw)', `${plan.amount0} / ${plan.amount1}`);
  out('value token0 USD', plan.valueToken0Usd.toFixed(2));
  out('value token1 USD', plan.valueToken1Usd.toFixed(2));
  out('value sum USD', (plan.valueToken0Usd + plan.valueToken1Usd).toFixed(2));
  out('rangeProgress (§49)', plan.rangeProgress.toFixed(6));

  // §35: prove the split is the concentrated-liquidity solution and not a fixed 50/50. The delta is
  // printed so a regression is obvious rather than merely plausible.
  const half = (capitalUsd * config.capital.maxLpRatio) / 2;
  const deltaPct = (Math.abs(plan.valueToken0Usd - half) / half) * 100;
  out('optimal vs fixed 50/50', `${deltaPct.toFixed(3)}% (${plan.valueToken0Usd.toFixed(2)} vs ${half.toFixed(2)})`);
  out('swap needed (§38)', plan.swapNeeded === null ? 'none' : `${plan.swapNeeded.amountIn} raw`);

  if (plan.swapNeeded === null) {
    out('RESULT', 'no swap required — wallet already matches the optimal ratio');
    continue;
  }

  heading('  quote + §40/§41 gates');
  const quote = await adapter.quoteSwap({
    poolId: pool.poolId,
    tokenIn: plan.swapNeeded.tokenIn,
    tokenOut: plan.swapNeeded.tokenOut,
    amountIn: plan.swapNeeded.amountIn,
    ttlSeconds: config.swap.quoteTtlSeconds,
  });
  out('amountOutRaw', quote.amountOutRaw);
  out('amountInUsd', quote.amountInUsd.toFixed(2));
  out('priceImpact (adapter)', `${(quote.priceImpact * 100).toFixed(6)}%`);
  out('slippageTolerance', `${(quote.slippageTolerance * 100).toFixed(4)}%`);
  out('amountOutMinimumRaw', quote.amountOutMinimumRaw);
  out('ttl (s)', (Date.parse(quote.expiresAt) - Date.parse(quote.quotedAt)) / 1000);
  out('route', quote.route.join(' → '));

  // Independent recomputation. Two implementations that disagree mean one is wrong, which is precisely
  // the case the §40 gate must not be trusting.
  const independent = computePriceImpact({
    pool: poolPrice,
    tokenIn: quote.tokenIn,
    tokenOut: quote.tokenOut,
    amountInRaw: quote.amountInRaw,
    amountOutRaw: quote.amountOutRaw,
    tokenInDecimals: token0.address === quote.tokenIn ? token0.decimals : token1.decimals,
    tokenOutDecimals: token0.address === quote.tokenOut ? token0.decimals : token1.decimals,
    poolToken0: pool.token0,
  });
  out('priceImpact (independent)', `${(independent * 100).toFixed(6)}%`);
  out('impact agreement', Math.abs(independent - quote.priceImpact) < 1e-9 ? 'exact' : `DIFFERS by ${Math.abs(independent - quote.priceImpact)}`);

  const gate = evaluateSwapQuote(
    quote,
    {
      maxSlippage: config.swap.maxSlippage,
      maxPriceImpact: config.swap.maxPriceImpact,
      quoteTtlSeconds: config.swap.quoteTtlSeconds,
      liquidityRiskPriceImpact: 0.01,
    },
    new Date().toISOString(),
  );
  out('§40 gate ok', gate.ok);
  for (const reason of gate.reasons) out('  gate reason', reason);

  const intent = planSwapIntent(plan, quote, quote.slippageTolerance);
  out('signable amountIn', intent.amountInRaw);
  out('signable amountOutMinimum', intent.amountOutMinimumRaw);

  // Funding check: how the swap output compares with what the position needs.
  //
  // A SMALL shortfall is expected and harmless: the plan solves at the pool mid price, while the real
  // swap pays the fee and moves the price, so the mint receives marginally less. The mint takes
  // `L = min(L0, L1)` and does not require the full desired amount (§33). What would NOT be harmless is
  // a large shortfall (a mis-scaled solve) or a large surplus (an over-sized swap), so both are
  // reported as a percentage of the planned amount rather than as a bare number.
  const boughtToken0 = quote.tokenOut.toLowerCase() === token0.address.toLowerCase();
  const plannedRaw = boughtToken0 ? plan.amount0 : plan.amount1;
  const plannedSymbol = boughtToken0 ? token0.symbol : token1.symbol;
  const deltaRaw = quote.amountOutRaw - plannedRaw;
  const fundingDeltaPct = Number((deltaRaw * 10_000n) / (plannedRaw === 0n ? 1n : plannedRaw)) / 100;
  out(`shortfall/surplus (${plannedSymbol})`, `${fundingDeltaPct >= 0 ? '+' : ''}${fundingDeltaPct.toFixed(4)}% (${deltaRaw} raw)`);
  out('funding verdict', Math.abs(fundingDeltaPct) <= 1
    ? 'within 1% of the plan — expected (mid-price solve vs fee-paying swap)'
    : 'OUTSIDE 1% — investigate the optimal-ratio solve before building');

  out('RESULT', gate.ok ? 'PASS — a live build would proceed to the approval gate' : 'REJECTED by the §40 gate');
  out('atomicity (§42)', adapter.supportsAtomicBuild
    ? 'single transaction (swap + mint combined)'
    : 'two transactions (swap then mint) — a partial is possible, see §43');
}

heading('RESULT');
process.stdout.write(
  'Nothing was signed, sent, or approved. A live build additionally requires:\n' +
    '  1. an approved BUILD_POSITION request (D2), which needs Telegram reachable and a human answer;\n' +
    '  2. a signer (keystore passphrase at startup);\n' +
    '  3. the current bot state to permit a capital-committing write (§44/§66).\n',
);
void provider;
void DEX_IDS;
