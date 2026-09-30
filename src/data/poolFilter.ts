/**
 * §16 hard pool filters.
 *
 * `任一条件不满足：直接淘汰，不进入 Pool Ranking。`
 *
 * Every threshold comes from `StrategyConfig.pool` (never a literal at the call site), every check
 * is reported individually with its actual value and threshold so the DecisionLog can name the
 * disqualifying condition, and every comparison direction is fixed by the §16 text:
 *
 *   | §16 line                          | comparison | rationale |
 *   |-----------------------------------|------------|-----------|
 *   | `TVL >= $500,000`                 | `>=`       | exactly 500 000 passes — the text says `>=` |
 *   | `7D Avg Daily Volume >= $250,000` | `>=`       | exactly 250 000 passes; the 7d SUM is divided by 7 first |
 *   | `Pool Age >= 7 Days`              | `>=`       | exactly 7.0 days passes |
 *   | `Token/NAV Deviation < 1%`        | `<`        | exactly 1% FAILS — the text says `<` |
 *   | `$3500 Swap Price Impact < 0.5%`  | `<`        | exactly 0.5% FAILS |
 *
 * Whitelist membership is checked at the ADDRESS layer only (§8, `TokenRegistry` is address-keyed):
 * a pool whose leg carries a whitelisted `symbol` but an unlisted `contract` is rejected, and the
 * registry lookup here deliberately goes through `registry.getTokenByAddress`.
 *
 * FAIL CLOSED (§96): a missing/stale figure is NOT a numeric near-miss — it fails with an
 * `*_UNAVAILABLE` reason so the DecisionLog records "we do not know" instead of "it was too small".
 * `PoolSnapshot` carries `0` for unavailable USD values, so a naive numeric comparison would
 * silently turn "the data source failed" into "the pool has no liquidity".
 *
 * The same rule applies to the raw on-chain fields (`currentTick`/`sqrtPriceX96`/`activeLiquidity`),
 * which have no availability bit of their own: `filterPools` takes the caller's verification flag
 * (`onchainVerified` / `isOnchainVerified`) and rejects an unread pool as `ONCHAIN_UNVERIFIED`.
 * `tick: 0` and `liquidity: 0n` are both *valid* on-chain values, so they cannot be told apart from
 * a placeholder — the flag is the only sound signal, and §16/§34 depend on those fields.
 */
import {
  DATA_SOURCES,
  type PoolFilterResult,
  type PoolFilterThresholds,
  type PoolSnapshot,
  type Sourced,
} from '../types/market.ts';
import type { IsoTimestamp, Ratio, UsdAmount } from '../types/primitives.ts';
import type { Whitelist } from '../types/registry.ts';

export const POOL_FILTER_CODES = {
  /** §11: the pool's chain is not whitelisted. */
  CHAIN_NOT_WHITELISTED: 'CHAIN_NOT_WHITELISTED',
  /** §12: the pool's DEX is not whitelisted for this chain. */
  DEX_NOT_WHITELISTED: 'DEX_NOT_WHITELISTED',
  /** §8/§16: a leg's contract address is not in the token whitelist (symbol is irrelevant). */
  LEG_NOT_WHITELISTED: 'LEG_NOT_WHITELISTED',
  /** §14: the pair is not (whitelisted stock token) × (whitelisted stablecoin). */
  STOCK_LEG_MISSING: 'STOCK_LEG_MISSING',
  STABLECOIN_LEG_MISSING: 'STABLECOIN_LEG_MISSING',
  /** §16 `TVL >= min_tvl_usd`. */
  TVL_BELOW_MINIMUM: 'TVL_BELOW_MINIMUM',
  /** §16 `7D Avg Daily Volume >= min_avg_daily_volume_7d`. */
  VOLUME_7D_BELOW_MINIMUM: 'VOLUME_7D_BELOW_MINIMUM',
  /** §16 `Pool Age >= min_pool_age_days`. */
  POOL_TOO_YOUNG: 'POOL_TOO_YOUNG',
  /** §16 `Token/NAV Deviation < max_nav_deviation`. */
  NAV_DEVIATION_EXCEEDED: 'NAV_DEVIATION_EXCEEDED',
  /** §16 `$3500 Swap Price Impact < max_swap_price_impact`. */
  SWAP_IMPACT_EXCEEDED: 'SWAP_IMPACT_EXCEEDED',
  /** §96: the figure could not be read, so no verdict may be reached. */
  TVL_UNAVAILABLE: 'TVL_UNAVAILABLE',
  VOLUME_7D_UNAVAILABLE: 'VOLUME_7D_UNAVAILABLE',
  POOL_AGE_UNAVAILABLE: 'POOL_AGE_UNAVAILABLE',
  NAV_DEVIATION_UNAVAILABLE: 'NAV_DEVIATION_UNAVAILABLE',
  SWAP_IMPACT_UNAVAILABLE: 'SWAP_IMPACT_UNAVAILABLE',
  /**
   * §15/§96: the snapshot's on-chain state (`tick`, `liquidity`, `fee`) was never read.
   *
   * `PoolSnapshot.currentTick`/`sqrtPriceX96`/`activeLiquidity` are raw, non-`Sourced` fields with
   * no availability bit, so an unread pool is indistinguishable from a real one at those types
   * (`currentTick: 0` is a *valid* tick and `activeLiquidity: 0n` is a *valid* all-out-of-range
   * pool). §16's `$3500 Swap Price Impact < 0.5%` and §34's tick alignment both depend on real
   * `tick`/`liquidity`, so a pool that cannot be shown to satisfy them must not pass a hard filter:
   * "cannot verify ⇒ reject" is §96. Gating here also keeps an unread snapshot from ever reaching
   * `planPosition`, which makes the `currentTick: 0` placeholder unreachable rather than merely
   * flagged.
   */
  ONCHAIN_UNVERIFIED: 'ONCHAIN_UNVERIFIED',
  /** §13/§15: the snapshot is internally inconsistent (identity does not match its fields). */
  SNAPSHOT_INCONSISTENT: 'SNAPSHOT_INCONSISTENT',
} as const;
export type PoolFilterCode = (typeof POOL_FILTER_CODES)[keyof typeof POOL_FILTER_CODES];

/** The single condition a check encodes, in the §16 sense. */
export type PoolFilterCondition =
  /** §13: the snapshot's `poolId` agrees with its own `chainId`/`dex`/`poolAddress`. */
  | 'identity'
  | 'chain'
  | 'dex'
  | 'stockLeg'
  | 'stablecoinLeg'
  | 'onchain'
  | 'tvl'
  | 'avgDailyVolume7d'
  | 'poolAge'
  | 'navDeviation'
  | 'swapImpact3500';

/**
 * Which §16 conditions can ONLY be evaluated with a chain read.
 *
 * The distinction exists because the two filter stages own different questions (architecture §4.2):
 * ```text
 * admission (module 1, HTTP)  → is this pool big/old/liquid enough to be worth looking at?
 * screening (module 2, chain) → does it satisfy the two gates that need a live quote?
 * ```
 * At admission time `navDeviation` and `swapImpact3500` are **not yet measurable**, which is not the same as
 * failing them. Treating "not yet measured" as a rejection is what produced a `warning` alert every hour,
 * listing every candidate as rejected for `ONCHAIN_UNVERIFIED` — including the pools that are in fact
 * eligible. Noise of that kind is how a real alert gets ignored.
 */
export const CHAIN_ONLY_CONDITIONS: readonly PoolFilterCondition[] = ['onchain', 'navDeviation', 'swapImpact3500'];

export interface PoolFilterCheck {
  readonly condition: PoolFilterCondition;
  readonly code: PoolFilterCode;
  /** `null` when the figure could not be read (§96: fail closed rather than compare a placeholder). */
  readonly actual: number | null;
  /** The configured threshold, or `null` for the boolean whitelist checks. */
  readonly threshold: number | null;
  /** How the comparison is defined by §16 (`>=` or `<`). */
  readonly comparison: '>=' | '<' | 'in';
  readonly passed: boolean;
  /**
   * True when this condition is not applicable AT THIS STAGE rather than failed.
   *
   * Only the chain-only conditions can be deferred (see `CHAIN_ONLY_CONDITIONS`), and only when the caller
   * says so explicitly via `deferChainOnly`. A deferred check is NOT a pass — it never contributes to
   * `passed`, and `complete` stays false — it simply records "not measured yet" instead of "measured and
   * too small", which are different facts and were being conflated.
   */
  readonly deferred: boolean;
  /** `field actual=… threshold=…` — one line, ready for the DecisionLog. */
  readonly message: string;
}

/**
 * The frozen `PoolFilterResult` plus the per-condition detail the DecisionLog needs.
 * `passed`/`reasons`/`poolId`/`evaluatedAt` are exactly the contract fields.
 */
export interface PoolFilterEvaluation extends PoolFilterResult {
  readonly chainId: number;
  readonly dex: string;
  readonly poolAddress: string;
  /** One entry per §16 condition, always all of them, so the log can be diffed. */
  readonly checks: readonly PoolFilterCheck[];
  /** The `code`s that failed, in evaluation order. */
  readonly failedCodes: readonly PoolFilterCode[];
  /**
   * True when every §16 figure was actually readable AND the on-chain state was verified.
   * `passed === false && complete === false` means the rejection may be a data problem, not a pool
   * problem.
   */
  readonly complete: boolean;
}

export interface PoolFilterOptions {
  /** ISO now; injected so a decision is reproducible in tests and replay (§77). */
  readonly evaluatedAt: IsoTimestamp;
  /** §11/§12 whitelists. When provided, chain/DEX/token membership is enforced here as well. */
  readonly whitelist?: Whitelist;
  /**
   * Whether the snapshot's on-chain state (`tick`/`liquidity`/`fee`) was actually read.
   *
   * `PoolSnapshot` carries no availability bit for those raw fields, so the flag has to travel
   * beside the snapshot. `PoolScanner` always knows the answer
   * (`PoolDiagnostic.onchainVerified`, re-exposed as `PoolScanSummary.onchainVerifiedByPool`); a
   * batch whose pools were verified selectively passes `isOnchainVerified` instead. When neither
   * supplies `true` the pool is treated as unverified: absence of proof of a `tick`/`liquidity`
   * read must reject (§96).
   */
  readonly onchainVerified?: boolean;
  /** Per-pool variant of `onchainVerified`, for batches verified one pool at a time. */
  readonly isOnchainVerified?: (snapshot: PoolSnapshot) => boolean;
  /**
   * Treat the chain-only conditions as NOT YET APPLICABLE instead of failed (architecture §4.2).
   *
   * Set this from the ADMISSION stage (module 1), which makes no chain call by design: there, `navDeviation`
   * and `swapImpact3500` cannot have been measured, so reporting them as failures is a category error and
   * turns every scan into an alert.
   *
   * Leave it unset for the SCREENING stage (module 2), which has the chain and therefore must judge those
   * gates for real — §96 still applies, and an unmeasurable figure there is still a refusal.
   */
  readonly deferChainOnly?: boolean;
}

function formatUsd(value: number): string {
  return `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

function formatRatio(value: number): string {
  return `${(value * 100).toFixed(4)}%`;
}

function formatDays(value: number): string {
  return `${value.toFixed(3)}d`;
}

/** A `Sourced<T>` figure is usable only when present, sourced and not stale (§57/§96). */
function usableNumeric(field: Sourced<number | null>): number | null {
  if (field.stale) return null;
  if (field.source === DATA_SOURCES.UNAVAILABLE) return null;
  const value = field.value;
  return value === null || !Number.isFinite(value) ? null : value;
}

/**
 * Evaluate every §16 condition for one pool.
 *
 * All checks run (no short-circuit) so the returned `checks` is a complete picture; `passed` is
 * the conjunction. `min`/`max` semantics come from §16 exactly (see the module doc table).
 */
export function evaluatePoolFilters(
  snapshot: PoolSnapshot,
  thresholds: PoolFilterThresholds,
  options: PoolFilterOptions,
): PoolFilterEvaluation {
  const checks: PoolFilterCheck[] = [];
  /**
   * `deferred` defaults to false so a caller cannot forget it: only the three chain-only checks opt in, and
   * they do so explicitly where they are built. Everything else is a real verdict by construction.
   */
  const push = (check: Omit<PoolFilterCheck, 'deferred'> & { readonly deferred?: boolean }): void => {
    checks.push({ ...check, deferred: check.deferred === true });
  };

  // ---- §13/§15 identity: the snapshot must agree with itself.
  const expectedPoolId = `${snapshot.chainId}:${snapshot.dex}:${snapshot.poolAddress.toLowerCase()}`;
  const identityOk = expectedPoolId === snapshot.poolId;
  push({
    condition: 'identity',
    code: POOL_FILTER_CODES.SNAPSHOT_INCONSISTENT,
    actual: null,
    threshold: null,
    comparison: 'in',
    passed: identityOk,
    message: identityOk
      ? `poolId ${snapshot.poolId} matches chainId:dex:poolAddress (§13)`
      : `poolId ${snapshot.poolId} does not match ${expectedPoolId} (§13 identity mismatch)`,
  });

  // ---- §11 chain whitelist.
  const chainOk = options.whitelist === undefined || options.whitelist.isWhitelistedChain(snapshot.chainId);
  push({
    condition: 'chain',
    code: POOL_FILTER_CODES.CHAIN_NOT_WHITELISTED,
    actual: null,
    threshold: null,
    comparison: 'in',
    passed: chainOk,
    message: chainOk
      ? `chain ${snapshot.chainId} is whitelisted (§11)`
      : `chain ${snapshot.chainId} is NOT whitelisted (§11)`,
  });

  // ---- §12 DEX whitelist.
  const dexOk =
    options.whitelist === undefined ||
    options.whitelist.isWhitelistedDex(snapshot.chainId, snapshot.dex);
  push({
    condition: 'dex',
    code: POOL_FILTER_CODES.DEX_NOT_WHITELISTED,
    actual: null,
    threshold: null,
    comparison: 'in',
    passed: dexOk,
    message: dexOk
      ? `dex ${snapshot.dex} is whitelisted on chain ${snapshot.chainId} (§12)`
      : `dex ${snapshot.dex} is NOT whitelisted on chain ${snapshot.chainId} (§12)`,
  });

  // ---- §8/§9/§10/§16 token whitelist, by ADDRESS.
  const registry = options.whitelist?.registry;
  type LegLookup = { readonly symbol: string; readonly isStockToken: boolean } | null;
  const lookup = (address: string): LegLookup => {
    if (registry === undefined) return null;
    const token = registry.getTokenByAddress(snapshot.chainId, address as `0x${string}`);
    return token === null ? null : { symbol: token.symbol, isStockToken: token.isStockToken };
  };
  let stockLegToken: LegLookup = null;
  let stablecoinLegToken: LegLookup = null;
  for (const address of [snapshot.token0, snapshot.token1]) {
    const token = lookup(address);
    if (token === null) continue;
    if (token.isStockToken) {
      stockLegToken ??= token;
    } else {
      stablecoinLegToken ??= token;
    }
  }
  for (const [leg, address] of [
    ['token0', snapshot.token0],
    ['token1', snapshot.token1],
  ] as const) {
    const token = registry === undefined ? { symbol: '<unchecked>', isStockToken: true } : lookup(address);
    const ok = token !== null;
    push({
      condition: token !== null && token.isStockToken ? 'stockLeg' : 'stablecoinLeg',
      code: POOL_FILTER_CODES.LEG_NOT_WHITELISTED,
      actual: null,
      threshold: null,
      comparison: 'in',
      passed: ok,
      message: ok
        ? `${leg} ${address} is whitelisted as ${token.symbol} (address match, §8)`
        : `${leg} ${address} is NOT in the token whitelist — rejected by address, regardless of any symbol it reports (§8)`,
    });
  }
  push({
    condition: 'stockLeg',
    code: POOL_FILTER_CODES.STOCK_LEG_MISSING,
    actual: null,
    threshold: null,
    comparison: 'in',
    passed: registry === undefined || stockLegToken !== null,
    message:
      registry === undefined
        ? 'stock leg unverified (no whitelist supplied)'
        : `stock leg ${stockLegToken === null ? '<none>' : `${stockLegToken.symbol} ${snapshot.token0Id}/${snapshot.token1Id}`} (§14 requires a whitelisted stock token)`,
  });
  push({
    condition: 'stablecoinLeg',
    code: POOL_FILTER_CODES.STABLECOIN_LEG_MISSING,
    actual: null,
    threshold: null,
    comparison: 'in',
    passed: registry === undefined || stablecoinLegToken !== null,
    message:
      registry === undefined
        ? 'stablecoin leg unverified (no whitelist supplied)'
        : `stablecoin leg ${stablecoinLegToken?.symbol ?? '<none>'} (§14 requires a whitelisted stablecoin)`,
  });

  // ---- §15/§96 the raw on-chain fields carry no availability bit: gate them here.
  const onchainVerified =
    options.onchainVerified === true || options.isOnchainVerified?.(snapshot) === true;
  const defer = options.deferChainOnly === true;
  push({
    condition: 'onchain',
    code: POOL_FILTER_CODES.ONCHAIN_UNVERIFIED,
    actual: null,
    threshold: null,
    comparison: 'in',
    passed: onchainVerified,
    deferred: defer && !onchainVerified,
    message: onchainVerified
      ? 'on-chain state read (tick/liquidity/fee verified via RPC, §15)'
      : defer
        ? 'on-chain state not read yet: this is the admission stage, which makes no chain call by design (architecture §4.2). module 2 reads it and judges §16 impact and §34 alignment there'
        : 'on-chain state NOT read: tick/liquidity/fee are unverified, so §16 swap impact and §34 tick alignment cannot be shown to hold — §96 fail closed',
  });

  // ---- §16 TVL >= min_tvl_usd.
  const tvl = usableNumeric(snapshot.tvlUSD);
  push({
    condition: 'tvl',
    code: tvl === null ? POOL_FILTER_CODES.TVL_UNAVAILABLE : POOL_FILTER_CODES.TVL_BELOW_MINIMUM,
    actual: tvl,
    threshold: thresholds.minTvlUsd,
    comparison: '>=',
    passed: tvl !== null && tvl >= thresholds.minTvlUsd,
    message:
      tvl === null
        ? `tvlUSD unavailable (source=${snapshot.tvlUSD.source}, stale=${String(snapshot.tvlUSD.stale)}) — §96 fail closed, no verdict`
        : `tvlUSD ${formatUsd(tvl)} >= ${formatUsd(thresholds.minTvlUsd)} → ${tvl >= thresholds.minTvlUsd ? 'pass' : 'FAIL'}`,
  });

  // ---- §16 7D avg daily volume >= min_avg_daily_volume_7d (the 7-day SUM ÷ 7).
  const volume7d = usableNumeric(snapshot.volume7d);
  const avgDailyVolume7d = volume7d === null ? null : volume7d / 7;
  push({
    condition: 'avgDailyVolume7d',
    code:
      avgDailyVolume7d === null
        ? POOL_FILTER_CODES.VOLUME_7D_UNAVAILABLE
        : POOL_FILTER_CODES.VOLUME_7D_BELOW_MINIMUM,
    actual: avgDailyVolume7d,
    threshold: thresholds.minAvgDailyVolume7dUsd,
    comparison: '>=',
    passed: avgDailyVolume7d !== null && avgDailyVolume7d >= thresholds.minAvgDailyVolume7dUsd,
    message:
      avgDailyVolume7d === null
        ? `7D volume unavailable (source=${snapshot.volume7d.source}, stale=${String(snapshot.volume7d.stale)}) — §96 fail closed, no verdict`
        : `avg daily volume 7D ${formatUsd(avgDailyVolume7d)} (7D total ${formatUsd(volume7d ?? 0)} ÷ 7) >= ${formatUsd(thresholds.minAvgDailyVolume7dUsd)} → ${avgDailyVolume7d >= thresholds.minAvgDailyVolume7dUsd ? 'pass' : 'FAIL'}`,
  });

  // ---- §16 Pool Age >= min_pool_age_days.
  const poolAgeDays = Number.isFinite(snapshot.poolAgeDays) ? snapshot.poolAgeDays : null;
  push({
    condition: 'poolAge',
    code:
      poolAgeDays === null ? POOL_FILTER_CODES.POOL_AGE_UNAVAILABLE : POOL_FILTER_CODES.POOL_TOO_YOUNG,
    actual: poolAgeDays,
    threshold: thresholds.minPoolAgeDays,
    comparison: '>=',
    passed: poolAgeDays !== null && poolAgeDays >= thresholds.minPoolAgeDays,
    message:
      poolAgeDays === null
        ? 'poolAgeDays unavailable (no trustworthy creation time) — §96 fail closed, no verdict'
        : `pool age ${formatDays(poolAgeDays)} >= ${formatDays(thresholds.minPoolAgeDays)} → ${poolAgeDays >= thresholds.minPoolAgeDays ? 'pass' : 'FAIL'}`,
  });

  // ---- §16 Token/NAV Deviation < max_nav_deviation.
  const navDeviation = usableNumeric(snapshot.tokenNAVDeviation);
  const navStale = snapshot.tokenNAVDeviation.stale;
  // At the admission stage this figure comes from a chain read plus a reference price, so it cannot have
  // been measured yet. Deferring it records "not measured" instead of "measured and too high" — and a
  // genuinely unreadable figure at the SCREENING stage still fails, because `defer` is false there.
  const navDeferred = defer && navDeviation === null;
  push({
    condition: 'navDeviation',
    code:
      navDeviation === null
        ? POOL_FILTER_CODES.NAV_DEVIATION_UNAVAILABLE
        : POOL_FILTER_CODES.NAV_DEVIATION_EXCEEDED,
    actual: navDeviation,
    threshold: thresholds.maxNavDeviation,
    comparison: '<',
    passed: navDeviation !== null && navDeviation < thresholds.maxNavDeviation,
    deferred: navDeferred,
    message:
      navDeviation === null
        ? navDeferred
          ? 'tokenNAVDeviation not measured yet: needs a chain price and a reference NAV, which the admission stage does not read (architecture §4.2); module 2 evaluates it'
          : `tokenNAVDeviation unavailable (source=${snapshot.tokenNAVDeviation.source}, stale=${String(navStale)}) — without a reference NAV the depeg condition cannot be satisfied (§57/§96)`
        : `tokenNAVDeviation ${formatRatio(navDeviation)} < ${formatRatio(thresholds.maxNavDeviation)} → ${navDeviation < thresholds.maxNavDeviation ? 'pass' : 'FAIL'}`,
  });

  // ---- §16 $3500 Swap Price Impact < max_swap_price_impact.
  const impact = usableNumeric(snapshot.swapImpact3500USD);
  push({
    condition: 'swapImpact3500',
    code:
      impact === null
        ? POOL_FILTER_CODES.SWAP_IMPACT_UNAVAILABLE
        : POOL_FILTER_CODES.SWAP_IMPACT_EXCEEDED,
    actual: impact,
    threshold: thresholds.maxSwapPriceImpact,
    comparison: '<',
    passed: impact !== null && impact < thresholds.maxSwapPriceImpact,
    // Same reasoning as `navDeviation`: the $3500 impact needs an on-chain quote (QuoterV2), which the
    // admission stage does not make. A MEASURED impact that is too high always fails, deferred or not.
    deferred: defer && impact === null,
    message:
      impact === null
        ? defer
          ? 'swapImpact3500USD not measured yet: needs an on-chain quote, which the admission stage does not make (architecture §4.2); module 2 evaluates it'
          : `swapImpact3500USD unavailable (source=${snapshot.swapImpact3500USD.source}, stale=${String(snapshot.swapImpact3500USD.stale)}) — no on-chain quote, so the §16 impact gate cannot be satisfied`
        : `$3500 swap price impact ${formatRatio(impact)} < ${formatRatio(thresholds.maxSwapPriceImpact)} → ${impact < thresholds.maxSwapPriceImpact ? 'pass' : 'FAIL'}`,
  });

  /**
   * A DEFERRED check is not a failure and not a pass: it is "not measured yet". Excluding it from `failed`
   * is what stops an admission-stage scan from reporting every candidate as rejected — including the pools
   * that are in fact eligible. It never counts toward `passed` either, so §96 is untouched.
   */
  const failed = checks.filter((check) => !check.passed && !check.deferred);
  const reasons = failed.map((check) => `[${check.code}] ${check.message}`);
  return {
    poolId: snapshot.poolId,
    passed: failed.length === 0,
    reasons,
    evaluatedAt: options.evaluatedAt,
    chainId: snapshot.chainId,
    dex: snapshot.dex,
    poolAddress: snapshot.poolAddress,
    checks,
    failedCodes: failed.map((check) => check.code),
    /**
     * `complete` says "every §16 figure was readable and the on-chain state was verified".
     *
     * A deferred check makes this false on purpose: the verdict is genuinely partial at the admission stage,
     * and a caller that treats `complete: false` as "needs another look" is right to. What the deferral
     * removes is the claim that the pool FAILED — the difference between "not yet judged" and "judged bad".
     */
    complete:
      onchainVerified &&
      !checks.some((check) => check.deferred) &&
      !failed.some((check) => check.code.endsWith('_UNAVAILABLE')),
  };
}

/** Convenience for callers that only need the frozen contract shape. */
export function toPoolFilterResult(evaluation: PoolFilterEvaluation): PoolFilterResult {
  return {
    poolId: evaluation.poolId,
    passed: evaluation.passed,
    reasons: evaluation.reasons,
    evaluatedAt: evaluation.evaluatedAt,
  };
}

/** A pool plus its verdict, in the order the scanner produced them. */
export interface FilteredPool {
  readonly snapshot: PoolSnapshot;
  readonly evaluation: PoolFilterEvaluation;
}

export interface PoolFilterOutcome {
  readonly passed: readonly FilteredPool[];
  readonly rejected: readonly FilteredPool[];
  readonly thresholds: PoolFilterThresholds;
  readonly evaluatedAt: IsoTimestamp;
  /**
   * True when no rejection was caused by an unavailable figure. `false` means at least one pool was
   * not rejected on its merits — the operator must look at the data layer, not at the pool.
   */
  readonly decisive: boolean;
}

/**
 * Evaluate many pools and split them into pass/reject while keeping the per-condition detail.
 * Ranking (§21) only ever receives `passed`.
 */
export function filterPools(
  snapshots: readonly PoolSnapshot[],
  thresholds: PoolFilterThresholds,
  options: PoolFilterOptions,
): PoolFilterOutcome {
  const passed: FilteredPool[] = [];
  const rejected: FilteredPool[] = [];
  let decisive = true;
  for (const snapshot of snapshots) {
    const evaluation = evaluatePoolFilters(snapshot, thresholds, options);
    if (evaluation.passed) {
      passed.push({ snapshot, evaluation });
    } else {
      rejected.push({ snapshot, evaluation });
    }
    if (!evaluation.complete) decisive = false;
  }
  return { passed, rejected, thresholds, evaluatedAt: options.evaluatedAt, decisive };
}

/**
 * §16 as a summary line, for the smoke script and the operator log. Order and comparison
 * directions match the baseline text exactly.
 */
export function describeThresholds(thresholds: PoolFilterThresholds): readonly string[] {
  return [
    `TVL >= ${formatUsd(thresholds.minTvlUsd)}`,
    `7D Avg Daily Volume >= ${formatUsd(thresholds.minAvgDailyVolume7dUsd)}`,
    `Pool Age >= ${formatDays(thresholds.minPoolAgeDays)}`,
    `Token/NAV Deviation < ${formatRatio(thresholds.maxNavDeviation)}`,
    `$3500 Swap Price Impact < ${formatRatio(thresholds.maxSwapPriceImpact)}`,
  ];
}

/** §16 thresholds are ratios (fractions); this only exists so callers cannot pass a percentage. */
export function assertRatioThreshold(value: Ratio, label: string): void {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`${label} must be a fraction in (0, 1], received ${String(value)}`);
  }
}

/** Type-narrowing helper for callers that hold `UsdAmount | undefined` from a partial config. */
export function requireUsd(value: UsdAmount | undefined, label: string): UsdAmount {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative USD amount, received ${String(value)}`);
  }
  return value;
}
