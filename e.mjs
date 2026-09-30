// Same as before, but drive the PORTFOLIO beat too so /nav /risk /status fill in — and stub the notifier
// to auto-approve so the build chain reaches the executor (DRY_RUN still refuses the broadcast).
import { loadConfig } from './src/config/index.ts';
import { buildRuntime, buildCadences } from './src/runtime.ts';
import { BscOnchainPoolStateSource } from './src/data/bscOnchainSource.ts';
import { LayeredPoolDataProvider } from './src/data/poolDataProvider.ts';
import { createReferencePriceProvider } from './src/data/referencePrice.ts';
import { createQueryHandlers } from './src/runtime/queryHandlers.ts';
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
  env: { ...process.env, LP_DB_PATH: '/tmp/e2e2.db', DRY_RUN: '1', STRATEGY_WALLET_ADDRESS: account.address } });

const cadences = buildCadences(rt);
const at = new Date().toISOString();
console.log('=== pool-scan ==='); await cadences.find(c=>c.name==='pool-scan').run(at);
console.log('=== portfolio-monitor ==='); await cadences.find(c=>c.name==='portfolio-monitor').run(at);

const qh = createQueryHandlers({ cache: rt.queryCache });
console.log('\n--- /status ---\n' + (await qh.status('')).split('\n').slice(0,4).join('\n'));
console.log('\n--- /nav ---\n' + (await qh.nav('')).split('\n').slice(0,6).join('\n'));
console.log('\n--- /risk ---\n' + (await qh.risk('')).split('\n').slice(0,3).join('\n'));
console.log('\n--- /position ---\n' + (await qh.position('')).split('\n').slice(0,2).join('\n'));
console.log('\n--- /pools ---\n' + (await qh.pools('')).split('\n').slice(0,6).join('\n'));

console.log('\n=== 建仓链（真实候选，到达审批门）===');
const built = await rt.openPositionFromLatestScan({ affordableUsd: 10_000 });
console.log('ok      :', built.ok);
console.log('message :', built.message.slice(0, 200));
