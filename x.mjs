// /exit -> automatic rebuild, THROUGH THE RUNTIME.
import { loadConfig } from './src/config/index.ts';
import { buildRuntime } from './src/runtime.ts';
import { BscOnchainPoolStateSource } from './src/data/bscOnchainSource.ts';
import { LayeredPoolDataProvider } from './src/data/poolDataProvider.ts';
import { createReferencePriceProvider } from './src/data/referencePrice.ts';
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
  env: { ...process.env, LP_DB_PATH: '/tmp/exit.db', DRY_RUN: '1', STRATEGY_WALLET_ADDRESS: account.address } });

const summary = await rt.scanner.scan();
rt.rememberScannedPools(summary.pools);
console.log('candidates:', summary.pools.length);

const pool = summary.pools[0];
const amt = (addr, id) => ({ tokenId: id, address: addr, decimals: 18, raw: 0n, ui: 0n, uiMultiplier: 10n ** 18n });
rt.stateStore.insertPosition({
  id: '4242', chainId,
  dex: pool.dex, poolAddress: pool.poolAddress, poolId: pool.poolId,
  token0: pool.token0, token1: pool.token1,
  token0Id: pool.token0Id, token1Id: pool.token1Id,
  openedAt: new Date().toISOString(),
  initialNAV: 10_000, entryPrice: pool.currentPrice.value,
  lowerPrice: pool.currentPrice.value * 0.85, upperPrice: pool.currentPrice.value * 1.16,
  lowerTick: -100, upperTick: 100,
  initialToken0: amt(pool.token0, pool.token0Id),
  initialToken1: amt(pool.token1, pool.token1Id),
  liquidity: 1_768_671_767_819_460_977_256n,
  status: 'MONITOR',
  totalFeesUSD: 0, realizedPnL: 0, unrealizedPnL: 0, benchmarkValue: 0, feeILRatio: null,
});
console.log('position planted:', rt.stateStore.openPosition(chainId)?.poolId);

console.log('\n=== 发 /exit ===');
const out = await rt.actionHandlers.exit();
console.log('ok        :', out.ok);
console.log('nextState :', out.nextState);
console.log('message   :', out.message.slice(0, 280));
