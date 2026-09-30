// END-TO-END: scan real pools → seed the runtime → drive the build chain to a constructed transaction.
// DRY_RUN on, throwaway key: nothing is signed or broadcast.
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
  env: { ...process.env, LP_DB_PATH: '/tmp/full-check.db', DRY_RUN: '1', STRATEGY_WALLET_ADDRESS: account.address } });

console.log('=== 1. 真实扫描 ===');
const summary = await rt.scanner.scan();
const pools = summary.pools;
console.log('discovered:', pools.length);
rt.rememberScannedPools(pools);

console.log('\n=== 2. 经运行时的建仓链（这是关键：不再绕过 runtime）===');
const built = await rt.openPositionFromLatestScan({ affordableUsd: 10_000 });
console.log('ok      :', built.ok);
console.log('message :', built.message.slice(0, 400));

console.log('\n=== 3. /start 走同一路径 ===');
const started = await rt.actionHandlers.start();
console.log('ok        :', started.ok);
console.log('nextState :', started.nextState);
console.log('message   :', started.message.slice(0, 300));
