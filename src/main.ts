/**
 * Live entry point: validate, decrypt, assemble, and **actually run**.
 *
 * ## Why this file was rewritten
 * It used to validate the configuration, print a summary and exit. That was correct while the modules did
 * not exist, and **wrong the moment they did**: `buildRuntime` was only ever called from tests and probe
 * scripts, so `npm run dev` never built a runtime, never started a `Scheduler`, and never opened the
 * database. The system looked assembled and did nothing.
 *
 * The failure mode is worth naming, because every unit test and every `typecheck` passed throughout: the
 * *components* were verified and the *entry point* was not. `AGENTS.md` now requires the opposite — a real
 * end-to-end run of the composition root, not just module-level tests.
 *
 * ## Startup order is the safety property
 * Each step is a precondition for the next, and failure at any step stops the process:
 *
 * ```text
 * 1. config + whitelist      → an empty whitelist or a non-whitelisted DEX stops here (§96)
 * 2. unresolved transactions → surfaced for a chain query, NEVER re-sent (§98)
 * 3. keystore (optional)     → without it the process is a read-only monitor; no code path can write
 * 4. runtime assembly        → one chain instance, one signer, one set of adapters
 * 5. scheduler + long poll   → the beats actually start, and stop cleanly on a signal
 * ```
 *
 * ## Read-only is a real mode, not a degraded one
 * With no signer the process scans, persists the time series, values the portfolio, evaluates risk and
 * alerts — everything except writing. That is genuinely useful (it proves the data sources and the risk
 * view before any money moves), so it is supported explicitly rather than refused. What it must NOT do is
 * pretend: the startup output says which mode it is in and what is therefore impossible.
 */
import { loadConfig, ConfigError } from './config/index.ts';
import {
  KeystoreError,
  decryptPrivateKey,
  readKeystoreFile,
} from './security/keystore.ts';
import { readPassphraseFile } from './security/passphraseFile.ts';
import { WhitelistError } from './types/registry.ts';
import { buildCadences, buildRuntime, type StrategyRuntime } from './runtime.ts';
import { Scheduler } from './execution/scheduler.ts';
import { BscOnchainPoolStateSource } from './data/bscOnchainSource.ts';
import { LayeredPoolDataProvider } from './data/poolDataProvider.ts';
import { createReferencePriceProvider } from './data/referencePrice.ts';
import { promptSecret } from '../scripts/lib/prompt.ts';
import { privateKeyToAccount } from 'viem/accounts';
import type { ChainId } from './types/primitives.ts';

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
 * Exported so the same checks can run from a script: a pre-flight and a live start must never disagree
 * about whether the configuration is usable.
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
    // Structural validation only: this proves the envelope exists and is well formed. Decryption needs the
    // passphrase, which is entered interactively below and never stored.
    await readKeystoreFile(keystorePath);
  }

  /*
   * The wallet, validated BEFORE the passphrase prompt.
   *
   * A keystore supplies it (the key IS the owner), so this only fails when neither is present. Checking
   * here rather than inside `buildRuntime` matters because the operator is asked for a passphrase in
   * between: discovering a missing configuration after typing a secret is both alarming and unnecessary.
   */
  if ((keystorePath === undefined || keystorePath.length === 0) &&
      (env['STRATEGY_WALLET_ADDRESS'] === undefined || env['STRATEGY_WALLET_ADDRESS'] === '')) {
    throw new ConfigError(
      'no wallet to monitor: set STRATEGY_WALLET_ADDRESS to the address to watch, or configure ' +
        'KEYSTORE_PATH to run with a signing wallet.',
    );
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
    `lptrader — startup (${summary.sourcePath})`,
    '------------------------------------------------------',
    `  chains          : ${summary.chains.join(', ')}`,
    `  dexes           : ${summary.dexes.join(', ')}`,
    `  tradable stocks : ${summary.stockTokens.join(' ')}`,
    `  stablecoins     : ${summary.stablecoins.join(' > ')}`,
    `  §66 risk-off NAV: $${summary.riskOffLineUsd.toFixed(2)}`,
    `  approvals       : ${summary.approvals}`,
    `  telegram        : ${summary.telegramEnabled ? 'enabled' : 'DISABLED — no build or switch can be approved'}`,
    `  keystore        : ${summary.keystorePath ?? 'not configured (read-only monitor)'}`,
    `  dry-run         : ${summary.dryRun ? 'yes (no transaction will be sent)' : 'NO — transactions will be signed'}`,
  ].join('\n');
}

/**
 * Decrypt the keystore, or return `null` for a read-only run.
 *
 * The passphrase is read interactively and never stored. A wrong passphrase is a HARD failure rather than
 * a fallback to read-only: silently downgrading would leave the operator believing the bot can trade when
 * it cannot, and the next thing they would notice is a missed position.
 */
async function resolveSigner(
  env: NodeJS.ProcessEnv,
): Promise<NonNullable<Parameters<typeof buildRuntime>[0]['signer']> | null> {
  const keystorePath = env['KEYSTORE_PATH'];
  if (keystorePath === undefined || keystorePath.length === 0) return null;

  const chainId = Number(env['KEYSTORE_CHAIN_ID'] ?? 56);
  const envelope = await readKeystoreFile(keystorePath);

  /*
   * Unattended start: read the passphrase from a file when one is configured.
   *
   * A process manager has no terminal, so the interactive prompt below can never be answered — the process
   * would block forever on a prompt nobody can see. The file's permissions are enforced by the reader, and
   * a file that is group- or world-readable REFUSES to start rather than warning: a system that trades
   * happily while its key is exposed discovers the exposure only after the funds are gone.
   */
  const fromFile = await readPassphraseFile(env['KEYSTORE_PASSPHRASE_FILE']);
  if (fromFile !== null) {
    process.stdout.write(`Passphrase read from ${String(env['KEYSTORE_PASSPHRASE_FILE'])}.\n`);
  } else {
    process.stdout.write(
      '\nA keystore is configured, so the signing key is needed.\n' +
        'Enter the passphrase (hidden). Press Ctrl-C to run read-only instead.\n',
    );
  }
  const passphrase = fromFile ?? (await promptSecret('Passphrase (hidden): '));
  if (passphrase.length === 0) {
    process.stdout.write('No passphrase supplied — running read-only.\n');
    return null;
  }

  const decrypted = await decryptPrivateKey(envelope, passphrase, { chainId });
  const account = privateKeyToAccount(decrypted.privateKeyHex);
  if (account.address.toLowerCase() !== decrypted.address.toLowerCase()) {
    throw new KeystoreError(
      'ADDRESS_MISMATCH',
      'the decrypted key does not match the address recorded in the envelope; refusing to sign with it',
    );
  }
  return {
    privateKey: decrypted,
    account,
  } as NonNullable<Parameters<typeof buildRuntime>[0]['signer']>;
}

/** Construct the real data layer. Module 1 is HTTP-only, so the on-chain source feeds the *provider*. */
function buildProvider(runtimeConfig: Awaited<ReturnType<typeof loadConfig>>, env: NodeJS.ProcessEnv) {
  const chainId = (runtimeConfig.whitelist.chains[0] ?? 56) as ChainId;
  const onchain = new BscOnchainPoolStateSource({
    ...(env['BSC_RPC_URL'] === undefined ? {} : { rpcUrl: env['BSC_RPC_URL'] }),
  });
  return new LayeredPoolDataProvider({
    chainId,
    registry: runtimeConfig.whitelist.registry,
    onchain,
    referencePrice: createReferencePriceProvider({ chainId, registry: runtimeConfig.whitelist.registry }),
  });
}

async function main(): Promise<void> {
  const env = process.env;
  const summary = await loadStartupSummary(env);
  process.stdout.write(`${renderSummary(summary)}\n`);

  const config = await loadConfig();
  const signer = await resolveSigner(env);

  const runtime = buildRuntime({
    config,
    provider: buildProvider(config, env),
    // `dex` is omitted so the runtime constructs every whitelisted adapter (Pancake first: it is the only
    // venue with the §42 atomic build) from ONE chain instance, so there is one signer and one set of
    // cross-check semantics for the whole process.
    ...(signer === null ? {} : { signer }),
    env,
  });

  if (!summary.telegramEnabled) {
    // Stated loudly because it is the usual reason "nothing happens": the confirmation gate cannot be
    // satisfied, so BUILD_POSITION and SWITCH_POOL are impossible by design.
    process.stdout.write(
      '\nNOTE: the confirmation channel is disabled, so this process can monitor, alert, collect fees and\n' +
        'exit a position on risk — but it CANNOT open or switch a position. Configure TELEGRAM_* and set\n' +
        "config/strategy.yaml `telegram.enabled: true` to enable the gate.\n",
    );
  }
  if (summary.dryRun) {
    process.stdout.write('\nNOTE: DRY_RUN is on. Transactions are guard-checked and then refused before broadcast.\n');
  }

  const cadences = buildCadences(runtime);
  process.stdout.write(
    `\nmode: ${runtime.readOnly ? 'READ-ONLY (no signer — no write path exists)' : 'LIVE'}\n` +
      `cadences: ${cadences.map((cadence) => `${cadence.name}=${cadence.intervalSeconds / 60}m`).join(' ')}\n` +
      '\nStarting. Ctrl-C to stop.\n',
  );

  /**
   * Report EVERY beat, not only the failures.
   *
   * The previous version printed nothing on success, which made "working normally" and "dead" look
   * identical from the outside — and the first scan takes ~4 minutes, so an operator watching a healthy
   * start sees several minutes of silence and has no way to tell the difference. An operator who cannot
   * see progress will restart the process, and restarting is the one action that costs something.
   */
  const scheduler = new Scheduler({
    cadences,
    onReport: (report) => {
      const elapsed = Math.round((Date.parse(report.finishedAt) - Date.parse(report.startedAt)) / 1000);
      const stamp = report.finishedAt.slice(11, 19);
      if (report.ok) {
        process.stdout.write(`[${stamp}] ${report.name} ok (${elapsed}s)\n`);
        return;
      }
      // Failures stay on stderr so a log split by stream keeps them separable.
      process.stderr.write(`[${stamp}] ${report.name} FAILED (${elapsed}s): ${report.error ?? 'unknown'}\n`);
    },
  });

  installSignalHandlers(scheduler, runtime);

  // §97/§98: anything still in flight from a previous run is queried, never re-sent. Surfaced before the
  // first write-capable beat runs, so an operator sees it rather than discovering it from a double build.
  const unresolved = runtime.txStore.findUnresolved({ chainId: runtime.chain.chainId });
  if (unresolved.length > 0) {
    process.stderr.write(
      `\nWARNING: ${unresolved.length} transaction(s) from a previous run are unresolved. They will NOT be ` +
        're-sent; query the chain and resolve them with the operator tools.\n' +
        unresolved.map((record) => `  ${record.idempotencyKey} attempt ${record.attempt} state=${record.state}`).join('\n') +
        '\n',
    );
  }

  // Telegram long-poll runs alongside the scheduler so an approval can arrive while a cadence is working.
  // Started before the loop so the channel is listening by the time anything asks for an approval.
  const notifier = runtime.notifier as { start?: () => void };
  notifier.start?.();

  // Runs until a signal arrives.
  await scheduler.run();
}

/**
 * Stop cleanly.
 *
 * A hard kill mid-cadence could leave a transaction recorded as in-flight when it was never broadcast, or
 * the reverse. The scheduler's `stop()` lets the current tick finish, and the process exits only after it
 * returns, so the recorded state matches what actually happened.
 */
function installSignalHandlers(scheduler: Scheduler, runtime: StrategyRuntime): void {
  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`\n${signal} received — finishing the current cadence and stopping...\n`);
    scheduler.stop();
    const notifier = runtime.notifier as { stop?: () => Promise<void> };
    void notifier.stop?.();
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
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
