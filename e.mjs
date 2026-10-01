// Full runtime, real /start, capture the button, click it, see what happens.
import { loadConfig } from './src/config/index.ts';
import { buildRuntime } from './src/runtime.ts';
import { BscOnchainPoolStateSource } from './src/data/bscOnchainSource.ts';
import { LayeredPoolDataProvider } from './src/data/poolDataProvider.ts';
import { createReferencePriceProvider } from './src/data/referencePrice.ts';
import { privateKeyToAccount } from 'viem/accounts';

const config = await loadConfig();
const chainId = 56;
const provider = new LayeredPoolDataProvider({ chainId, registry: config.whitelist.registry,
  onchain: new BscOnchainPoolStateSource({}), referencePrice: createReferencePriceProvider({ chainId, registry: config.whitelist.registry }) });
const key = '0x' + '44'.repeat(32);
const account = privateKeyToAccount(key);

const sent = [];
const rt = buildRuntime({ config, provider,
  signer: { privateKey: { privateKeyHex: key, address: account.address }, account },
  env: { ...process.env, LP_DB_PATH: '/tmp/e2e.db', DRY_RUN: '1',
         STRATEGY_WALLET_ADDRESS: account.address,
         TELEGRAM_BOT_TOKEN: '123456:TEST-TOKEN-NOT-REAL', TELEGRAM_CHAT_ID: '42',
         TELEGRAM_ALLOWED_USER_IDS: '7', TELEGRAM_ENABLED: 'true' } });

// Replace only the HTTP boundary so the notifier's own state (pending map) stays real.
rt.notifier.call = async (method, body) => {
  sent.push({ method, body });
  return { message_id: sent.length };
};

// 1) Run a real scan first, so candidates exist.
const summary = await rt.scanner.scan();
rt.rememberScannedPools(summary.pools);
console.log('候选池:', summary.pools.length);

// 2) Send /start as a real Telegram message.
await rt.notifier.handleUpdate({
  update_id: 1,
  message: { message_id: 5, chat: { id: 42, type: 'private' }, from: { id: 7, is_bot: false }, text: '/start', date: 1 },
});
await new Promise(r => setTimeout(r, 3000));

console.log('=== 发出的消息 ===');
for (const m of sent) console.log(` [${m.method}]`, String(m.body?.text ?? '').split('\n').slice(0,3).join(' / '));

// 3) Find the button and click it.
const prompt = sent.find(m => m.body?.reply_markup?.inline_keyboard);
if (prompt === undefined) { console.log('\n没有发出带按钮的审批消息 → 说明没走到确认门'); process.exit(0); }
const btn = prompt.body.reply_markup.inline_keyboard[0][0].callback_data;
console.log('\n按钮 callback_data :', btn);

await rt.notifier.handleUpdate({
  update_id: 2,
  callback_query: { id: 'cb1', from: { id: 7, is_bot: false }, data: btn,
    message: { message_id: 1, chat: { id: 42, type: 'private' } } },
});
await new Promise(r => setTimeout(r, 2000));

console.log('\n=== 点击后发出的消息 ===');
for (const m of sent.slice(-3)) console.log(` [${m.method}]`, String(m.body?.text ?? '').slice(0, 120));
