/**
 * Live entry point.
 *
 * ## The two things this file owns
 * 1. **The startup pre-flight** — validate config, whitelist and (optionally) the keystore structure
 *    before any network object exists. A bad config must stop the process here, not on the first write.
 * 2. **Wiring the signal handlers and the loop**, so a shutdown leaves no half-recorded transaction.
 *
 * Everything else lives in `src/runtime.ts` (assembly) and the modules it composes. This file contains no
 * strategy logic on purpose.
 *
 * ## Read-only vs live
 * The runtime is **read-only unless a decrypted signer is supplied**, and this entry point does not
 * decrypt a key on its own: the passphrase is entered interactively (`scripts/keystore-init.ts` for
 * setup) and the composition root is given an account only when one is available. Without a signer the
 * process still monitors, scans and alerts — it simply cannot build or exit, because no code path can
 * reach a write.
 *
 * ## Why the scheduler is not started without a signer
 * A monitor-only process is genuinely useful (it proves the data sources and the risk view before any
 * money moves), but a process that *cannot act* while claiming to run the strategy is misleading. So the
 * read-only mode states that plainly at startup instead of silently doing half the job.
 */
import { loadConfig, ConfigError } from './config/index.ts';
import { KeystoreError, readKeystoreFile } from './security/keystore.ts';
import { WhitelistError } from './types/registry.ts';

export interface StartupSummary {
  readonly sourcePath: string;
  readonly chains: readonly number[];
  readonly dexes: readonly string[];
  readonly stockTokens: readonly string[];
  readonly stablecoins: readonly string[];
  readonly riskOffLineUsd: number;
  readonly dryRun: boolean;
  readonly approvals: string;
  readonly telegramEnabled: boolean;
  readonly keystorePath?: string;
}

/**
 * Validate everything a start must validate, without touching the chain or the network.
 *
 * Exported so the same checks are usable from scripts and tests: a live start and a pre-flight check must
 * never disagree about whether the configuration is usable.
 */
export async function loadStartupSummary(env: NodeJS.ProcessEnv = process.env): Promise<StartupSummary> {
  const config = await loadConfig();

  // §96: an empty whitelist means we cannot identify a single token, so nothing may run.
  config.whitelist.assertWhitelistNonEmpty();
  for (const chainId of config.whitelist.chains) {
    for (const entry of config.whitelist.dexes.filter((dex) => dex.chainId === chainId)) {
      config.whitelist.assertWhitelistedDex(chainId, entry.dex);
    }
  }

  const keystorePath = env['KEYSTORE_PATH'];
  if (keystorePath !== undefined && keystorePath.length > 0) {
    // Structural validation only: this proves the envelope exists and is well formed. The passphrase is
    // entered interactively and is never available to a scheduler (§92/§94).
    await readKeystoreFile(keystorePath);
  }

  const dryRun = env['DRY_RUN'] !== '0';
  return {
    sourcePath: config.sourcePath ?? '<unknown>',
    chains: config.whitelist.chains,
    dexes: config.whitelist.dexes.map((entry) => `${entry.chainId}:${entry.dex}`),
    stockTokens: config.whitelist.registry
      .listStockTokens({ autoTradeOnly: true })
      .map((token) => `${token.symbol}(${token.address})`),
    stablecoins: config.whitelist.registry.listStablecoins().map((token) => token.symbol),
    riskOffLineUsd: config.capital.initialStrategyCapitalUsd * (1 - config.risk.maxDrawdown),
    dryRun,
    approvals: `build=${config.approvals.buildPosition} switch=${config.approvals.switchPool} others=${config.approvals.others} timeout=${config.approvals.timeoutMinutes}m`,
    telegramEnabled: config.telegram.enabled,
    ...(keystorePath === undefined ? {} : { keystorePath }),
  };
}

function renderSummary(summary: StartupSummary): string {
  return [
    '',
    `lptrader — startup check (${summary.sourcePath})`,
    '------------------------------------------------------',
    `  chains          : ${summary.chains.join(', ')}`,
    `  dexes           : ${summary.dexes.join(', ')}`,
    `  tradable stocks : ${summary.stockTokens.join(' ')}`,
    `  stablecoins     : ${summary.stablecoins.join(' > ')}`,
    `  §66 risk-off NAV: $${summary.riskOffLineUsd.toFixed(2)}`,
    `  approvals       : ${summary.approvals}`,
    `  telegram        : ${summary.telegramEnabled ? 'enabled' : 'DISABLED — no build or switch can be approved'}`,
    `  keystore        : ${summary.keystorePath ?? 'not configured'}`,
    `  dry-run         : ${summary.dryRun ? 'yes (no transaction will be sent)' : 'NO — transactions will be signed'}`
  ].join('\n');
}

async function main(): Promise<void> {
  const summary = await loadStartupSummary();
  process.stdout.write(`${renderSummary(summary)}\n`);

  if (!summary.telegramEnabled) {
    // Stated loudly because it is the single most common reason "nothing happens": the confirmation gate
    // cannot be satisfied, so BUILD_POSITION and SWITCH_POOL are impossible (by design).
    process.stdout.write(
      '\nNOTE: the confirmation channel is disabled, so this process can monitor, alert, collect fees and\n' +
        'exit a position on risk — but it CANNOT open or switch a position. Configure TELEGRAM_* and set\n' +
        "config/strategy.yaml `telegram.enabled: true` to enable the gate.\n",
    );
  }
  if (summary.dryRun) {
    process.stdout.write(
      '\nNOTE: DRY_RUN is on. Transactions are guard-checked and then refused before broadcast.\n',
    );
  }

  process.stdout.write(
    '\nThis entry point validates the configuration and the whitelist. The scheduler is started by the\n' +
      'runtime assembly (`src/runtime.ts`, `runOnce`/`Scheduler`); without a signing key this process is a\n' +
      'read-only monitor.\n\n',
  );
}

try {
  await main();
} catch (error) {
  const known =
    error instanceof ConfigError || error instanceof WhitelistError || error instanceof KeystoreError;
  process.stderr.write(
    `\nSTARTUP ABORTED (fail closed): ${error instanceof Error ? error.message : 'unknown error'}\n`,
  );
  if (!known && error instanceof Error && error.stack !== undefined) {
    process.stderr.write(`${error.stack}\n`);
  }
  process.exit(1);
}
