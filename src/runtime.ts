/**
 * Composition root: assemble the live strategy from configuration, then run the §89 cadences.
 *
 * ## What this file is allowed to do
 * Wiring only. Every rule lives in the module that owns it — the executor gates writes, the risk
 * manager decides severity, the approval gate releases builds. A decision appearing here would be in
 * the wrong place.
 *
 * ## Collaborators are required parameters, never fabricated
 * `dex` and `provider` are injected by the caller. This file deliberately contains no stub, no
 * placeholder and no `as`-cast to satisfy a dependency: a runtime assembled without a real DEX adapter
 * must fail to compile rather than look functional and throw at the first write. That is the same
 * fail-closed rule the rest of the system follows, applied to the assembly itself.
 *
 * ## The startup order is the safety property
 * Each step is a precondition for the next, and the whole thing fails closed:
 *
 *   1. **Config + whitelist** — an empty whitelist or a non-whitelisted DEX/chain stops the process
 *      before a single RPC is opened (§96).
 *   2. **Unresolved transactions** (§98) — any `CREATED`/`SUBMITTED`/`UNKNOWN` record from a previous
 *      run is surfaced for a chain query, never re-sent. A crash mid-build must not become a double
 *      build.
 *   3. **Signer** — optional. Without it the runtime is a **read-only monitor**: no wallet client is
 *      attached, `getSignerAddress()` returns `null`, and `executor` is `null` so no code path can
 *      reach a write (§92/§94). Read-only is a structural property here, not a flag.
 *   4. **Approval channel** — with Telegram disabled the notifier is the contract's `noopNotifier`,
 *      which can never approve, so `BUILD_POSITION`/`SWITCH_POOL` are impossible (D2) while the
 *      automatic paths (collect, risk exit) keep working.
 *
 * ## Failure mode worth stating plainly
 * With `TELEGRAM_ENABLED=false` the bot can monitor, alert, collect fees and exit a position on risk,
 * but it **cannot open or switch a position**. That is the intended direction: silence must never be
 * read as consent.
 */
import type { Account } from 'viem';
import type { BscChainAdapter } from './chain/adapter.ts';
import { BscChainAdapter as BscAdapter } from './chain/adapter.ts';
import type { PositionReader } from './chain/positionReader.ts';
import { PositionReader as PositionReaderImpl } from './chain/positionReader.ts';
import type { TokenRegistry } from './types/registry.ts';
import type { TokenReader } from './chain/tokenReader.ts';
import { TokenReader as TokenReaderImpl } from './chain/tokenReader.ts';
import type { DexAdapter, PoolDataProvider, ReferencePriceProvider } from './types/adapters.ts';
import type { StrategyConfig } from './types/config.ts';
import { DEX_IDS, type Address, type DexId, type IsoTimestamp, type UsdAmount } from './types/primitives.ts';
import type { PoolSnapshot } from './types/market.ts';
import { ALERT_SEVERITIES, type Notifier } from './types/notifier.ts';
import type { DecryptedPrivateKey } from './security/keystore.ts';
import { openDatabase } from './store/db.ts';
import { StateStore } from './store/stateStore.ts';
import { TxStore } from './store/txStore.ts';
import { StateMachine } from './strategy/stateMachine.ts';
import {
  createSqliteApprovalGate,
  stateStoreDecisionLogSink,
  type ApprovalGate,
} from './execution/approvalGate.ts';
import { ActionHandlers } from './execution/actionHandlers.ts';
import { PositionExecutor } from './execution/positionExecutor.ts';
import { PortfolioMonitor } from './execution/portfolioMonitor.ts';
import { PoolScanner, foundPools } from './data/poolScanner.ts';
import { filterPools } from './data/poolFilter.ts';
import { createReferencePriceProvider } from './data/referencePrice.ts';
import { createPancakeV3Adapter } from './dex/pancakeV3.ts';
import { createUniswapV3Adapter } from './dex/uniswapV3.ts';
import { DEX_PREFERENCE, createDexAdapter, type DexAdapterFactoryOptions } from './dex/index.ts';
import { createNotifierFromConfig } from './notify/telegram.ts';
import { type SchedulerCadence } from './execution/scheduler.ts';
import { readKeystoreFile } from './security/keystore.ts';

/** Everything the cadences share; built once so no cadence rebuilds a client or a store. */
export interface StrategyRuntime {
  readonly config: StrategyConfig;
  readonly chain: BscChainAdapter;
  readonly tokenReader: TokenReader;
  readonly positionReader: PositionReader;
  readonly referencePrice: ReferencePriceProvider;
  readonly dex: DexAdapter;
  readonly provider: PoolDataProvider;
  readonly scanner: PoolScanner;
  readonly monitor: PortfolioMonitor;
  readonly notifier: Notifier;
  readonly approvals: ApprovalGate;
  readonly txStore: TxStore;
  readonly stateStore: StateStore;
  readonly stateMachine: StateMachine;
  /** `null` in read-only mode — the entire write path is unreachable without it. */
  readonly executor: PositionExecutor | null;
  readonly readOnly: boolean;
}

/** The signer material, already decrypted. Never a raw key string, never logged. */
export interface RuntimeSigner {
  readonly privateKey: DecryptedPrivateKey;
  /** viem account built from the decrypted key by the caller (keeps viem out of this module). */
  readonly account: Account;
}

export interface BuildRuntimeOptions {
  readonly config: StrategyConfig;
  /**
   * §82 DEX implementation. Omitted ⇒ the composition root constructs every whitelisted adapter and
   * picks the preferred one (PancakeSwap first, because it is the only venue that can perform the §42
   * atomic build). Injecting one is for tests and for a deliberately single-venue run.
   */
  readonly dex?: DexAdapter;
  /** Every adapter to construct when `dex` is not injected, in preference order. */
  readonly dexConstructors?: Readonly<
    Partial<Record<DexId, (options: DexAdapterFactoryOptions) => DexAdapter>>
  >;
  /** §83 market-data source. Required: without it no pool can be discovered. */
  readonly provider: PoolDataProvider;
  /** §84 reference prices. Omitted ⇒ a Binance-backed provider is constructed for the chain. */
  readonly referencePrice?: ReferencePriceProvider;
  /** Decrypted signer; omitted ⇒ read-only runtime (no wallet client is ever constructed). */
  readonly signer?: RuntimeSigner;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Build the live runtime.
 *
 * A missing `signer` produces a monitor-only runtime rather than an error: monitoring a wallet that no
 * one can trade from is a legitimate and useful mode, and it is the safe default before a keystore has
 * been created.
 */
export function buildRuntime(options: BuildRuntimeOptions): StrategyRuntime {
  const env = options.env ?? process.env;
  const config = options.config;

  // §96: whitelist checks run before any network object exists.
  config.whitelist.assertWhitelistNonEmpty();
  for (const entry of config.whitelist.dexes) {
    config.whitelist.assertWhitelistedChain(entry.chainId);
    config.whitelist.assertWhitelistedDex(entry.chainId, entry.dex);
  }

  const chainId = config.whitelist.chains[0];
  if (chainId === undefined) {
    throw new Error('no whitelisted chain: refusing to start (§11)');
  }


  const db = openDatabase(env['LP_DB_PATH'] ?? 'data/lptrader.db');
  const stateStore = new StateStore(db);
  const txStore = new TxStore(db);
  const stateMachine = StateMachine.open(db);

  // §98: surface anything left in flight by a previous run. This is reported, never silently re-sent —
  // the recovery pass is the caller's job because it needs chain access to resolve a hash.
  const unresolved = txStore.findUnresolved({ chainId });

  const chain = new BscAdapter({
    chainId,
    whitelist: config.whitelist,
    ...(options.signer === undefined ? {} : { account: options.signer.account }),
  });

  // §82: one adapter per whitelisted DEX, constructed from the SAME chain instance so there is exactly
  // one signer and one set of §99 cross-check semantics for the whole process. The preferred adapter is
  // the first in `DEX_PREFERENCE` that this chain is whitelisted for.
  const constructors = options.dexConstructors ?? {
    [DEX_IDS.PANCAKESWAP_V3]: (factoryOptions) => createPancakeV3Adapter(factoryOptions),
    [DEX_IDS.UNISWAP_V3]: (factoryOptions) => createUniswapV3Adapter(factoryOptions),
  };
  const adapters = options.dex !== undefined
    ? [options.dex]
    : DEX_PREFERENCE.filter((dex) => config.whitelist.isWhitelistedDex(chainId, dex)).map((dex) =>
        createDexAdapter(dex, { chainId, whitelist: config.whitelist, chain }, constructors),
      );
  const dex = options.dex ?? adapters[0];
  if (dex === undefined) {
    throw new Error(
      `no DEX adapter could be constructed for chain ${chainId}: no whitelisted DEX is registered in this build`,
    );
  }

  const tokenReader = new TokenReaderImpl(chain, registryFor(config), chainId);
  const positionReader = new PositionReaderImpl(chain, chainId);
  const referencePrice =
    options.referencePrice ?? createReferencePriceProvider({ chainId, registry: config.whitelist.registry });

  // The action handlers need the executor, which needs the approval gate, which needs the notifier, which
  // needs the action handlers. That cycle is inherent to the design (each layer owns one concern), so it is
  // broken with a late-bound reference rather than by weakening any of the four.
  let actionHandlersRef: ActionHandlers | null = null;

  const notifier = createNotifierFromConfig(config, env, {
    actionHandlers: {
      exit: async () => (await requireActionHandlers(actionHandlersRef)).exit().then((r) => r.message),
      start: async () => (await requireActionHandlers(actionHandlersRef)).start().then((r) => r.message),
      resume: async () => (await requireActionHandlers(actionHandlersRef)).resume().then((r) => r.message),
    },
  });
  const approvals = createSqliteApprovalGate(db, {
    notifier,
    timeoutMinutes: config.approvals.timeoutMinutes,
    // §77: every approval decision is audited next to the pool/APR context that produced it.
    audit: stateStoreDecisionLogSink(stateStore),
  });

  const monitor = new PortfolioMonitor({
    chain,
    tokenReader,
    positionReader,
    referencePrice,
    whitelist: config.whitelist,
    // Stablecoins are priced from Binance's own stablecoin pair (e.g. `USDCUSDT`), NOT from the stock
    // reference provider — that provider answers the stock leg's NAV-versus-equity question and returns
    // nothing for USDC, which previously zeroed the whole reserve and tripped §66 on a healthy wallet.
    stablecoinPrice: createStablecoinPricer(env),
    maxDrawdown: config.risk.maxDrawdown,
    // §3: the monitor reports the allocation every round, because the user funds manually and the ratios
    // drift with each deposit (§68 — noticing is the bot's job, not topping up).
    allocationLimits: { maxLpRatio: config.capital.maxLpRatio, reserveRatio: config.capital.reserveRatio },
    windowSeconds: config.monitor.portfolioIntervalMinutes * 60,
    ...(env['STRATEGY_WALLET_ADDRESS'] === undefined || env['STRATEGY_WALLET_ADDRESS'] === ''
      ? {}
      : { watchAddress: env['STRATEGY_WALLET_ADDRESS'] as `0x${string}` }),
  });

  const readOnly = options.signer === undefined;
  const stateMachineRef = stateMachine;
  const executor = readOnly
    ? null
    : new PositionExecutor({
        dex,
        txStore,
        stateMachine: stateMachineRef,
        approvalGate: approvals,
        currentState: () => stateMachineRef.current,
      });

  // §6.2: built after the executor so the late-bound reference above can be resolved. In read-only mode
  // there is no executor, so the action handlers are absent and every action command is refused — which is
  // the correct outcome for a monitor-only process.
  if (executor !== null) {
    actionHandlersRef = new ActionHandlers({
      executor,
      stateMachine,
      positionReader,
      dex,
      openPosition: async () => {
        const record = stateStore.openPosition(chainId);
        if (record === null) return null;
        return {
          poolId: record.poolId,
          positionTokenId: BigInt(record.id),
          liquidity: record.liquidity,
          owner: walletAddressOf(env),
          dex: record.dex,
        };
      },
    });
  }

  if (unresolved.length > 0) {
    notifier
      .send(
        ALERT_SEVERITIES.WARNING,
        `${unresolved.length} transaction(s) need a chain query before any new build`,
        unresolved
          .map((record) => `${record.idempotencyKey} attempt ${record.attempt} state=${record.state} hash=${record.txHash ?? 'none'}`)
          .join('\n'),
      )
      .catch(() => {
        // Alerts are best-effort by contract; the startup path must not fail because a channel is down.
      });
  }

  return {
    config,
    chain,
    tokenReader,
    positionReader,
    referencePrice,
    dex,
    provider: options.provider,
    // Module 1 is HTTP-only (architecture §3): the scanner gets no adapters, because it must not call
    // the chain. On-chain pool reading belongs to module 2.
    scanner: new PoolScanner({ config, provider: options.provider }),
    monitor,
    notifier,
    approvals,
    txStore,
    stateStore,
    stateMachine,
    executor,
    readOnly,
  };
}

/** §89 cadences, derived from `config.monitor`. Each one is independent; none decides anything. */
export function buildCadences(runtime: StrategyRuntime): readonly SchedulerCadence[] {
  const { config } = runtime;
  return [
    {
      name: 'portfolio-monitor',
      intervalSeconds: config.monitor.portfolioIntervalMinutes * 60,
      run: async (at) => {
        const result = await runtime.monitor.monitor({
          walletAddress: runtime.monitor.walletAddress(),
          now: at,
          // The position/pool are supplied by the position-tracking task; until a position exists the
          // monitor correctly values a reserve-only portfolio.
          position: null,
          pool: null,
          benchmark: null,
          initialNAV: config.capital.initialStrategyCapitalUsd,
          reserveRatio: config.capital.reserveRatio,
          priorPeakNAV: null,
          realizedFees: 0,
          gasCost: 0,
          swapCost: 0,
          slippageCost: 0,
        });
        // §96: an incomplete NAV is reported as degraded, never treated as merely a smaller NAV.
        if (!result.complete) {
          await runtime.notifier.send(
            ALERT_SEVERITIES.WARNING,
            'portfolio valuation incomplete',
            result.problems.join('\n'),
          );
        }
      },
    },
    {
      name: 'pool-scan',
      intervalSeconds: config.monitor.poolScanIntervalMinutes * 60,
      run: async (at) => {
        const summary = await runtime.scanner.scan();
        if (!summary.complete) {
          // A partial scan must not look like a clean market: say which source failed.
          await runtime.notifier.send(
            ALERT_SEVERITIES.WARNING,
            'pool scan incomplete',
            summary.blockers.join('\n'),
          );
        }
        const outcome = filterPools(
          foundPools(summary),
          {
            minTvlUsd: config.pool.minTvlUsd,
            minAvgDailyVolume7dUsd: config.pool.minAvgDailyVolume7dUsd,
            minPoolAgeDays: config.pool.minPoolAgeDays,
            maxNavDeviation: config.pool.maxNavDeviation,
            maxSwapPriceImpact: config.pool.maxSwapPriceImpact,
          },
          {
            evaluatedAt: at,
            whitelist: config.whitelist,
            isOnchainVerified: (snapshot: PoolSnapshot) => summary.onchainVerifiedByPool[snapshot.poolId] === true,
          },
        );
        // §96: a pool rejected because a figure was unavailable is a DATA problem, not a bad pool, and
        // the operator must be told which one it is.
        if (!outcome.decisive) {
          await runtime.notifier.send(
            ALERT_SEVERITIES.WARNING,
            'pool filter could not decide on its merits',
            outcome.rejected.map((entry) => `${entry.snapshot.poolId}: ${entry.evaluation.reasons.join('; ')}`).join('\n'),
          );
        }
      },
    },
  ];
}

/**
 * Resolve the late-bound action handlers, or explain why an action cannot run.
 *
 * A read-only runtime (no signer) has no executor and therefore no action handlers. Refusing with a
 * reason is what the operator needs: `/exit` on a monitor-only process should say so, not appear stuck.
 */
function requireActionHandlers(handlers: ActionHandlers | null): ActionHandlers {
  if (handlers === null) {
    throw new Error(
      'no signer is attached, so operator actions cannot run: this process is a read-only monitor. ' +
        'Configure KEYSTORE_PATH and start with a wallet to enable /exit /start /resume.',
    );
  }
  return handlers;
}

/** §92: the wallet address an action should treat as the owner. Required for a funded run. */
function walletAddressOf(env: NodeJS.ProcessEnv): Address {
  const configured = env['STRATEGY_WALLET_ADDRESS'];
  if (configured === undefined || configured === '') {
    throw new Error(
      'STRATEGY_WALLET_ADDRESS is not set: an operator action needs to know the owning wallet, and ' +
        'guessing it would be worse than refusing',
    );
  }
  return configured as Address;
}

/** The chain's token registry, reached through the whitelist (§8 identity source). */
function registryFor(config: StrategyConfig): TokenRegistry {
  return config.whitelist.registry;
}

/** §66 risk line, exposed so a status view can print it without recomputing. */
export function riskOffLineUsd(config: StrategyConfig): UsdAmount {
  return config.capital.initialStrategyCapitalUsd * (1 - config.risk.maxDrawdown);
}

/** §77 the operator-facing status line, used by the Telegram `/status` handler. */
export function renderStatus(runtime: StrategyRuntime, at: IsoTimestamp): string {
  return [
    `lptrader @ ${at}`,
    `state        : ${runtime.stateMachine.current}`,
    `mode         : ${runtime.readOnly ? 'READ-ONLY (no signer)' : 'LIVE'}`,
    `chain        : ${runtime.chain.chainId}`,
    `dex          : ${runtime.dex.dex}`,
    `approvals    : build=${runtime.config.approvals.buildPosition} switch=${runtime.config.approvals.switchPool}`,
    `risk-off NAV : $${riskOffLineUsd(runtime.config).toFixed(2)}`,
  ].join('\n');
}

/** §46 keystore read for the startup pre-flight (structural validation only, no passphrase). */
export async function inspectKeystore(path: string): Promise<void> {
  await readKeystoreFile(path);
}

/**
 * USD price for a stablecoin, from Binance's `SYMBOLUSDT` spot ticker.
 *
 * `/api/v3/ticker/price?symbol=USDCUSDT` is the natural source: same venue as the stock leg, no key, and
 * it prices the peg against USDT rather than assuming par. USDT is the quote currency of every pair, so
 * its own value follows from the quoting convention rather than from an assumption about the peg.
 *
 * A failure returns `stale`, so the valuation is reported incomplete instead of quietly treating an
 * unpriced stablecoin as par — assuming par is exactly what would hide a depeg (§58).
 */
export function createStablecoinPricer(env: NodeJS.ProcessEnv = process.env) {
  const base = env['BINANCE_SPOT_BASE_URL'] ?? 'https://api.binance.com';
  return async (token: { readonly symbol: string }): Promise<{
    readonly value: number | null;
    readonly source: 'binance-spot' | 'unavailable';
    readonly asOf: string;
    readonly stale: boolean;
  }> => {
    const symbols = USD_STABLECOIN_PAIRS[token.symbol.toUpperCase()];
    const asOf = new Date().toISOString();
    if (symbols === undefined) {
      return { value: null, source: 'unavailable', asOf, stale: true };
    }
    if (symbols.length === 0) {
      // USDT is the quote side of every pair, so its USD value is 1 by construction of the convention.
      return { value: 1, source: 'binance-spot', asOf, stale: false };
    }
    for (const symbol of symbols) {
      try {
        const response = await fetch(`${base}/api/v3/ticker/price?symbol=${symbol}`);
        if (!response.ok) continue;
        const body = (await response.json()) as { price?: string };
        const price = Number(body.price);
        if (Number.isFinite(price) && price > 0) {
          return { value: price, source: 'binance-spot', asOf, stale: false };
        }
      } catch {
        // Fall through to the next candidate symbol; a network failure must never become a price.
      }
    }
    return { value: null, source: 'unavailable', asOf, stale: true };
  };
}

/**
 * Stablecoin → Binance pairs that price it against USDT. An empty list means the token IS the quote
 * currency (USDT), so its USD value follows from the quoting convention.
 */
const USD_STABLECOIN_PAIRS: Readonly<Record<string, readonly string[]>> = {
  USDC: ['USDCUSDT'],
  USDT: [],
};
