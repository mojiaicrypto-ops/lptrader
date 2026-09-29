/**
 * T6 read-only smoke test: a REAL pool scan + §16 filter against live BNB Chain.
 *
 * It wires the three layers the acceptance criteria name — GeckoTerminal + DexPaprika over HTTP
 * and BSC RPC for `fee`/`tick`/`liquidity`/swap-impact — runs the §14 scanner, then runs the §16
 * hard filters through `filterScannedPools` (which carries the scanner's own on-chain verification
 * flags). Nothing here signs or sends anything: the only chain access is `eth_call`.
 *
 * Exit code is non-zero when the scan could not be completed or when a rejection came from missing
 * data rather than from the pool's own merits, because a smoke script that reports success on a
 * failed read is worse than no script at all.
 *
 * Usage:
 *   node --experimental-strip-types --env-file-if-exists=.env scripts/smoke-scan.ts
 *   BSC_RPC_URL=https://... node --experimental-strip-types scripts/smoke-scan.ts
 */
import { loadConfig } from '../src/config/index.ts';
import { KNOWN_BSC_POOLS } from '../src/config/builtins.ts';
import { BscOnchainPoolStateSource } from '../src/data/bscOnchainSource.ts';
import { createReferencePriceProvider } from '../src/data/referencePrice.ts';
import { LayeredPoolDataProvider } from '../src/data/poolDataProvider.ts';
import {
  createPoolScanner,
  describeAbsences,
  describeUnverified,
  filterScannedPools,
  type PoolScanSummary,
} from '../src/data/poolScanner.ts';
import { describeThresholds, type FilteredPool } from '../src/data/poolFilter.ts';
import type { PoolSnapshot, Sourced } from '../src/types/market.ts';
import type { StrategyConfig } from '../src/types/config.ts';

function section(title: string): void {
  process.stdout.write(`\n${title}\n${'-'.repeat(Math.max(title.length, 20))}\n`);
}

function line(label: string, value: string): void {
  process.stdout.write(`  ${label.padEnd(24, ' ')} ${value}\n`);
}

/** One `Sourced<number>` as `value (source[!stale])` so provenance is visible in the log. */
function money(field: Sourced<number>): string {
  if (field.source === 'unavailable') return `unavailable (!)`;
  const value = `$${field.value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  return `${value} [${field.source}${field.stale ? ', STALE' : ''}]`;
}

function ratio(field: Sourced<number | null>): string {
  if (field.value === null || field.source === 'unavailable') {
    return `unavailable [${field.source}${field.stale ? ', stale' : ''}]`;
  }
  return `${(field.value * 100).toFixed(4)}% [${field.source}]`;
}

function plain(field: Sourced<number>): string {
  if (field.source === 'unavailable') return 'unavailable (!)';
  return `${field.value.toLocaleString('en-US', { maximumFractionDigits: 2 })} [${field.source}]`;
}

function reportPool(
  pool: PoolSnapshot,
  verdict: FilteredPool | null,
  options: { readonly onchainVerified: boolean },
): void {
  process.stdout.write(`\n  ${pool.poolId}\n`);
  line('dex / feeTier', `${pool.dex} / ${pool.feeTier}`);
  const token0 = pool.token0Id.split(':')[1] ?? pool.token0;
  const token1 = pool.token1Id.split(':')[1] ?? pool.token1;
  line('legs', `${token0} / ${token1} (${pool.token0.slice(0, 10)}…/${pool.token1.slice(0, 10)}…)`);
  line('tvlUSD', money(pool.tvlUSD));
  line('volume24h', money(pool.volume24h));
  line('volume7d', money(pool.volume7d));
  line('fees24h (derived)', money(pool.fees24h));
  line('fees7d (derived)', money(pool.fees7d));
  line('poolAgeDays', Number.isFinite(pool.poolAgeDays) ? `${pool.poolAgeDays.toFixed(3)}d` : 'unavailable (!)');
  line('tokenNAVDeviation', ratio(pool.tokenNAVDeviation));
  line('swapImpact3500USD', ratio(pool.swapImpact3500USD));
  // RPC-only truth: no free HTTP API exposes these (research §4.4).
  line(
    'currentTick / activeLiquidity',
    `${pool.currentTick} / ${pool.activeLiquidity.toString()}${options.onchainVerified ? '' : '  (UNVERIFIED — RPC read failed)'}`,
  );
  line('sqrtPriceX96', pool.sqrtPriceX96.toString());
  line('estimatedAPR7d', pool.estimatedAPR7d.value === null ? 'unavailable' : plain(pool.estimatedAPR7d as Sourced<number>));
  if (verdict === null) {
    line('§16 filter', 'not evaluated');
    return;
  }
  line('§16 filter', verdict.evaluation.passed ? 'PASS' : 'REJECT');
  for (const reason of verdict.evaluation.reasons) {
    process.stdout.write(`      ${reason}\n`);
  }
  if (!verdict.evaluation.complete) {
    process.stdout.write('      (rejection involved unreadable data — a data problem, not a pool problem)\n');
  }
}

function sanityCheck(
  pools: readonly PoolSnapshot[],
  config: StrategyConfig,
): readonly string[] {
  const registry = config.whitelist.registry;
  const addressBySymbol = new Map(registry.list().map((token) => [token.symbol.toUpperCase(), token.address]));
  const stablecoinLegs = new Set(registry.listStablecoins().map((token) => token.address));
  const autoTradeStockLegs = new Set(
    registry.listStockTokens({ autoTradeOnly: true }).map((token) => token.address),
  );

  const notes: string[] = [];
  for (const known of KNOWN_BSC_POOLS) {
    const discovered = pools.find(
      (pool) => pool.poolAddress.toLowerCase() === known.poolAddress.toLowerCase(),
    );
    if (discovered !== undefined) {
      notes.push(
        `OK    ${known.tokens.join('/')} @ ${known.dex}: feeTier ${discovered.feeTier} (research: ${known.feeTier}), ` +
          `tvl $${discovered.tvlUSD.value.toLocaleString('en-US', { maximumFractionDigits: 2 })} (research: ${known.note})`,
      );
      continue;
    }
    // A miss is only a surprise when the pool is inside the §14 cross set. A pool whose second leg
    // is WBNB is excluded by design — §14 scans stock × STABLECOIN, and WBNB is not a stablecoin.
    const legs = known.tokens.map((symbol) => addressBySymbol.get(symbol.toUpperCase()) ?? null);
    const inCrossSet =
      legs.some((address) => address !== null && stablecoinLegs.has(address)) &&
      legs.some((address) => address !== null && autoTradeStockLegs.has(address));
    notes.push(
      inCrossSet
        ? `MISS  ${known.tokens.join('/')} @ ${known.dex} fee ${known.feeTier} (${known.poolAddress}) — inside the §14 cross set but not discovered; expected ${known.note}`
        : `SKIP  ${known.tokens.join('/')} @ ${known.dex} fee ${known.feeTier} (${known.poolAddress}) — outside the §14 cross set (a leg is neither a whitelisted stock token nor a whitelisted stablecoin)`,
    );
  }
  return notes;
}

async function main(): Promise<void> {
  const config = await loadConfig();
  config.whitelist.assertWhitelistNonEmpty();

  process.stdout.write('lptrader — pool scan smoke test (T6)\n');
  process.stdout.write('=================================\n');
  line('config', config.sourcePath ?? '<unknown>');
  line('chains', config.whitelist.chains.join(', '));
  line('dexes', config.whitelist.dexes.map((entry) => `${entry.chainId}:${entry.dex}`).join('  '));
  line(
    'stock tokens',
    config.whitelist.registry
      .listStockTokens({ autoTradeOnly: true })
      .map((token) => token.symbol)
      .join(', '),
  );
  line(
    'stablecoins',
    config.whitelist.registry.listStablecoins().map((token) => token.symbol).join(', '),
  );
  line('rpc', process.env['BSC_RPC_URL'] ?? '(default) https://bsc-dataseed.bnbchain.org');
  line('now', new Date().toISOString());

  section('§16 thresholds (from config)');
  for (const threshold of describeThresholds(config.pool)) process.stdout.write(`  ${threshold}\n`);

  const onchain = new BscOnchainPoolStateSource({
    ...(process.env['BSC_RPC_URL'] === undefined ? {} : { rpcUrl: process.env['BSC_RPC_URL'] }),
  });
  const provider = new LayeredPoolDataProvider({
    chainId: 56,
    registry: config.whitelist.registry,
    onchain,
    referencePrice: createReferencePriceProvider(),
  });
  const scanner = createPoolScanner({
    config,
    provider,
    findOnchainPool: async (params) => onchain.findPool(params),
  });

  section('scan');
  const startedAt = Date.now();
  const summary: PoolScanSummary = await scanner.scan();
  line('scanned at', summary.scannedAt);
  line('elapsed', `${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  line('probes', String(summary.probes.length));
  line('pools discovered', String(summary.pools.length));
  line(
    'scheduler',
    `geckoterminal=${provider.stats.geckoterminal.requests} req / ${provider.stats.geckoterminal.rateLimited}×429   ` +
      `dexpaprika=${provider.stats.dexpaprika.requests} req / ${provider.stats.dexpaprika.rateLimited}×429`,
  );
  line('complete', String(summary.complete));

  if (summary.pools.length > 0) {
    section('candidate pools + §16 verdict');
    const outcome = filterScannedPools(summary, config.pool, summary.scannedAt);
    const byId = new Map<string, FilteredPool>();
    for (const entry of [...outcome.passed, ...outcome.rejected]) byId.set(entry.snapshot.poolId, entry);
    for (const pool of summary.pools) {
      reportPool(pool, byId.get(pool.poolId) ?? null, {
        onchainVerified: summary.onchainVerifiedByPool[pool.poolId] === true,
      });
    }
    section('§16 summary');
    line('passed', String(outcome.passed.length));
    line('rejected', String(outcome.rejected.length));
    line('decisive', `${String(outcome.decisive)} (false = a rejection came from missing data)`);
  } else {
    section('candidate pools + §16 verdict');
    process.stdout.write('  no candidate pool was discovered\n');
  }

  section('proven absences (factory answered the zero address)');
  const absences = describeAbsences(summary);
  if (absences.length === 0) process.stdout.write('  none\n');
  for (const entry of absences.slice(0, 20)) process.stdout.write(`  ${entry}\n`);
  if (absences.length > 20) process.stdout.write(`  … ${absences.length - 20} more\n`);

  section('unverifiable probes (these make a scan incomplete)');
  const unverified = describeUnverified(summary);
  if (unverified.length === 0) process.stdout.write('  none\n');
  for (const entry of unverified.slice(0, 20)) process.stdout.write(`  ${entry}\n`);
  if (unverified.length > 20) process.stdout.write(`  … ${unverified.length - 20} more\n`);

  section('source failures');
  if (summary.failures.length === 0) process.stdout.write('  none\n');
  for (const failure of summary.failures) {
    process.stdout.write(`  [${failure.severity}] ${failure.source}/${failure.scope}: ${failure.message}\n`);
  }

  section('sanity check vs research §4.1');
  for (const note of sanityCheck(summary.pools, config)) process.stdout.write(`  ${note}\n`);

  const dataProblems = summary.probes.length > 0 && !summary.complete;
  process.stdout.write(
    `\n${summary.complete ? 'SCAN COMPLETE' : 'SCAN INCOMPLETE'}: ${summary.blockers.length} blocker(s)\n`,
  );
  for (const blocker of summary.blockers.slice(0, 10)) process.stdout.write(`  ${blocker}\n`);
  if (summary.blockers.length > 10) {
    process.stdout.write(`  … ${summary.blockers.length - 10} more\n`);
  }

  // A failed read must never look like a passing run.
  process.exitCode = dataProblems ? 1 : 0;
}

await main();
