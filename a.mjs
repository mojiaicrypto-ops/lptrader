import { loadConfig } from './src/config/index.ts';
import { PoolScanner, foundPools } from './src/data/poolScanner.ts';
import { filterPools } from './src/data/poolFilter.ts';
import { BscOnchainPoolStateSource } from './src/data/bscOnchainSource.ts';
import { LayeredPoolDataProvider } from './src/data/poolDataProvider.ts';
import { createReferencePriceProvider } from './src/data/referencePrice.ts';

const config = await loadConfig();
const chainId = 56;
const provider = new LayeredPoolDataProvider({ chainId, registry: config.whitelist.registry,
  onchain: new BscOnchainPoolStateSource({}),
  referencePrice: createReferencePriceProvider({ chainId, registry: config.whitelist.registry }) });
const summary = await new PoolScanner({ config, provider }).scan();
const outcome = filterPools(foundPools(summary), {
  minTvlUsd: config.pool.minTvlUsd, minAvgDailyVolume7dUsd: config.pool.minAvgDailyVolume7dUsd,
  minPoolAgeDays: config.pool.minPoolAgeDays, maxNavDeviation: config.pool.maxNavDeviation,
  maxSwapPriceImpact: config.pool.maxSwapPriceImpact,
}, { evaluatedAt: new Date().toISOString(), whitelist: config.whitelist, isOnchainVerified: () => false, deferChainOnly: true });

console.log('discovered:', foundPools(summary).length, '| passed:', outcome.passed.length, '| rejected:', outcome.rejected.length);
const undecided = outcome.rejected.filter(e => e.evaluation.failedCodes.length > 0 && e.evaluation.failedCodes.every(c => c.endsWith('_UNAVAILABLE')));
console.log('rejected ONLY for unreadable data:', undecided.length);
for (const u of undecided) console.log('   ', u.snapshot.poolId.slice(-12), u.evaluation.failedCodes.join(','));
console.log('=> alert fires?', undecided.length > 0 ? 'YES' : 'NO (the noise is gone)');
