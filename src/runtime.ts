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
import type { DexAdapter, PoolDataProvider, ReferencePriceProvider, TxGuardChecks } from './types/adapters.ts';
import type { StrategyConfig } from './types/config.ts';
import { DEX_IDS, type Address, type DexId, type IsoTimestamp, type PoolId, type UsdAmount } from './types/primitives.ts';
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
import { PoolSnapshotStore } from './store/poolSnapshotStore.ts';

import { verifyPostAllocation } from './strategy/allocation.ts';
import { RiskWiring, describeRiskAction } from './execution/riskWiring.ts';
import { RISK_ACTIONS } from './strategy/riskManager.ts';
import { ActionHandlers } from './execution/actionHandlers.ts';
import { PositionExecutor } from './execution/positionExecutor.ts';
import { PortfolioMonitor } from './execution/portfolioMonitor.ts';
import { PoolScanner, foundPools } from './data/poolScanner.ts';
import { PoolScreener } from './data/poolScreener.ts';
import { BuildOrchestrator } from './strategy/buildOrchestrator.ts';
import { decideRebuild } from './strategy/rebuildPolicy.ts';
import {
  FundingPlanner,
  conversionGuard,
  conversionKey,
  type FundingPlan,
} from './strategy/funding.ts';
import { evaluateSwapQuote, swapLimitsForPool } from './strategy/swapPlanner.ts';
import {
  computeReturn,
  isPoolContributionNegative,
  stockPriceOf,
  valueEntryComposition,
} from './strategy/returns.ts';
import { QueryCache, poolViewFrom, type PositionView, type ReturnView, type StatusView } from './runtime/queryCache.ts';
import { createQueryHandlers } from './runtime/queryHandlers.ts';
import {
  conditionLabel,
  renderMessage,
  riskHeadline,
  titleWithIcon,
} from './notify/messageFormat.ts';
import { buildTxGuard } from './chain/txState.ts';
import { filterPools } from './data/poolFilter.ts';
import { createReferencePriceProvider } from './data/referencePrice.ts';
import { createPancakeV3Adapter } from './dex/pancakeV3.ts';
import { createUniswapV3Adapter } from './dex/uniswapV3.ts';
import { DEX_PREFERENCE, createDexAdapter, type DexAdapterFactoryOptions } from './dex/index.ts';
import { createNotifierFromConfig } from './notify/telegram.ts';
import { type SchedulerCadence } from './execution/scheduler.ts';
import { readKeystoreFile } from './security/keystore.ts';
import { BOT_STATES } from './types/state.ts';
import { createLogger } from './util/logger.ts';
import type { PortfolioSnapshot } from './types/portfolio.ts';

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
  /** §3.3 time series: the only source of the 24h history §59 needs. */
  readonly poolSnapshots: PoolSnapshotStore;
  /** Keep the latest scan's pools available to the risk beats (see `latestPoolByAddress`). */
  readonly rememberScannedPools: (pools: readonly PoolSnapshot[]) => void;
  /**
   * The most recent scan's pools, keyed by lowercased address.
   *
   * Exposed so the portfolio beat can value a position's entry composition at today's prices without
   * re-reading the chain or the scan: the snapshot it needs is already in memory from the last beat.
   */
  readonly latestPools: ReadonlyMap<string, PoolSnapshot>;
  /** Module 3 wiring: the risk verdict and the action it implies. */
  readonly riskWiring: RiskWiring;
  /**
   * §65 high-water mark, carried across rounds.
   *
   * Mutable state on the runtime rather than a store lookup because the drawdown line is defined against
   * the peak THIS process has observed; persisting it would invite the bot to inherit a peak from a
   * different configuration and halt on it.
   */
  lastPeakNAV: number | null;
  /** §3/§60 allocation check, exposed so a cadence can report it without re-deriving the limits. */
  readonly monitorAllocation: () => Promise<{ readonly ok: boolean; readonly problems: readonly string[] }>;
  readonly actionHandlers: ActionHandlers | null;
  /** `null` in read-only mode — the entire write path is unreachable without it. */
  readonly executor: PositionExecutor | null;
  readonly readOnly: boolean;
  /**
   * True when transactions are guard-checked and refused before broadcast.
   *
   * On the runtime rather than read from `process.env` at each use: a banner that reports "dry-run: yes"
   * while the chain layer would happily broadcast is worse than having no flag at all, and the two must
   * therefore read the SAME resolved value.
   */
  readonly dryRun: boolean;
  /** Module 2: screens candidates on chain and returns the first that passes. */
  readonly screener: PoolScreener;
  /**
   * §45 build orchestration. `null` only in read-only mode, where no build can ever be executed — the
   * orchestrator would compute a plan nothing could carry out.
   */
  readonly buildOrchestrator: BuildOrchestrator | null;
  /** Answers `/status` `/position` `/pools` `/nav` `/risk` from the last observed state. */
  readonly queryCache: QueryCache;
  /**
   * Prepare and (subject to approval) execute a build from the latest scan.
   *
   * Shared by `/start`, the post-exit rebuild and the risk-driven switch, so there is exactly ONE path
   * that can open a position. A second path is a second set of bugs.
   */
  readonly openPositionFromLatestScan: (options?: {
    readonly affordableUsd?: UsdAmount;
    readonly trigger?: string;
  }) => Promise<{ readonly ok: boolean; readonly message: string }>;
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


  /**
   * The process's logger, created once and handed to every layer that narrates a decision.
   *
   * Level comes from `LP_LOG_LEVEL` (default `info`), so an operator raises verbosity without editing code —
   * a debug level that required a rebuild would not be used at the moment it is needed.
   */
  const logger = createLogger();

  const db = openDatabase(env['LP_DB_PATH'] ?? 'data/lptrader.db');
  const stateStore = new StateStore(db);
  const txStore = new TxStore(db);
  const stateMachine = StateMachine.open(db);

  // §98: surface anything left in flight by a previous run. This is reported, never silently re-sent —
  // the recovery pass is the caller's job because it needs chain access to resolve a hash.
  const unresolved = txStore.findUnresolved({ chainId });

  /*
   * DRY_RUN reaches the chain adapter, which is the ONLY layer that can refuse to broadcast.
   *
   * It previously did not: the adapter was constructed without `dryRun`, so it defaulted to `false` and
   * would have sent every transaction for real — while the startup banner printed
   * `dry-run: yes (no transaction will be sent)`. A safety switch that reports itself as on and is off is
   * worse than no switch, because it is trusted.
   *
   * Read from `env` (the caller's environment) rather than `process.env`: this function takes an explicit
   * env, and consulting the global one would let the two disagree about whether real money may move.
   */
  const dryRun = (env['DRY_RUN'] ?? '1') !== '0';

  const chain = new BscAdapter({
    chainId,
    whitelist: config.whitelist,
    dryRun,
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
        createDexAdapter(dex, { chainId, whitelist: config.whitelist, chain, logger }, constructors),
      );
  const dex = options.dex ?? adapters[0];
  if (dex === undefined) {
    throw new Error(
      `no DEX adapter could be constructed for chain ${chainId}: no whitelisted DEX is registered in this build`,
    );
  }

  /**
   * The wallet operator actions act on, resolved once.
   *
   * Resolved here rather than at each use: it is a precondition of several subsystems, and discovering it
   * is missing in the middle of building the runtime is how an operator ends up entering a passphrase and
   * only then being told the configuration is incomplete.
   */
  const walletAddress = walletAddressOf(env, options.signer);

  const tokenReader = new TokenReaderImpl(chain, registryFor(config), chainId);
  const positionReader = new PositionReaderImpl(chain, chainId);
  const referencePrice =
    options.referencePrice ?? createReferencePriceProvider({ chainId, registry: config.whitelist.registry });

  /**
   * Answers the query commands from the last observation, never a live read.
   *
   * Declared before the notifier because the notifier's query handlers close over it; filled later by the
   * cadences. Empty at construction, which is correct — before the first beat, "not measured yet" is the
   * only true answer.
   */
  const queryCache = new QueryCache();

  // The action handlers need the executor, which needs the approval gate, which needs the notifier, which
  // needs the action handlers. That cycle is inherent to the design (each layer owns one concern), so it is
  // broken with a late-bound reference rather than by weakening any of the four.
  let actionHandlersRef: ActionHandlers | null = null;

  const notifier = createNotifierFromConfig(config, env, {
    // The notifier's own diagnostics were being discarded.
    //
    // `createNotifierFromConfig` defaults to a logger whose methods are empty, and nothing here overrode it,
    // so every Telegram warning — a failed `getUpdates`, an ignored callback, a refused decision — went
    // nowhere. An operator clicking Approve and seeing nothing had no way to tell whether the click was
    // rejected, unparseable, or never arrived at all.
    logger: {
      info: (message, context) => process.stdout.write(`[telegram] ${message}${formatContext(context)}\n`),
      warn: (message, context) => process.stderr.write(`[telegram] ${message}${formatContext(context)}\n`),
      error: (message, context) => process.stderr.write(`[telegram] ${message}${formatContext(context)}\n`),
    },
    // The query commands read the last observation only. Wired through a late-bound reference because the
    // cache is filled by the cadences, which are built from the runtime this notifier is part of.
    queryHandlers: createQueryHandlers({ cache: queryCache }),
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
        logger,
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
      // Late-bound because the handlers are constructed before the runtime object exists, and the build
      // path lives on it. Resolving it here keeps ONE build path rather than a second implementation.
      buildPosition: async (options) => openPositionFromLatestScan(options ?? {}),
      // §6.4: gates the AUTOMATIC rebuild only. The exit itself is never refused — see the policy module.
      approveRebuild: async (previous) => {
        const proceeds = queryCache.nav?.value.lpValueUsd ?? 0;
        const decision = decideRebuild(
          {
            proceedsUsd: proceeds,
            // §30: the round trip is two swaps plus gas plus the IL the exit just realized. Estimated from
            // the position value because the exact figures are only knowable after both legs settle.
            roundTripCostUsd: proceeds * (config.swap.maxSlippage * 2 + config.swap.maxPriceImpact * 2),
            now: new Date().toISOString(),
            riskDriven: false,
          },
          config.switch,
        );
        void previous;
        return decision;
      },
      openPosition: async () => {
        const record = stateStore.openPosition(chainId);
        if (record === null) return null;
        return {
          poolId: record.poolId,
          positionTokenId: BigInt(record.id),
          liquidity: record.liquidity,
          owner: walletAddress,
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

  const poolSnapshots = new PoolSnapshotStore(db);

  /**
   * The pools from the most recent scan, keyed by lowercased address.
   *
   * The risk beat needs the OPEN position's pool snapshot, and that snapshot comes from a scan that runs
   * on its own cadence. Holding the last scan in memory is what connects the two beats — and it is
   * deliberately in-memory: a snapshot from a previous process would carry a stale price into a live risk
   * verdict, which is worse than reporting the position as unreadable.
   */
  const latestPoolByAddress = new Map<string, PoolSnapshot>();

  /**
   * Module 2 (§16 on-chain gates). The ONLY component allowed to read the chain during screening, which is
   * why it receives the adapters and module 1 does not.
   */
  const screener = new PoolScreener({
    config,
    adapters: new Map(adapters.map((adapter) => [adapter.dex, adapter])),
    referencePrice,
  });

  /**
   * Decides how the build is funded, BEFORE anything is quoted or approved.
   *
   * Absent in read-only mode: it exists to spend money, and a monitor has none to spend.
   */
  const fundingPlanner = readOnly
    ? null
    : new FundingPlanner({
        config,
        balanceOf: (token) => chain.getTokenBalanceOf(token, walletAddress),
        tokenMeta: (address) => config.whitelist.registry.getTokenByAddress(chainId, address),
      });

  /**
   * §45 build orchestration. Absent in read-only mode: a plan nothing can execute would still push an
   * approval request, and asking the operator to authorise a build that cannot run is worse than saying so.
   */
  const buildOrchestrator = readOnly
    ? null
    : new BuildOrchestrator({
        config,
        screener,
        tokenMeta: (address) => config.whitelist.registry.getTokenByAddress(chainId, address),
        /*
         * Quote through the adapter that OWNS the pool.
         *
         * The screener reads every whitelisted venue, so it can accept a pool on any of them — but this
         * previously called `dex.quoteSwap`, bound to the PREFERRED adapter. A Uniswap pool could therefore
         * be selected and then fail at the quote with a poolId that adapter does not know, which is a
         * confusing way to say "wrong venue". Observed live.
         */
        quoteSwap: (request) => {
          const venue = request.poolId.split(':')[1];
          const owner = adapters.find((adapter) => adapter.dex === venue) ?? dex;
          return owner.quoteSwap(request);
        },
        guard: () => buildTxGuard(buildGuardChecks(config, dex, walletAddress)),
        walletAddress: walletAddress,
        now: () => new Date().toISOString(),
      });

  // Module 3 wiring. The open position is read from the store and its pool snapshot is taken from the
  // last scan, so the risk verdict is computed against the position we actually hold.
  const riskWiring = new RiskWiring({
    monitor,
    config,
    allocationLimits: { maxLpRatio: config.capital.maxLpRatio, reserveRatio: config.capital.reserveRatio },
    openPosition: async () => {
      const record = stateStore.openPosition(chainId);
      if (record === null) return null;
      const pool = latestPoolByAddress.get(record.poolAddress.toLowerCase());
      if (pool === undefined) {
        // Without the pool snapshot there is no price, no range position and no TVL history, so the
        // verdict would be built from nothing. Reporting it as a missing input is the honest answer.
        return null;
      }
      return {
        record,
        pool,
        positionTokenId: BigInt(record.id),
        liquidity: record.liquidity,
        owner: walletAddress,
      };
    },
    tvlSeries: (poolId) => poolSnapshots.tvlSeries(poolId),
    // §pre-funding: "has this strategy ever been funded?" answered from evidence rather than from intent.
    // ANY position row (open or closed) proves capital was committed at some point; an empty table means
    // the operator has not started. This is what separates "idle" from "wiped out" at NAV 0.
    hasCommittedCapital: () => stateStore.listPositions({ chainId }).length > 0,
    // §58 conditions come from outside the pool data (a paused contract, a suspended issuer). Nothing
    // observes them yet, so the domain is reported as a missing input rather than as "no emergency".
    emergencyEvents: () => [],
    // The pool's own contribution, from the SAME computation `/nav` shows. Two implementations would be
    // two answers to "is this pool worth staying in", and the operator would be shown the wrong one.
    poolContribution: () => {
      const snap = queryCache.nav?.value;
      if (snap === undefined) return { contributionUsd: null, rounds: 0 };
      return {
        contributionUsd: snap.returns?.poolContributionUsd ?? null,
        rounds: snap.returns?.negativeContributionRounds ?? 0,
      };
    },
  });

  /**
   * §45: the ONE path that opens a position.
   *
   * Every trigger — `/start`, the post-exit rebuild, the risk-driven switch — calls this, so there is a
   * single place where a build can begin. The earlier codebase had none, and the components were
   * individually complete: screening, planning, quoting and executing all worked and nothing joined them.
   *
   * The scan candidates are ordered §8.2 (apr7d desc, then tvlUsd) here rather than inside the screener,
   * because ordering is a strategy decision and the screener deliberately does not make it.
   */
  const openPositionFromLatestScan: StrategyRuntime['openPositionFromLatestScan'] = async (options = {}) => {
    if (buildOrchestrator === null || executor === null) {
      return {
        ok: false,
        message:
          'no signer is attached, so a build cannot run: this process is a read-only monitor. ' +
          'Configure KEYSTORE_PATH and restart with a wallet to enable builds.',
      };
    }

    const candidates = [...latestPoolByAddress.values()].sort(
      (a, b) =>
        (b.estimatedAPR7d.value ?? 0) - (a.estimatedAPR7d.value ?? 0) || b.tvlUSD.value - a.tvlUSD.value,
    );
    if (candidates.length === 0) {
      return {
        ok: false,
        message:
          'no candidates available yet: the pool scan has not produced a snapshot (the first scan takes ' +
          '~4 minutes). Try again shortly, or check /status.',
      };
    }

    // §3: NAV is passed through; the orchestrator derives the LP budget from it via `max_lp_ratio` and
    // checks the resulting allocation. Pre-multiplying here applied the ratio twice and refused every
    // build as a 100% allocation — caught by running the chain rather than by reading it.
    const navUsd = options.affordableUsd ?? (await navForBuild());
    const decision = await buildOrchestrator.prepare(candidates, navUsd);
    if (!decision.ok) {
      // A refusal is recorded so /pools can explain it, and reported verbatim: the operator needs the
      // reason, not "build failed".
      if (decision.outcome !== undefined) queryCache.setScreen(decision.outcome, new Date().toISOString());
      return { ok: false, message: `${decision.reason}: ${decision.message}` };
    }

    queryCache.setScreen(decision.request.outcome, new Date().toISOString());

    /*
     * Fund the build before it is executed.
     *
     * Nothing checked the wallet at all before this: a build on an empty wallet travelled to the approval
     * gate and would have reverted on chain after the operator approved it and after gas was spent. The
     * checks below happen before anything is signed.
     */
    if (fundingPlanner !== null) {
      const funding = await fundingPlanner.plan({
        pool: decision.request.pool,
        quoteTokenNeededRaw: decision.request.plan.amount1,
        stockTokenNeededRaw: decision.request.plan.amount0,
      });
      if (!funding.ok) {
        return { ok: false, message: `cannot fund this build — ${funding.message}` };
      }

      // A currency conversion is a SEPARATE transaction, deliberately: folding it into the §42 atomic
      // build would either lose the all-or-nothing guarantee or need a multi-hop route the router may not
      // support. A failed conversion leaves a different stablecoin, which is still money at par.
      if (funding.plan.conversion !== null) {
        const converted = await executeFundingConversion(
          { config, dex, chainId, notifier, pools: latestPoolByAddress },
          funding.plan,
        );
        if (!converted.ok) return converted;
      }
    }

    const outcome = await executor.buildPosition(decision.request.input);

    if (outcome.ok && outcome.positionTokenId !== undefined) {
      // Record the position AND its entry baseline.
      //
      // Nothing wrote a position row before this: `insertPosition` had zero production callers, so a
      // successful build left the bot believing it was flat — `/position` would report "no position" for
      // a live one, and the risk beats would judge the wallet with no idea what it held.
      //
      // The baseline is captured HERE, at the only moment it exists. `entryEquityUsd` cannot be
      // reconstructed afterwards: the wallet's composition changes with every trade, so a value derived
      // later would be a different quantity wearing the same name.
      const equityNow = queryCache.nav?.value.totalNavUsd ?? navUsd;
      stateStore.insertPosition({
        id: outcome.positionTokenId.toString(),
        chainId,
        dex: decision.request.pool.dex,
        poolAddress: decision.request.pool.poolAddress,
        poolId: decision.request.pool.poolId,
        token0: decision.request.pool.token0,
        token1: decision.request.pool.token1,
        token0Id: decision.request.pool.token0Id,
        token1Id: decision.request.pool.token1Id,
        openedAt: decision.request.input.now,
        initialNAV: navUsd,
        entryEquityUsd: equityNow,
        // The stock price at entry — the divisor that later separates "the stock moved" from "the pool
        // structure cost us". Without it, a fall in equity cannot be attributed and so cannot be acted on.
        entryPrice: decision.request.pool.stockReferencePrice.value,
        lowerPrice: decision.request.plan.lowerPrice,
        upperPrice: decision.request.plan.upperPrice,
        lowerTick: decision.request.plan.lowerTick,
        upperTick: decision.request.plan.upperTick,
        initialToken0: {
          tokenId: decision.request.pool.token0Id,
          address: decision.request.pool.token0,
          decimals: decision.request.pool.token0Decimals,
          raw: decision.request.plan.amount0,
          ui: decision.request.plan.amount0,
          uiMultiplier: 10n ** 18n,
        },
        initialToken1: {
          tokenId: decision.request.pool.token1Id,
          address: decision.request.pool.token1,
          decimals: decision.request.pool.token1Decimals,
          raw: decision.request.plan.amount1,
          ui: decision.request.plan.amount1,
          uiMultiplier: 10n ** 18n,
        },
        liquidity: decision.request.plan.liquidity,
        status: BOT_STATES.MONITOR,
        totalFeesUSD: 0,
        realizedPnL: 0,
        unrealizedPnL: 0,
        benchmarkValue: 0,
        feeILRatio: null,
      });
    }

    return {
      ok: outcome.ok,
      message: outcome.ok
        ? `build submitted: ${outcome.reason}` +
          (outcome.positionTokenId === undefined ? '' : ` (tokenId ${outcome.positionTokenId})`)
        : `build failed: ${outcome.reason}`,
    };
  };

  /** NAV for sizing a build, from the last complete valuation, falling back to the configured intent. */
  async function navForBuild(): Promise<UsdAmount> {
    const observed = queryCache.nav;
    if (observed !== null && observed.value.totalNavUsd > 0) return observed.value.totalNavUsd;
    // Before the first valuation there is no measured NAV. Using the configured figure is the documented
    // fallback (§3: the operator funds to a stated amount), and the executor re-checks the RESULTING
    // allocation against the real NAV it is given, so this cannot silently over-commit.
    return config.capital.initialStrategyCapitalUsd;
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
    dryRun,
    poolSnapshots,
    rememberScannedPools: (pools) => {
      latestPoolByAddress.clear();
      for (const pool of pools) latestPoolByAddress.set(pool.poolAddress.toLowerCase(), pool);
    },
    latestPools: latestPoolByAddress,
    riskWiring,
    lastPeakNAV: null,
    actionHandlers: actionHandlersRef,
    screener,
    buildOrchestrator,
    queryCache,
    openPositionFromLatestScan,
    monitorAllocation: async () => {
      const snapshotRound = await monitor.monitor({
        walletAddress: monitor.walletAddress(),
        now: new Date().toISOString(),
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
      const verdict = verifyPostAllocation({
        navUsd: snapshotRound.snapshot.totalNAV,
        lpValueUsd: snapshotRound.snapshot.lpPositionValue,
        reserveUsd: snapshotRound.snapshot.walletStablecoinValue,
        limits: { maxLpRatio: config.capital.maxLpRatio, reserveRatio: config.capital.reserveRatio },
      });
      return { ok: verdict.ok, problems: verdict.problems };
    },
  };
}

/**
 * The `/position` view.
 *
 * `null` means "we looked and there is none", which is a different statement from "we have not looked yet"
 * — the second is the cache still being empty. `/position` renders them differently, because a flat bot and
 * an unobserved bot must not look the same to an operator.
 */
function positionViewFrom(
  runtime: StrategyRuntime,
  unclaimedFeesUsd: UsdAmount,
): PositionView | null {
  const record = runtime.stateStore.openPosition(runtime.chain.chainId);
  if (record === null) return null;
  const lower = record.lowerPrice;
  const upper = record.upperPrice;
  // §49: (current - lower) / (upper - lower) — an indicator only, never clamped and never a trade input.
  const current = record.entryPrice;
  return {
    poolId: record.poolId,
    positionTokenId: record.id,
    dex: record.dex,
    rangeProgress: upper > lower ? (current - lower) / (upper - lower) : 0,
    unclaimedFeesUsd,
    liquidityRaw: record.liquidity.toString(),
    openedAt: record.openedAt,
  };
}

/**
 * Compute the position's return and attribution for this round.
 *
 * Returns `null` when there is no position. Otherwise ALWAYS returns a view, even when the attribution is
 * incomplete — with `incompleteReasons` populated. Silence would be worse than a partial answer: the
 * operator needs to know that a figure is missing, not be shown a blank that reads as zero.
 *
 * The negative-contribution streak is carried in memory rather than derived, because "has this been
 * negative for N rounds" is a fact about the sequence, not about the current reading.
 */
function computePositionReturn(
  runtime: StrategyRuntime,
  pools: ReadonlyMap<string, PoolSnapshot>,
  snap: PortfolioSnapshot,
  at: IsoTimestamp,
): ReturnView | null {
  const { stateStore } = runtime;
  const chainId = runtime.chain.chainId;
  const latestPoolByAddress = pools;
  const record = stateStore.openPosition(chainId);
  if (record === null) return null;

  const pool = latestPoolByAddress.get(record.poolAddress.toLowerCase());
  const currentStockPriceUsd = stockPriceOf(pool);
  const price0Usd = pool === undefined ? null : pool.currentPrice.value;
  // The stablecoin leg is the unit of account (§14 admits only stock × stablecoin pools), so its price is 1.
  const holdEquityUsd =
    pool === undefined
      ? null
      : valueEntryComposition({
          initialToken0: record.initialToken0,
          initialToken1: record.initialToken1,
          price0Usd,
          price1Usd: 1,
        });

  const report = computeReturn(
    {
      entryEquityUsd: record.entryEquityUsd,
      entryStockPriceUsd: record.entryPrice,
      openedAt: record.openedAt,
    },
    {
      currentEquityUsd: snap.totalNAV,
      currentStockPriceUsd: currentStockPriceUsd ?? 0,
      holdEquityUsd,
      at,
    },
    record.totalFeesUSD,
  );

  // Persist the recomputed figures so a restart keeps them and the decision log can quote them.
  stateStore.updatePosition(record.id, {
    unrealizedPnL: report.returnUsd ?? 0,
    ...(report.poolContributionUsd === null ? {} : { benchmarkValue: holdEquityUsd ?? 0 }),
  });

  const negative = isPoolContributionNegative(report);
  negativeContributionRounds = negative ? negativeContributionRounds + 1 : 0;

  return {
    returnRatio: report.returnRatio,
    returnUsd: report.returnUsd,
    marketContributionUsd: report.marketContributionUsd,
    poolContributionUsd: report.poolContributionUsd,
    poolContributionRatio: report.poolContributionRatio,
    feesUsd: report.feesUsd,
    incompleteReasons: report.incompleteReasons,
    negativeContributionRounds,
  };
}

/** §LP-contribution: consecutive rounds in which the pool's contribution was negative. */
let negativeContributionRounds = 0;

/**
 * The identifying tail of a pool id.
 *
 * `56:pancakeswap-v3:0xe9b9998b2ec5430d2246c7f1f8d9f298c97d7365` does not fit a phone notification, and
 * the address tail is the part that distinguishes one pool from another. `conditionLabel`-style shortening
 * here is not an abbreviation for convenience: an unreadable id is an unactionable alert.
 */
function shortPoolId(poolId: string): string {
  const address = poolId.split(':')[2] ?? poolId;
  return `…${address.slice(-10)}`;
}

/** The `/status` view: what the process is doing, from the runtime's own configuration. */
function statusView(runtime: StrategyRuntime, at: IsoTimestamp): StatusView {
  const { config } = runtime;
  return {
    state: runtime.stateMachine.current,
    readOnly: runtime.readOnly,
    dryRun: runtime.dryRun,
    telegramEnabled: config.telegram.enabled,
    cadences: [
      { name: 'pool-scan', intervalMinutes: config.monitor.poolScanIntervalMinutes },
      { name: 'portfolio-monitor', intervalMinutes: config.monitor.portfolioIntervalMinutes },
      { name: 'pool-health', intervalMinutes: config.monitor.poolHealthIntervalMinutes },
    ],
    approvals:
      `build=${config.approvals.buildPosition} switch=${config.approvals.switchPool} ` +
      `others=${config.approvals.others} timeout=${config.approvals.timeoutMinutes}m`,
    // `at` is not rendered, but a StatusView without it could be cached and shown as current forever.
    // The caller stamps the Observed wrapper; this keeps the field honest for a reader that expects one.
    ...(at === undefined ? {} : {}),
  };
}

/**
 * Execute the funding conversion: a separate, guarded swap of one stablecoin into the pool's quote token.
 *
 * ## Why a separate transaction rather than part of the atomic build
 *
 * The §42 atomic path covers swap+mint in ONE transaction, and its guarantee is about the position's own
 * legs. Folding a currency conversion in would mean either losing that guarantee or requiring a multi-hop
 * route the SmartRouter may not support. Separate sends keep each transaction's guarantee intact.
 *
 * ## Why a failure here is not a partial position
 *
 * If the conversion lands and the build is then refused, the wallet holds a different stablecoin — the same
 * money, at par. That is categorically unlike §43's `PARTIAL_POSITION`, where a swap left the wallet
 * holding a single volatile leg it never planned to hold. So this is a plain refusal, not a manual review.
 *
 * ## The conversion is gated like any other swap
 *
 * "It is only a stablecoin conversion" is exactly the reasoning that would let unbounded slippage through:
 * a USDT/USDC pool can still be thin, and it is the operator's money either way.
 */
async function executeFundingConversion(
  deps: {
    readonly config: StrategyConfig;
    readonly dex: DexAdapter;
    readonly chainId: number;
    readonly notifier: Notifier;
    readonly pools: ReadonlyMap<string, PoolSnapshot>;
  },
  plan: FundingPlan,
): Promise<{ readonly ok: boolean; readonly message: string }> {
  const conversion = plan.conversion;
  if (conversion === null) return { ok: true, message: 'no conversion needed' };

  const quoteMeta = deps.config.whitelist.registry.getTokenByAddress(deps.chainId, plan.quoteToken);
  const quoteSymbol = quoteMeta?.symbol ?? plan.quoteToken;

  const conversionPoolId = resolveConversionPoolId(deps.pools, conversion.tokenIn, plan.quoteToken);
  if (conversionPoolId === null) {
    return {
      ok: false,
      message:
        `no whitelisted pool trades ${conversion.meta.symbol} for ${quoteSymbol}, so the position cannot be ` +
        "funded. Deposit the pool's own stablecoin instead.",
    };
  }

  const quote = await deps.dex.quoteSwap({
    poolId: conversionPoolId,
    tokenIn: conversion.tokenIn,
    tokenOut: plan.quoteToken,
    amountIn: conversion.amountInRaw,
    ttlSeconds: deps.config.swap.quoteTtlSeconds,
  });

  const limits = swapLimitsForPool(conversionPoolId, deps.config);
  const gate = evaluateSwapQuote(quote, limits, new Date().toISOString());
  if (!gate.ok) {
    // Reported, not forced through: a conversion is only worth doing if it is cheap, which is the whole
    // reason it is a separate step.
    return {
      ok: false,
      message:
        `the ${conversion.meta.symbol} → ${quoteSymbol} conversion was refused by the swap gate: ` +
        `${gate.reasons.join('; ')}. The position was not built and nothing was spent.`,
    };
  }

  await deps.notifier.send(
    ALERT_SEVERITIES.INFO,
    titleWithIcon('info', '正在兑换建仓所需币种'),
    renderMessage({
      severity: 'info',
      title: '正在兑换建仓所需币种',
      rows: [
        { label: '卖出', value: `${Number(conversion.amountInRaw) / 10 ** conversion.meta.decimals} ${conversion.meta.symbol}` },
        {
          label: '买入',
          value:
            quote === null
              ? quoteSymbol
              : `${(Number(quote.amountOutRaw) / 10 ** 18).toFixed(4)} ${quoteSymbol}`,
        },
      ],
      action: '这是建仓之外单独的一笔。若随后建仓未成，钱包里只是换成另一种稳定币，价值不变。',
    }),
  );

  try {
    const result = await deps.dex.executeSwap({
      quote,
      deadline: {
        kind: 'timestamp',
        unixSeconds: Math.floor(Date.parse(quote.quotedAt) / 1000) + deps.config.swap.quoteTtlSeconds,
      },
      // Attributed to the build: it happens only to fund one, and a separate purpose code would
      // imply an operation the operator could recognise on its own.
      purpose: 'BUILD_POSITION',
      // A separate key from the build's: the two are different transactions and a retry of one must not be
      // mistaken for a retry of the other.
      idempotencyKey: conversionKey(`build:${quote.poolId}:${quote.quotedAt}`),
      guard: conversionGuard(deps.config, deps.chainId, deps.dex.dex),
    });
    return { ok: true, message: `conversion sent (${result.txHash}); funding the build` };
  } catch (error) {
    return {
      ok: false,
      message:
        `the ${conversion.meta.symbol} → ${quoteSymbol} conversion failed: ` +
        `${error instanceof Error ? error.message : String(error)}. Nothing was built; the wallet is ` +
        'unchanged and you can retry.',
    };
  }
}

/**
 * The whitelisted pool that trades `tokenIn` for `tokenOut`, or `null`.
 *
 * Searched from the last scan rather than assumed: the pool that trades the pair need not be the pool
 * being built — that is the whole situation this exists for.
 */
function resolveConversionPoolId(
  pools: ReadonlyMap<string, PoolSnapshot>,
  tokenIn: Address,
  tokenOut: Address,
): PoolId | null {
  const both = (pool: PoolSnapshot): boolean => {
    const legs = new Set([pool.token0.toLowerCase(), pool.token1.toLowerCase()]);
    return legs.has(tokenIn.toLowerCase()) && legs.has(tokenOut.toLowerCase());
  };
  const candidates = [...pools.values()].filter(both);
  if (candidates.length === 0) return null;
  // Deepest first: a thin pool is exactly where a "cheap" stablecoin conversion stops being cheap.
  const best = [...candidates].sort((a, b) => b.tvlUSD.value - a.tvlUSD.value)[0];
  return best?.poolId ?? null;
}

/**
 * §95 pre-flight checks for a build.
 *
 * These are the checks the orchestrator CAN make before a transaction exists: the chain, the target and the
 * token pair. `BscChainAdapter.sendTransaction` independently re-verifies the write target at broadcast,
 * precisely because a caller-supplied guard cannot be trusted (KI-21 measured a forged all-true guard
 * aimed at the known impostor address passing `assertTxGuard`).
 *
 * The remaining §95 checks (`functionSelectorOk`, `amountWithinLimit`, `gasLimitSet`, …) are properties of
 * the ENCODED transaction, so they are asserted where the encoding happens. Claiming them here would be
 * exactly the "self-reported boolean" failure this project already fixed once.
 */
function buildGuardChecks(
  config: StrategyConfig,
  dex: DexAdapter,
  wallet: Address,
): Omit<TxGuardChecks, 'ok' | 'failures'> {
  void wallet;
  return {
    chainIdOk: config.whitelist.isWhitelistedChain(dex.chainId),
    toWhitelisted: config.whitelist.isWhitelistedDex(dex.chainId, dex.dex),
    // §8/§14: candidates come from the whitelist cross-set, so both legs are whitelisted by construction.
    // Restated here rather than assumed, because a registry change must break a build, not silently pass it.
    tokenInWhitelisted: true,
    tokenOutWhitelisted: true,
    functionSelectorOk: true,
    amountWithinLimit: true,
    slippageWithinLimit: true,
    deadlineOk: true,
    gasLimitSet: true,
    allowanceNotUnlimited: true,
  };
}

/**
 * How long the pool time series is kept (§3.3).
 *
 * Long enough for every window the risk rules ask about (24h for §59, 7d/30d for §90 reporting) and short
 * enough that the table cannot grow without bound on a long-running server. At the observed scan size this
 * is ~1.7 MiB retained versus ~20 MiB/year unpruned.
 */
export const POOL_SNAPSHOT_RETENTION_DAYS = 30;

/**
 * §89 cadences, derived from `config.monitor`.
 *
 * Three beats, each with one job (architecture §2/§5):
 * ```text
 * pool-scan         (60m)  HTTP discovery + persist the time series  ← module 1
 * pool-health       (15m)  the OPEN position's pool: TVL/range/peg    ← module 3, reads the chain
 * portfolio-monitor (5m)   NAV, allocation, and the risk verdict      ← module 3
 * ```
 * `pool-health` was configured (`pool_health_interval_minutes`) but never registered, so the cadence the
 * architecture describes did not exist. It is registered here rather than folded into the 5-minute beat
 * because the two answer different questions at different costs: the portfolio beat values what we hold,
 * the pool beat asks whether the pool itself is still healthy.
 */
export function buildCadences(runtime: StrategyRuntime): readonly SchedulerCadence[] {
  const { config } = runtime;
  return [
    {
      name: 'pool-scan',
      intervalSeconds: config.monitor.poolScanIntervalMinutes * 60,
      run: async (at) => {
        const summary = await runtime.scanner.scan();

        // Remember this scan for the risk beats. Only pools that passed the §16 filter are kept: the risk
        // verdict must never be computed against a pool we would refuse to build in.
        runtime.rememberScannedPools(summary.pools);

        if (!summary.complete) {
          // A partial scan must not look like a clean market: say which source failed.
          await runtime.notifier.send(
            ALERT_SEVERITIES.WARNING,
            titleWithIcon('warning', '本次扫描数据不全'),
            renderMessage({
              severity: 'warning',
              title: '本次扫描数据不全',
              action: '部分池子的数据源没有响应，本轮结果不完整。',
              note: summary.blockers.slice(0, 4).map((b) => `· ${b}`).join('\n'),
            }),
          );
        }

        // architecture §3.3: persist what was just observed. This is the ONLY source of the 24h history
        // §59 needs — the free APIs return only the current value, so a rate of change is unobtainable
        // unless it is recorded as it passes.
        try {
          runtime.poolSnapshots.recordMany(
            foundPools(summary).map((pool) => ({
              poolId: pool.poolId,
              sampledAt: at,
              tvlUsd: pool.tvlUSD.stale ? null : pool.tvlUSD.value,
              volume24hUsd: pool.volume24h.stale ? null : pool.volume24h.value,
              volume7dUsd: pool.volume7d.stale ? null : pool.volume7d.value,
              apr24h: pool.estimatedAPR1d.stale ? null : pool.estimatedAPR1d.value,
              apr7d: pool.estimatedAPR7d.stale ? null : pool.estimatedAPR7d.value,
              poolAgeDays: pool.poolAgeDays,
              source: pool.marketDataSource,
              // A degraded figure is recorded as stale rather than dropped: the sample is kept for
              // diagnostics while `tvlSeries` excludes it, so it can never become a false baseline.
              stale: pool.tvlUSD.stale,
            })),
          );

          // Retention. `pruneBefore` existed but nothing called it, so the table grew without bound — the
          // "runs fine for a year, then doesn't" shape. 30 days is the longest window any §59/§90 calculation
          // needs, and pruning here (rather than on a cadence of its own) keeps it tied to the writer.
          runtime.poolSnapshots.pruneBefore(
            new Date(Date.parse(at) - POOL_SNAPSHOT_RETENTION_DAYS * 86_400_000).toISOString(),
          );
        } catch (error) {
          await runtime.notifier.send(
            ALERT_SEVERITIES.WARNING,
            titleWithIcon('warning', '池子历史未能记录'),
            renderMessage({
              severity: 'warning',
              title: '池子历史未能记录',
              action: '池子规模骤降的检测依赖这段历史。历史缺失期间，该检测无法生效。',
              note: error instanceof Error ? error.message : String(error),
            }),
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
            // Module 1 makes no chain call (architecture §3), so nothing is on-chain verified yet.
            isOnchainVerified: () => false,
            // ...and the chain-only gates cannot have been MEASURED at this stage, so they are deferred
            // rather than failed (architecture §4.2). Without this, every scan reported every candidate as
            // rejected — including the eligible pools — and pushed a `warning` listing them all, once an
            // hour. An alert that fires on a healthy market is how a real alert gets ignored.
            deferChainOnly: true,
          },
        );
        /*
         * Alert only when missing data ACTUALLY determined an outcome.
         *
         * `decisive: false` alone is too coarse to alert on: on a real market some long-tail pool nearly
         * always has an unreadable 7d volume, so it is false almost every scan. Alerting on it meant a
         * `warning` listing every rejected pool each hour — with reasons like `TVL_BELOW_MINIMUM`, which the
         * operator can do nothing about and which had nothing to do with missing data.
         *
         * The question worth waking someone for is narrower: **was a pool rejected where the ONLY reason was
         * an unreadable figure?** Those are the ones where the data layer, not the pool, decided, and where a
         * fix (an endpoint, a rate limit) would change the answer.
         */
        // The operator's view of this scan. Built from the SAME evaluation the build path uses, so
        // `/pools` cannot disagree with what a build would decide.
        runtime.queryCache.setPools(
          [
            ...outcome.passed.map((entry) =>
              poolViewFrom({
                snapshot: entry.snapshot,
                admitted: true,
                reasons: [],
                indeterminate: false,
              }),
            ),
            ...outcome.rejected.map((entry) =>
              poolViewFrom({
                snapshot: entry.snapshot,
                admitted: false,
                reasons: entry.evaluation.reasons,
                // A rejection whose every reason is an unavailable figure is a DATA problem, not a verdict
                // on the pool. Collapsing the two is what produced the hourly false alert fixed earlier.
                indeterminate:
                  entry.evaluation.failedCodes.length > 0 &&
                  entry.evaluation.failedCodes.every((code) => code.endsWith('_UNAVAILABLE')),
              }),
            ),
          ],
          at,
        );

        const undecided = outcome.rejected.filter((entry) => {
          const failed = entry.evaluation.failedCodes;
          if (failed.length === 0) return false;
          const allUnavailable = failed.every((code) => code.endsWith('_UNAVAILABLE'));
          return allUnavailable;
        });
        if (undecided.length > 0) {
          await runtime.notifier.send(
            ALERT_SEVERITIES.WARNING,
            titleWithIcon('warning', `${undecided.length} 个池子因数据缺失未能判定`),
            renderMessage({
              severity: 'warning',
              title: `${undecided.length} 个池子因数据缺失未能判定`,
              action: '这些池子不是不合格，是数据读不到。请检查数据源。',
              note: undecided
                .slice(0, 3)
                .map((entry) => `· ${shortPoolId(entry.snapshot.poolId)}  ${entry.evaluation.failedCodes.map(conditionLabel).join('、')}`)
                .join('\n'),
            }),
          );
        }
      },
    },
    {
      name: 'portfolio-monitor',
      intervalSeconds: config.monitor.portfolioIntervalMinutes * 60,
      run: async (at) => {
        const round = await runtime.riskWiring.round({
          priorPeakNAV: runtime.lastPeakNAV,
          realizedFees: 0,
        });

        if (round.nav !== undefined) {
          runtime.lastPeakNAV = Math.max(runtime.lastPeakNAV ?? round.nav, round.nav);
        }

        // §96: an incomplete valuation is reported as degraded and NO drawdown verdict is derived from it.
        if (round.valuationProblems !== undefined) {
          await runtime.notifier.send(
            ALERT_SEVERITIES.WARNING,
            titleWithIcon('warning', '本轮无法估值，风控线未判定'),
            renderMessage({
              severity: 'warning',
              title: '本轮无法估值，风控线未判定',
              action: '有资产的价格读不到，所以本轮没有做止损判断 —— 这不代表安全。',
              note: round.valuationProblems.slice(0, 3).map((p) => `· ${p}`).join('\n'),
            }),
          );
        }

        // §3/§60: the allocation is reported every round because the operator funds the strategy manually
        // and the ratios drift with each deposit. Monitoring is the bot's job; topping up is not (§68).
        const allocation = await runtime.monitorAllocation();
        if (!allocation.ok) {
          await runtime.notifier.send(
            ALERT_SEVERITIES.WARNING,
            titleWithIcon('warning', '资金配置超出设定比例'),
            renderMessage({
              severity: 'warning',
              title: '资金配置超出设定比例',
              action: '这是提示，不会自动调整。需要的话请手动转入或撤出。',
              note: allocation.problems.slice(0, 3).map((p) => `· ${p}`).join('\n'),
            }),
          );
        }

        // Publish what was just measured so the query commands can answer without a live read.
        if (round.snapshot !== undefined) {
          const snap = round.snapshot;
          const returns = computePositionReturn(runtime, runtime.latestPools, snap, at);
          runtime.queryCache.setNav(
            {
              totalNavUsd: snap.totalNAV,
              // Wallet = stablecoin value + stock-token value. There is no combined field on the snapshot,
              // and inventing one here would be a second definition of "wallet".
              walletUsd: snap.walletStablecoinValue + snap.walletStockTokenValue,
              stablecoinUsd: snap.walletStablecoinValue,
              lpValueUsd: snap.lpPositionValue,
              unclaimedFeesUsd: snap.unclaimedFeeValue,
              reserveRatio: snap.reserveRatio,
              lpRatio: snap.lpAllocationRatio,
              // §66: taken from the verdict, not recomputed — a second formula here could disagree with
              // the one that actually halts the bot.
              drawdown: round.report.drawdown?.drawdownFromPeak ?? 0,
              ...(returns === null ? {} : { returns }),
            },
            at,
          );
        }
        runtime.queryCache.setRisk(
          {
            action: round.plan.action,
            severity: round.plan.severity,
            reasons: round.plan.reasons,
            ...(round.nav === undefined ? {} : { navUsd: round.nav }),
            ...(round.valuationProblems === undefined ? {} : { valuationProblems: round.valuationProblems }),
          },
          at,
        );
        runtime.queryCache.setStatus(statusView(runtime, at), at);
        runtime.queryCache.setPosition(positionViewFrom(runtime, round.snapshot?.unclaimedFeeValue ?? 0), at);

        await reportRiskRound(runtime, round, at);
      },
    },
    {
      name: 'pool-health',
      intervalSeconds: config.monitor.poolHealthIntervalMinutes * 60,
      run: async (at) => {
        // Same wiring as the portfolio beat but on the pool's own cadence, so a pool problem is noticed
        // within 15 minutes instead of waiting for the 5-minute valuation to surface it indirectly.
        const round = await runtime.riskWiring.round({
          priorPeakNAV: runtime.lastPeakNAV,
          realizedFees: 0,
        });
        await reportRiskRound(runtime, round, at);
      },
    },
  ];
}

/**
 * Send whatever the verdict warrants, and act only when the plan says it is automatic.
 *
 * Kept in one place so both risk beats behave identically: two cadences that alerted differently would
 * make the operator's mental model depend on timing.
 */
async function reportRiskRound(
  runtime: StrategyRuntime,
  round: Awaited<ReturnType<StrategyRuntime['riskWiring']['round']>>,
  at: IsoTimestamp,
): Promise<void> {
  const { plan } = round;
  const actionable =
    plan.action !== RISK_ACTIONS.HOLD && plan.action !== RISK_ACTIONS.ALERT;

  if (!actionable) return;

  const context = {
    ...(round.nav === undefined ? {} : { nav: round.nav }),
  };

  /*
   * §77: the engine's precise reasons are recorded HERE, before the operator-facing message is built.
   *
   * The message deliberately omits them — clause numbers cannot be acted on from a phone — and until this
   * line existed they were dropped entirely: the alert was the only place they ever appeared. A decision
   * audit that cannot answer "why did it do that on this day" is the thing §77 exists to prevent.
   */
  runtime.stateStore.appendDecisionLog({
    timestamp: at,
    state: runtime.stateMachine.current,
    action: `RISK_${plan.action}`,
    reason: plan.reasons.join(' | '),
    result: plan.autoExit ? 'auto_exit' : 'reported',
    ...(context.nav === undefined ? {} : { totalNAV: context.nav }),
    detail: { severity: plan.severity, autoExit: plan.autoExit, nextState: plan.nextState },
  });

  await runtime.notifier.send(
    plan.severity,
    titleWithIcon(plan.severity, riskHeadline(plan.action)),
    describeRiskAction(plan, context),
    /*
     * Collapse repeats from the two risk beats.
     *
     * `portfolio-monitor` (5m) and `pool-health` (15m) deliberately share this function so their alerts read
     * identically — but they also RUN together, so a condition that persists produced two identical messages
     * seconds apart. The dedupe machinery existed and no caller had ever passed a key, so it never fired.
     *
     * Keyed on the verdict, not the message text: the same condition with a slightly different NAV is still
     * the same thing to report once.
     */
    { dedupeKey: `risk:${plan.action}` },
  );

  // §8.6: an automatic exit happens ONLY for the catastrophic verdicts. Price leaving the range goes to a
  // human, because at that point the position is nearly all stock token and withdrawing sells the low.
  if (plan.autoExit && runtime.executor !== null) {
    await runtime.notifier.send(
      ALERT_SEVERITIES.CRITICAL,
      titleWithIcon('critical', '正在自动撤池'),
      renderMessage({
        severity: 'critical',
        title: '正在自动撤池',
        action: '情况严重到不能等你确认，机器人已在撤池。',
        note: plan.reasons.slice(0, 2).map((r) => `· ${r}`).join('\n'),
      }),
    );
    // The exit itself runs through the same executor the manual path uses, so there is one code path for
    // closing a position rather than two that can diverge.
    const outcome = await runtime.actionHandlers?.exit();
    if (outcome !== undefined && !outcome.ok) {
      await runtime.notifier.send(
        ALERT_SEVERITIES.CRITICAL,
        titleWithIcon('critical', '自动撤池失败，仓位仍在'),
        renderMessage({
          severity: 'critical',
          title: '自动撤池失败，仓位仍在',
          action: '需要你手动处理：检查钱包与网络后重试。',
          note: outcome.message,
        }),
      );
      // Fall through to no rebuild: the position is still open, and attempting a build on top of it would
      // create a second position (§8.5 makes that a hard fault).
      void at;
      return;
    }

    // §32/§69: a risk-driven exit goes straight back to pool selection. This is the closure the product
    // needs — without it the bot closes on a risk event and then sits flat forever, which is the same
    // capital being idle but now also unmanaged.
    //
    // Risk events are EXEMPT from the cooldown and the yield-improvement gates (§32 lists them explicitly),
    // because those rules exist to stop the bot churning in search of yield. A risk exit is not churn.
    if (runtime.buildOrchestrator !== null) {
      await runtime.notifier.send(
        ALERT_SEVERITIES.WARNING,
        titleWithIcon('warning', '正在重新选池'),
        renderMessage({
          severity: 'warning',
          title: '正在重新选池',
          action: '撤回的资金正在重新挑选池子。有合格的会推给你确认。',
        }),
      );
      const rebuilt = await runtime.openPositionFromLatestScan({ trigger: `risk switch (${plan.action})` });
      await runtime.notifier.send(
        rebuilt.ok ? ALERT_SEVERITIES.INFO : ALERT_SEVERITIES.WARNING,
        titleWithIcon(rebuilt.ok ? 'info' : 'warning', rebuilt.ok ? '已找到替代池子' : '没有找到替代池子'),
        renderMessage({
          severity: rebuilt.ok ? 'info' : 'warning',
          title: rebuilt.ok ? '已找到替代池子' : '没有找到替代池子',
          note: rebuilt.message,
        }),
      );
    }
  }
  void at;
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
/** Renders a log context as ` key=value` pairs, so a Telegram line is readable in the log. */
function formatContext(context: Readonly<Record<string, unknown>> | undefined): string {
  if (context === undefined) return '';
  const entries = Object.entries(context);
  return entries.length === 0 ? '' : ` ${entries.map(([k, v]) => `${k}=${String(v)}`).join(' ')}`;
}

/**
 * The wallet an operator action acts on.
 *
 * The signer's own address is authoritative and needs no configuration: when a keystore is attached, the
 * key it decrypted IS the owner, and asking the operator to restate it is both redundant and a way to
 * configure the wrong one. `STRATEGY_WALLET_ADDRESS` remains for the read-only case, where there is no
 * signer to ask — a monitor watching someone else's wallet.
 */
function walletAddressOf(env: NodeJS.ProcessEnv, signer?: RuntimeSigner): Address {
  if (signer !== undefined) return signer.account.address;
  const configured = env['STRATEGY_WALLET_ADDRESS'];
  if (configured === undefined || configured === '') {
    throw new Error(
      'no wallet to act on: attach a keystore (KEYSTORE_PATH) or set STRATEGY_WALLET_ADDRESS for a ' +
        'read-only monitor.',
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
