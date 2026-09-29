/**
 * Read-only Telegram channel self-check.
 *
 *   npm run telegram:check
 *
 * With `TELEGRAM_BOT_TOKEN` set it calls `getMe` through `TelegramNotifier.verifyChannel()` — it
 * validates the token and reports the bot identity. **Nothing is sent, posted or approved**, and no
 * polling loop is started (so no update is consumed). It exits non-zero when the channel is
 * unusable, which makes it usable as a pre-flight gate.
 *
 * Without a token (the default state of this repository) it verifies the fail-closed wiring instead:
 * it builds the notifier for the loaded config and asserts that no approval can be granted.
 */
import { loadConfig } from '../src/config/index.ts';
import {
  TelegramApiError,
  TelegramNotifier,
  createNotifierFromConfig,
  telegramEnvConfigFrom,
} from '../src/notify/telegram.ts';
import { APPROVAL_KINDS, noopNotifier } from '../src/types/notifier.ts';

async function main(): Promise<void> {
  const config = await loadConfig();
  const transport = telegramEnvConfigFrom(process.env);

  if (transport === null) {
    const notifier = createNotifierFromConfig(config, process.env);
    const decision = await notifier.requestApproval({
      id: 'self-check',
      kind: APPROVAL_KINDS.BUILD_POSITION,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      payloadSummary: 'self-check',
      payloadJson: {},
      status: 'pending',
    });
    process.stdout.write(
      [
        '',
        'Telegram channel self-check (read-only)',
        '--------------------------------------',
        '  token         : not set',
        `  notifier      : ${notifier === noopNotifier ? 'noopNotifier (contract fail-closed)' : 'TelegramNotifier'}`,
        `  approval probe: approved=${String(decision.approved)} (expected false)`,
        '  conclusion    : BUILD_POSITION and SWITCH_POOL are blocked (fail closed).',
        '',
        'Set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID + TELEGRAM_ALLOWED_USER_IDS in .env to enable the channel.',
        '',
      ].join('\n'),
    );
    if (decision.approved) {
      process.stderr.write('SELF-CHECK FAILED: an unconfigured channel granted an approval.\n');
      process.exit(1);
    }
    return;
  }

  const notifier = new TelegramNotifier({
    botToken: transport.botToken,
    chatId: transport.chatId,
    allowedUserIds: transport.allowedUserIds,
    ...(transport.apiBaseUrl === undefined ? {} : { apiBaseUrl: transport.apiBaseUrl }),
  });
  const bot = await notifier.verifyChannel();
  process.stdout.write(
    [
      '',
      'Telegram channel self-check (read-only)',
      '--------------------------------------',
      `  bot           : @${bot.username ?? '<no username>'} (id ${String(bot.id)})`,
      `  chat id       : ${transport.chatId}`,
      `  allowed users : ${transport.allowedUserIds.join(', ') || '<none — nobody may approve>'}`,
      '  nothing was sent or approved.',
      '',
    ].join('\n'),
  );
}

try {
  await main();
} catch (error) {
  // Never print the token-bearing URL: `TelegramApiError` already carries only the method + status.
  const message = error instanceof TelegramApiError ? error.message : 'unexpected failure';
  process.stderr.write(`\nTELEGRAM SELF-CHECK FAILED (fail closed): ${message}\n`);
  process.exit(1);
}
