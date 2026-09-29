/**
 * Phase A entry point: load and validate the configuration, prove the whitelist is usable, and
 * report the resolved risk parameters. Read-only — this program cannot and does not send a
 * transaction.
 *
 * This is the `npm run dev` entry for the skeleton phase. The scheduler/service assembly (T12)
 * replaces the body of `main()` once the adapters, planner and executor exist; the configurability
 * checks below stay, because a live start must fail loudly on a bad config long before any wire is
 * touched (fail closed, §96).
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
 * Validate everything that a live start must validate, without touching the chain or the network.
 * Returns a plain summary so the checks are also usable from scripts and tests.
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
    // Structural validation only: reading the envelope proves the file exists and is well formed.
    // The passphrase is entered interactively and is not available to the scheduler (§92/§94).
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
    riskOffLineUsd:
      config.capital.initialStrategyCapitalUsd * (1 - config.risk.maxDrawdown),
    dryRun,
    approvals: `build=${config.approvals.buildPosition} switch=${config.approvals.switchPool} others=${config.approvals.others} timeout=${config.approvals.timeoutMinutes}m`,
    telegramEnabled: config.telegram.enabled,
    ...(keystorePath === undefined ? {} : { keystorePath }),
  };
}

async function main(): Promise<void> {
  const summary = await loadStartupSummary();
  process.stdout.write(
    [
      '',
      `lptrader — configuration check (${summary.sourcePath})`,
      '------------------------------------------------------',
      `  chains          : ${summary.chains.join(', ')}`,
      `  dexes           : ${summary.dexes.join(', ')}`,
      `  tradable stocks : ${summary.stockTokens.join(' ')}`,
      `  stablecoins     : ${summary.stablecoins.join(' > ')}`,
      `  §66 risk-off NAV: $${summary.riskOffLineUsd.toFixed(2)}`,
      `  approvals       : ${summary.approvals}`,
      `  telegram        : ${summary.telegramEnabled ? 'enabled' : 'disabled (no approval can be granted)'}`,
      `  keystore        : ${summary.keystorePath ?? 'not configured'}`,
      `  dry-run         : ${summary.dryRun ? 'yes (no transaction will be sent)' : 'NO'}`,
      '',
      // The service graph is assembled in T12; until then a start must be explicit about it.
      'Execution services are not assembled in this build: no chain access, no scheduler.',
      'This entry point only validates configuration and the whitelist.',
      '',
    ].join('\n'),
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
