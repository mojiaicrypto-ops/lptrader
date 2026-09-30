import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ChainId, DexId } from '../types/primitives.ts';
import type { TokenMeta } from '../types/token.ts';
import type { PoolOverrideConfig, StrategyConfig } from '../types/config.ts';
import { WhitelistError, type Whitelist, type WhitelistDexEntry } from '../types/registry.ts';
import {
  strategyFileSchema,
  stablecoinsFileSchema,
  tokensFileSchema,
  type StrategyConfigYaml,
  type StrategyYaml,
  type TokenEntryYaml,
} from './schema.ts';
import {
  BSC_DEX_CONTRACTS,
  BUILTIN_TOKENS,
  SUPPORTED_CHAINS,
  WHITELIST_DEXES,
} from './builtins.ts';
import { InMemoryTokenRegistry, mergeTokensWithOverrides, type TokenOverride } from './registry.ts';

export * from './schema.ts';
export * from './builtins.ts';
export * from './registry.ts';

/** Default location of the three YAML files, relative to the repository root. */
export const CONFIG_DIR_NAME = 'config';
export const STRATEGY_FILE_NAME = 'strategy.yaml';
export const TOKENS_FILE_NAME = 'tokens.yaml';
export const STABLECOINS_FILE_NAME = 'stablecoins.yaml';

export interface LoadConfigOptions {
  /** Directory holding the YAML files; defaults to `<cwd>/config`. */
  readonly configDir?: string;
  /** Repository root, only used to resolve the default config dir. */
  readonly cwd?: string;
  /** Skip disk access entirely and use builtin defaults + no overrides (tests / smoke runs). */
  readonly useBuiltinsOnly?: boolean;
}

/** Thrown for any configuration problem that must abort startup (fail closed, §96). */
export class ConfigError extends Error {
  readonly file?: string;

  constructor(message: string, file?: string) {
    super(message);
    this.name = 'ConfigError';
    this.file = file;
  }
}

async function readYamlFile(filePath: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    throw new ConfigError(
      `cannot read ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      filePath,
    );
  }
  try {
    return parseYaml(text);
  } catch (error) {
    throw new ConfigError(
      `invalid YAML in ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      filePath,
    );
  }
}

function formatIssues(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  return issues
    .map((issue) => `${issue.path.map(String).join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
}

/** Parse + validate `strategy.yaml` text (exported for tests). */
export function parseStrategyYaml(text: string, file = STRATEGY_FILE_NAME): StrategyYaml {
  const raw = parseYaml(text) as unknown;
  const result = strategyFileSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(`invalid strategy config (${formatIssues(result.error.issues)})`, file);
  }
  return result.data;
}

/**
 * §40 resolve per-pool execution tolerances, validating each against the §16 admission threshold.
 *
 * Validation happens here (at startup) rather than at the trade gate for two reasons:
 *  - a configuration whose tolerance is BELOW the admission threshold is contradictory — the pool could
 *    not have been admitted under a looser rule while the execution is stricter — and silently accepting
 *    it would make the effective limit depend on which check ran first;
 *  - a malformed key (not a §13 pool identity) would otherwise never match a pool and be silently dead.
 *
 * Widening ABOVE the admission threshold is the supported direction and is what the user asked for
 * (e.g. a 1% tolerance on a pool admitted at 0.5%).
 */
export function buildPoolOverrides(
  pool: { readonly max_swap_price_impact: number },
  swap: { readonly max_slippage: number; readonly max_price_impact: number },
  overrides: Readonly<Record<string, { readonly max_slippage?: number; readonly max_price_impact?: number }>>,
): Readonly<Record<string, PoolOverrideConfig>> {
  const resolved: Record<string, PoolOverrideConfig> = {};
  for (const [poolId, override] of Object.entries(overrides)) {
    // §13 identity is `chainId:dex:poolAddress`; anything else can never match a pool at runtime.
    const parts = poolId.split(':');
    if (parts.length !== 3 || !/^\d+$/.test(parts[0] ?? '') || !/^0x[0-9a-fA-F]{40}$/.test(parts[2] ?? '')) {
      throw new ConfigError(
        `pool_overrides key "${poolId}" is not a §13 pool identity (expected chainId:dex:poolAddress)`,
        STRATEGY_FILE_NAME,
      );
    }
    const slippage = override.max_slippage ?? swap.max_slippage;
    const impact = override.max_price_impact ?? swap.max_price_impact;
    if (slippage < pool.max_swap_price_impact) {
      throw new ConfigError(
        `pool_overrides["${poolId}"].max_slippage ${slippage} is below the §16 admission threshold ` +
          `${pool.max_swap_price_impact}; an execution tolerance stricter than admission is contradictory`,
        STRATEGY_FILE_NAME,
      );
    }
    if (impact < pool.max_swap_price_impact) {
      throw new ConfigError(
        `pool_overrides["${poolId}"].max_price_impact ${impact} is below the §16 admission threshold ` +
          `${pool.max_swap_price_impact}; widen it, or the pool should simply not be admitted`,
        STRATEGY_FILE_NAME,
      );
    }
    resolved[poolId] = { maxSlippage: slippage, maxPriceImpact: impact };
  }
  return resolved;
}

/** Parse + validate `tokens.yaml` and `stablecoins.yaml` into address-keyed overrides. */
export function parseTokenOverrides(
  tokensText: string | null,
  stablecoinsText: string | null,
): TokenOverride[] {
  const overrides: TokenOverride[] = [];

  if (tokensText !== null) {
    const result = tokensFileSchema.safeParse(parseYaml(tokensText) as unknown);
    if (!result.success) {
      throw new ConfigError(
        `invalid tokens config (${formatIssues(result.error.issues)})`,
        TOKENS_FILE_NAME,
      );
    }
    overrides.push(...result.data.tokens.map((entry) => toOverride(entry, false)));
  }

  if (stablecoinsText !== null) {
    const result = stablecoinsFileSchema.safeParse(parseYaml(stablecoinsText) as unknown);
    if (!result.success) {
      throw new ConfigError(
        `invalid stablecoins config (${formatIssues(result.error.issues)})`,
        STABLECOINS_FILE_NAME,
      );
    }
    overrides.push(...result.data.stablecoins.map((entry) => toOverride(entry, true)));
  }

  return overrides;
}

function toOverride(entry: TokenEntryYaml, fromStablecoinsFile: boolean): TokenOverride {
  return {
    chainId: entry.chain_id,
    address: entry.contract,
    symbol: entry.symbol,
    ...(entry.name === undefined ? {} : { name: entry.name }),
    ...(entry.decimals === undefined ? {} : { decimals: entry.decimals }),
    ...(entry.risk_tier === undefined ? {} : { riskTier: entry.risk_tier }),
    ...(entry.auto_trade === undefined ? {} : { autoTrade: entry.auto_trade }),
    ...(entry.notes === undefined ? {} : { notes: entry.notes }),
    ...('priority' in entry && typeof entry.priority === 'number'
      ? { stablecoinPriority: entry.priority }
      : {}),
    fromStablecoinsFile,
  };
}

/**
 * Build the whitelist from builtins + validated overrides and the chain/DEX whitelist block.
 * A DEX entry on a non-whitelisted chain is an error rather than being silently ignored.
 */
export function createWhitelist(
  tokens: readonly TokenMeta[],
  chains: readonly ChainId[],
  dexes: readonly WhitelistDexEntry[],
): Whitelist {
  const registry = new InMemoryTokenRegistry(tokens);
  const chainSet = new Set(chains);
  const dexKey = (chainId: ChainId, dex: DexId): string => `${chainId}:${dex}`;
  const dexSet = new Set(dexes.map((entry) => dexKey(entry.chainId, entry.dex)));

  for (const entry of dexes) {
    if (!chainSet.has(entry.chainId)) {
      throw new WhitelistError(
        `DEX whitelist entry ${entry.dex} references chain ${entry.chainId}, which is not in the ` +
          `chain whitelist (${chains.join(', ')})`,
        { chainId: entry.chainId, dex: entry.dex },
      );
    }
  }

  return {
    chains,
    dexes,
    registry,
    isWhitelistedChain: (chainId) => chainSet.has(chainId),
    isWhitelistedDex: (chainId, dex) => dexSet.has(dexKey(chainId, dex)),
    assertWhitelistedChain(chainId) {
      if (!chainSet.has(chainId)) {
        throw new WhitelistError(`chain ${chainId} is not whitelisted (§11)`, { chainId });
      }
    },
    assertWhitelistedDex(chainId, dex) {
      if (!dexSet.has(dexKey(chainId, dex))) {
        throw new WhitelistError(`DEX ${dex} is not whitelisted on chain ${chainId} (§12)`, {
          chainId,
          dex,
        });
      }
    },
    assertWhitelistNonEmpty() {
      registry.assertNonEmpty();
    },
    getTokenByAddress(chainId, address) {
      return registry.getTokenByAddress(chainId, address);
    },
    requireTokenByAddress(chainId, address) {
      return registry.requireTokenByAddress(chainId, address);
    },
  };
}

/** Default DEX whitelist when the YAML omits `whitelist.dexes`. */
export function defaultDexWhitelist(chains: readonly ChainId[]): WhitelistDexEntry[] {
  const entries: WhitelistDexEntry[] = [];
  for (const chainId of chains) {
    if (chainId === 56) {
      for (const dex of WHITELIST_DEXES) {
        if (dex in BSC_DEX_CONTRACTS) {
          entries.push({ chainId, dex });
        }
      }
    }
  }
  return entries;
}

/**
 * Load, validate and cross-check the configuration.
 *
 * Order matters: YAML overrides → registry merge → whitelist → coherence checks. Nothing is
 * returned until every check passed, so callers never see a half-valid config.
 */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<StrategyConfig> {
  const cwd = options.cwd ?? process.cwd();
  const configDir = options.configDir ?? path.join(cwd, CONFIG_DIR_NAME);

  if (options.useBuiltinsOnly === true) {
    const chains = [...SUPPORTED_CHAINS];
    const whitelist = createWhitelist(BUILTIN_TOKENS, chains, defaultDexWhitelist(chains));
    const defaults: StrategyConfigYaml = strategyFileSchema.parse({}).strategy;
    return assembleStrategyConfig(defaults, whitelist, '<builtins>');
  }

  const strategyPath = path.join(configDir, STRATEGY_FILE_NAME);
  const tokensPath = path.join(configDir, TOKENS_FILE_NAME);
  const stablecoinsPath = path.join(configDir, STABLECOINS_FILE_NAME);

  const [strategyRaw, tokensRaw, stablecoinsRaw] = await Promise.all([
    readYamlFile(strategyPath),
    readYamlFile(tokensPath),
    readYamlFile(stablecoinsPath),
  ]);

  const strategyParsed = strategyFileSchema.safeParse(strategyRaw);
  if (!strategyParsed.success) {
    throw new ConfigError(
      `invalid strategy config (${formatIssues(strategyParsed.error.issues)})`,
      strategyPath,
    );
  }
  const tokensParsed = tokensFileSchema.safeParse(tokensRaw);
  if (!tokensParsed.success) {
    throw new ConfigError(
      `invalid tokens config (${formatIssues(tokensParsed.error.issues)})`,
      tokensPath,
    );
  }
  const stablecoinsParsed = stablecoinsFileSchema.safeParse(stablecoinsRaw);
  if (!stablecoinsParsed.success) {
    throw new ConfigError(
      `invalid stablecoins config (${formatIssues(stablecoinsParsed.error.issues)})`,
      stablecoinsPath,
    );
  }

  const overrides = [
    ...tokensParsed.data.tokens.map((entry) => toOverride(entry, false)),
    ...stablecoinsParsed.data.stablecoins.map((entry) => toOverride(entry, true)),
  ];

  const tokens = mergeTokensWithOverrides(BUILTIN_TOKENS, overrides);
  const chains = strategyParsed.data.whitelist.chains;
  const dexes =
    strategyParsed.data.whitelist.dexes.length > 0
      ? strategyParsed.data.whitelist.dexes.map((entry) => ({
          chainId: entry.chain_id,
          dex: entry.dex,
        }))
      : defaultDexWhitelist(chains);

  const whitelist = createWhitelist(tokens, chains, dexes);
  return assembleStrategyConfig(strategyParsed.data.strategy, whitelist, strategyPath);
}

/**
 * Map the validated YAML onto `StrategyConfig` and run the cross-field invariants that a
 * per-field schema cannot express. A contradictory config aborts startup (fail closed).
 */
function assembleStrategyConfig(
  yaml: StrategyConfigYaml,
  whitelist: Whitelist,
  sourcePath: string,
): StrategyConfig {
  const { capital, monitor, range, yield: yieldCfg, pool, swap, switch: switchCfg, risk, fees } = yaml;

  const failures: string[] = [];

  if (range.lower_ratio >= 1) {
    failures.push(`range.lower_ratio (${range.lower_ratio}) must be < 1`);
  }
  if (range.upper_ratio <= 1) {
    failures.push(`range.upper_ratio (${range.upper_ratio}) must be > 1`);
  }
  if (yieldCfg.warning_net_apr >= yieldCfg.target_net_apr) {
    failures.push(
      `yield.warning_net_apr (${yieldCfg.warning_net_apr}) must be < ` +
        `yield.target_net_apr (${yieldCfg.target_net_apr})`,
    );
  }

  const pegLadder: readonly (readonly [string, number])[] = [
    ['risk.peg_warning', risk.peg_warning],
    ['risk.stop_new_position', risk.stop_new_position],
    ['risk.exit_review', risk.exit_review],
    ['risk.emergency_exit', risk.emergency_exit],
  ];
  for (let i = 1; i < pegLadder.length; i += 1) {
    const previous = pegLadder[i - 1];
    const current = pegLadder[i];
    if (previous !== undefined && current !== undefined && previous[1] >= current[1]) {
      failures.push(`depeg ladder must increase: ${previous[0]} >= ${current[0]}`);
    }
  }

  if (risk.tvl_drop_review >= risk.tvl_drop_emergency) {
    failures.push(
      `risk.tvl_drop_review (${risk.tvl_drop_review}) must be < ` +
        `risk.tvl_drop_emergency (${risk.tvl_drop_emergency})`,
    );
  }
  if (swap.max_price_impact > pool.max_swap_price_impact) {
    failures.push(
      `swap.max_price_impact (${swap.max_price_impact}) exceeds pool.max_swap_price_impact ` +
        `(${pool.max_swap_price_impact}); the §16 filter would reject every pool the swap gate allows`,
    );
  }
  if (capital.max_lp_ratio + capital.reserve_ratio > 1 + 1e-9) {
    failures.push(
      `capital.max_lp_ratio + reserve_ratio = ` +
        `${capital.max_lp_ratio + capital.reserve_ratio} must be <= 1`,
    );
  }

  if (failures.length > 0) {
    throw new ConfigError(`strategy config is inconsistent: ${failures.join('; ')}`, sourcePath);
  }

  return {
    capital: {
      maxLpRatio: capital.max_lp_ratio,
      reserveRatio: capital.reserve_ratio,
      initialStrategyCapitalUsd: capital.initial_strategy_capital_usd,
    },
    monitor: {
      portfolioIntervalMinutes: monitor.portfolio_interval_minutes,
      poolScanIntervalMinutes: monitor.pool_scan_interval_minutes,
      poolHealthIntervalMinutes: monitor.pool_health_interval_minutes,
    },
    range: { lowerRatio: range.lower_ratio, upperRatio: range.upper_ratio },
    yield: {
      targetNetApr: yieldCfg.target_net_apr,
      warningNetApr: yieldCfg.warning_net_apr,
      warningDurationHours: yieldCfg.warning_duration_hours,
    },
    pool: {
      minTvlUsd: pool.min_tvl_usd,
      minAvgDailyVolume7dUsd: pool.min_avg_daily_volume_7d,
      minPoolAgeDays: pool.min_age_days,
      maxNavDeviation: pool.max_nav_deviation,
      maxSwapPriceImpact: pool.max_swap_price_impact,
    },
    swap: {
      maxSlippage: swap.max_slippage,
      maxPriceImpact: swap.max_price_impact,
      quoteTtlSeconds: swap.quote_ttl_seconds,
    },
    // §40 per-pool overrides. Each is validated against the admission threshold here, at startup, so a
    // configuration that could never be honoured is rejected before a trade rather than at the gate.
    poolOverrides: buildPoolOverrides(pool, swap, yaml.pool_overrides),
    switch: {
      minAprImprovement: switchCfg.min_apr_improvement,
      maxBreakEvenDays: switchCfg.max_break_even_days,
      cooldownDays: switchCfg.cooldown_days,
      maxSwitchCostRatio: switchCfg.max_switch_cost_ratio,
    },
    risk: {
      maxDrawdown: risk.max_drawdown,
      pegWarning: risk.peg_warning,
      stopNewPosition: risk.stop_new_position,
      exitReview: risk.exit_review,
      emergencyExit: risk.emergency_exit,
      tvlDropReview: risk.tvl_drop_review,
      tvlDropEmergency: risk.tvl_drop_emergency,
      minReserveBeforeNewLp: risk.min_reserve_before_new_lp,
    },
    fees: {
      autoCompound: fees.auto_compound,
      minCollectUsd: fees.min_collect_usd,
      collectIntervalDays: fees.collect_interval_days,
      convertStockFeesToStable: fees.convert_stock_fees_to_stable,
    },
    approvals: {
      buildPosition: yaml.approvals.build_position,
      switchPool: yaml.approvals.switch_pool,
      others: yaml.approvals.others,
      timeoutMinutes: yaml.approvals.timeout_minutes,
    },
    telegram: { enabled: yaml.telegram.enabled },
    whitelist,
    sourcePath,
    loadedAt: new Date().toISOString(),
  };
}
