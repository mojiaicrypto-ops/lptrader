import { loadConfig } from '../src/config/index.ts';
const c = await loadConfig({ useBuiltinsOnly: true });
console.log(JSON.stringify(c.pool));
console.log(JSON.stringify(c.whitelist.chains), JSON.stringify(c.whitelist.dexes));
console.log(JSON.stringify(c.whitelist.registry.listStockTokens({autoTradeOnly:true}).map(t=>t.symbol)));
console.log(JSON.stringify(c.whitelist.registry.listStablecoins().map(t=>t.symbol)));
