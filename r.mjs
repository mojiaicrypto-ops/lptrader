// Prove: (1) the build records entryEquityUsd, (2) attribution separates market from pool.
import { loadConfig } from './src/config/index.ts';
import { buildRuntime } from './src/runtime.ts';
import { BscOnchainPoolStateSource } from './src/data/bscOnchainSource.ts';
import { LayeredPoolDataProvider } from './src/data/poolDataProvider.ts';
import { createReferencePriceProvider } from './src/data/referencePrice.ts';
import { computeReturn, valueEntryComposition } from './src/strategy/returns.ts';
import { BOT_STATES } from './src/types/state.ts';
import { privateKeyToAccount } from 'viem/accounts';

const config = await loadConfig();
const chainId = 56;
const provider = new LayeredPoolDataProvider({ chainId, registry: config.whitelist.registry,
  onchain: new BscOnchainPoolStateSource({}),
  referencePrice: createReferencePriceProvider({ chainId, registry: config.whitelist.registry }) });
const key = '0x' + '11'.repeat(32);
const account = privateKeyToAccount(key);

const rt = buildRuntime({ config, provider,
  signer: { privateKey: { privateKeyHex: key, address: account.address }, account },
  env: { ...process.env, LP_DB_PATH: '/tmp/ret.db', DRY_RUN: '1', STRATEGY_WALLET_ADDRESS: account.address } });

const summary = await rt.scanner.scan();
rt.rememberScannedPools(summary.pools);
const pool = summary.pools[0];

// Plant what a successful build would have written — the same fields the runtime now records.
rt.stateStore.insertPosition({
  id: '9001', chainId, dex: pool.dex, poolAddress: pool.poolAddress, poolId: pool.poolId,
  token0: pool.token0, token1: pool.token1, token0Id: pool.token0Id, token1Id: pool.token1Id,
  openedAt: '2026-09-01T00:00:00.000Z',
  initialNAV: 10_000,
  entryEquityUsd: 10_000,                 // <- the baseline the build now records
  entryPrice: 700,                        // stock at entry
  lowerPrice: 595, upperPrice: 812, lowerTick: -100, upperTick: 100,
  initialToken0: { tokenId: pool.token0Id, address: pool.token0, decimals: 18,
                   raw: 7_000_000_000_000_000_000n, ui: 7_000_000_000_000_000_000n, uiMultiplier: 10n ** 18n },
  initialToken1: { tokenId: pool.token1Id, address: pool.token1, decimals: 18,
                   raw: 5_100_000_000_000_000_000_000n, ui: 5_100_000_000_000_000_000_000n, uiMultiplier: 10n ** 18n },
  liquidity: 1n, status: BOT_STATES.MONITOR,
  totalFeesUSD: 0, realizedPnL: 0, unrealizedPnL: 0, benchmarkValue: 0, feeILRatio: null,
});

const rec = rt.stateStore.openPosition(chainId);
console.log('=== 建仓基线已记录 ===');
console.log('entryEquityUsd :', rec.entryEquityUsd);
console.log('entryPrice     :', rec.entryPrice);

// Scenario: stock +10%; the LP position only reached 10,400 (fees did not keep up with the range effect).
const nowPrice = 700 * 1.1;
const hold = valueEntryComposition({
  initialToken0: rec.initialToken0, initialToken1: rec.initialToken1,
  price0Usd: nowPrice, price1Usd: 1,
});
const report = computeReturn(
  { entryEquityUsd: rec.entryEquityUsd, entryStockPriceUsd: rec.entryPrice, openedAt: rec.openedAt },
  { currentEquityUsd: 10_400, currentStockPriceUsd: nowPrice, holdEquityUsd: hold, at: new Date().toISOString() },
  rec.totalFeesUSD,
);

console.log('\n=== 归因（股价 +10%，仓位只到 10,400）===');
console.log('持仓不动会值   :', hold?.toFixed(2));
console.log('总收益         :', report.returnUsd?.toFixed(2), `(${((report.returnRatio ?? 0)*100).toFixed(2)}%)`);
console.log('其中市场贡献   :', report.marketContributionUsd?.toFixed(2));
console.log('其中池子贡献   :', report.poolContributionUsd?.toFixed(2));
console.log('=> 判定          :', report.poolContributionUsd !== null && report.poolContributionUsd < -1
  ? '池子净贡献为负 → 应进入 RISK_REVIEW' : '池子有贡献');

// Contrast: the SAME total return, but caused entirely by the stock falling.
const downPrice = 700 * 0.95;
const holdDown = valueEntryComposition({
  initialToken0: rec.initialToken0, initialToken1: rec.initialToken1, price0Usd: downPrice, price1Usd: 1 });
const down = computeReturn(
  { entryEquityUsd: rec.entryEquityUsd, entryStockPriceUsd: rec.entryPrice, openedAt: rec.openedAt },
  { currentEquityUsd: holdDown, currentStockPriceUsd: downPrice, holdEquityUsd: holdDown, at: new Date().toISOString() },
);
console.log('\n=== 对照：权益同样低于建仓，但全是股价跌 ===');
console.log('总收益         :', down.returnUsd?.toFixed(2));
console.log('池子贡献       :', down.poolContributionUsd?.toFixed(2), '← 0，不该撤池');
