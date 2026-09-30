/**
 * §14 Pool Scanner.
 *
 * `扫描对象：Whitelist Stock Token × Whitelist Stablecoin × Whitelist DEX`
 *
 * The cross set is built from the ADDRESS whitelist (`TokenRegistry`, §8) intersected with the
 * chain/DEX whitelist (§11/§12) — never from symbols. A pool's identity is §13
 * `chainId + dex + poolAddress` (`poolIdFor`), never `(token0, token1, feeTier)`.
 *
 * ── "THE POOL DOES NOT EXIST" vs "THE DATA SOURCE FAILED" ──────────────────────────────────────
 *
 * These two must never be conflated (fail closed, §96), so existence is a three-valued verdict and
 * each value carries the evidence behind it:
 *
 *   `found`      — a pool was discovered and (when the RPC layer is wired) its address resolved
 *                  independently through `factory.getPool(...)`.
 *   `absent`     — **proven**: the on-chain factory answered with the zero address for that
 *                  (tokenA, tokenB, fee) tuple. This is the only authoritative "does not exist"
 *                  because the HTTP layers are incomplete by construction (GeckoTerminal lists
 *                  page 1 only, DexPaprika ranks by liquidity).
 *   `unverified` — no pool was discovered, and existence could NOT be proven either way: the
 *                  discovery source failed, a page was truncated, or no factory probe is wired.
 *                  Consumers must treat this as "unknown" and do nothing (§96).
 *
 * `complete === false` on the result means at least one `unverified`/`failed` item exists; a scan
 * that returns zero pools with `complete === true` is a real "no candidate pool today", whereas
 * `complete === false` means "ask again / fix the data layer".
 */
import type { PoolDataProvider, PoolDiscoveryQuery } from '../types/adapters.ts';
import { DATA_SOURCES, type PoolSnapshot } from '../types/market.ts';
import {
  DEX_IDS,
  type Address,
  type ChainId,
  type DexId,
  type FeeTier,
  type PoolId,
} from '../types/primitives.ts';
import type { Whitelist } from '../types/registry.ts';
import type { StrategyConfig } from '../types/config.ts';
import type { IsoTimestamp } from '../types/primitives.ts';
import type { PoolFilterThresholds } from '../types/market.ts';
import {
  filterPools,
  type PoolFilterOutcome,
} from './poolFilter.ts';
import {
  POOL_DATA_ERROR_CODES,
  POOL_SOURCE_FAILURE_SEVERITIES,
  PoolDataError,
  dedupeAddresses,
  poolIdFor,
  supportsDetail,
  type PoolSourceFailure,
} from './poolDataProvider.ts';

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

export function isKnownDex(value: string): value is DexId {
  return value === DEX_IDS.UNISWAP_V3 || value === DEX_IDS.PANCAKESWAP_V3;
}

/**
 * What a scan concluded about one (stock × stablecoin × DEX × fee tier) combination.
 *
 * ## This vocabulary is about HTTP evidence, deliberately (architecture §3)
 * Module 1 is **纯 HTTP** — it makes no chain calls. So "the pool does not exist" can only ever mean
 * "the discovery source answered and listed no such pool", which is NOT the same as proof. That is why
 * `ABSENT` is gone: it previously meant "the on-chain factory returned the zero address", and without a
 * chain probe that claim cannot be made. Keeping the name while weakening the evidence is exactly the
 * silent-semantics change the architecture forbids (§7.3).
 *
 * The distinction that MUST survive is the one that was always the point:
 * ```text
 * NOT_LISTED  — the source answered, this combination is not among its results
 * UNVERIFIED  — the source failed / truncated, so a pool here might simply not have been seen
 * ```
 * Conflating those is how a data-source outage gets misread as "no pools exist" (and, in the other
 * direction, how a pool that does exist gets treated as absent).
 */
export const POOL_EXISTENCE = {
  /** Discovered through the HTTP discovery layer. */
  FOUND: 'found',
  /** The source answered and listed no such pool. NOT a proof of non-existence (see above). */
  NOT_LISTED: 'not-listed',
  /** Unknown: nothing was discovered, and absence could not be asserted. */
  UNVERIFIED: 'unverified',
} as const;
export type PoolExistence = (typeof POOL_EXISTENCE)[keyof typeof POOL_EXISTENCE];

export const POOL_EXISTENCE_EVIDENCE = {
  /** Discovered through the HTTP discovery layer. */
  HTTP_DISCOVERY: 'http-discovery',
  /** The discovery source answered and listed no such pool. */
  HTTP_NOT_LISTED: 'http-not-listed',
  /** The discovery source itself failed for this token. */
  DISCOVERY_FAILED: 'discovery-failed',
  /** Discovery reported more pages than were read: a valid pool may sit on a later page. */
  DISCOVERY_TRUNCATED: 'discovery-truncated',
} as const;
export type PoolExistenceEvidence =
  (typeof POOL_EXISTENCE_EVIDENCE)[keyof typeof POOL_EXISTENCE_EVIDENCE];

/** One (stock token × stablecoin × DEX × fee tier) probe and what came back. */
export interface PoolProbe {
  readonly chainId: ChainId;
  readonly dex: DexId;
  readonly feeTier: FeeTier;
  readonly stockToken: Address;
  readonly stablecoin: Address;
  readonly existence: PoolExistence;
  readonly evidence: PoolExistenceEvidence;
  /** Present iff `existence === 'found'`. */
  readonly snapshot?: PoolSnapshot;
  /** Human-readable explanation, always present for a non-`found` probe. */
  readonly note?: string;
}

export interface PoolScanSummary {
  readonly chainId: ChainId;
  readonly scannedAt: string;
  /** Every fee tier probed per DEX (the factories are fee-tier keyed, so this is not a secret). */
  readonly feeTiersByDex: Readonly<Record<string, readonly FeeTier[]>>;
  readonly stockTokens: readonly Address[];
  readonly stablecoins: readonly Address[];
  readonly dexes: readonly DexId[];
  readonly probes: readonly PoolProbe[];
  readonly pools: readonly PoolSnapshot[];
  /**
   * `PoolId` → whether the on-chain state (`tick`/`liquidity`/`fee`) was actually read for it.
   *
   * **Always `false` in module 1**, because module 1 makes no chain calls (architecture §3). It is kept
   * rather than removed because it is the wire that forces §96 behaviour downstream: `filterScannedPools`
   * rejects an unverified pool instead of evaluating a placeholder `tick`/`liquidity`. On-chain
   * verification now happens in module 2 (`PoolScreener`), which is the only layer allowed to read the
   * chain — and it must still refuse a pool whose tick/liquidity it could not read.
   */
  readonly onchainVerifiedByPool: Readonly<Record<PoolId, boolean>>;
  readonly failures: readonly PoolSourceFailure[];
  /** False when any source failure or unverifiable absence occurred — consumers must not act. */
  readonly complete: boolean;
  /** Fatal failures only, i.e. the reason `complete` is false. */
  readonly blockers: readonly string[];
}

export interface PoolScannerOptions {
  readonly config: StrategyConfig;
  /** The §83 provider. `getPoolsDetailed` is used when available (it carries failure info). */
  readonly provider: PoolDataProvider;
  /**
   * Chains to scan. Defaults to `config.whitelist.chains`.
   *
   * Note the absence of any on-chain probe option: **module 1 does not call the chain** (architecture
   * §3). An earlier version accepted `dexAdapters` / `findOnchainPool` to prove non-existence via
   * `factory.getPool`; that fan-out (20 combinations × fee tiers) was the main reason a scan was
   * expensive, and it produced a claim ("proven absent") whose only value was to distinguish it from
   * "not listed" — a distinction HTTP already expresses, at no cost.
   */
  readonly chainIds?: readonly ChainId[];
  /**
   * Fee tiers to consider per DEX when matching a discovered pool to a candidate combination.
   * CLMM pools are fee-tier keyed, so a discovered pool is only matched to a (pair, tier) entry when
   * the tier is one this DEX actually deploys (research §5: Pancake 100/500/2500/10000,
   * Uniswap 500/3000/10000). No chain call is involved — this is a lookup table.
   */
  readonly feeTiersByDex?: Readonly<Record<string, readonly FeeTier[]>>;
}

/**
 * The fee tiers of each whitelisted DEX (research §5). Pancake `FeeAmount` and Uniswap `FeeAmount`
 * are NOT interchangeable, so the probe must ask each factory for its own tiers.
 */
export const DEX_FEE_TIERS: Readonly<Record<string, readonly FeeTier[]>> = {
  [DEX_IDS.PANCAKESWAP_V3]: [100, 500, 2500, 10_000],
  [DEX_IDS.UNISWAP_V3]: [500, 3_000, 10_000],
};

export interface PoolCandidatePair {
  readonly chainId: ChainId;
  readonly stockToken: Address;
  readonly stablecoin: Address;
  readonly dex: DexId;
}

/**
 * §14 cross set: (whitelisted stock token) × (whitelisted stablecoin) × (whitelisted DEX),
 * restricted to auto-tradeable stock tokens (§9 HIGH_VOL tokens are monitor-only, so they must not
 * enter the *trading* candidate set).
 *
 * Returns addresses only — the identity of a token is its contract address (§8).
 */
export function enumerateCandidatePairs(options: {
  readonly whitelist: Whitelist;
  readonly chainIds?: readonly ChainId[];
}): readonly PoolCandidatePair[] {
  const { whitelist } = options;
  const pairs: PoolCandidatePair[] = [];
  for (const chainId of options.chainIds ?? whitelist.chains) {
    const stockTokens = whitelist.registry
      .listStockTokens({ autoTradeOnly: true })
      .filter((token) => token.chainId === chainId);
    const stablecoins = whitelist.registry
      .listStablecoins()
      .filter((token) => token.chainId === chainId);
    const dexes = whitelist.dexes
      .filter((entry) => entry.chainId === chainId)
      .map((entry) => entry.dex);
    for (const stockToken of stockTokens) {
      for (const stablecoin of stablecoins) {
        for (const dex of dexes) {
          pairs.push({ chainId, stockToken: stockToken.address, stablecoin: stablecoin.address, dex });
        }
      }
    }
  }
  return pairs;
}

/**
 * §14/§15 scanner.
 *
 * One provider call per chain discovers *all* candidate pools at once (GeckoTerminal is queried per
 * stock token, DexPaprika per stock token, the chain once). The per-(pair, feeTier) loop only *matches*
 * discovered pools against candidate combinations — it performs no I/O, so the loop is pure bookkeeping
 * rather than a request fan-out (architecture §3).
 */
export class PoolScanner {
  readonly #config: StrategyConfig;
  readonly #provider: PoolDataProvider;
  readonly #chainIds: readonly ChainId[];
  readonly #feeTiersByDex: Readonly<Record<string, readonly FeeTier[]>>;

  constructor(options: PoolScannerOptions) {
    this.#config = options.config;
    this.#provider = options.provider;
    this.#chainIds = options.chainIds ?? options.config.whitelist.chains;
    this.#feeTiersByDex = options.feeTiersByDex ?? DEX_FEE_TIERS;
  }

  get chainIds(): readonly ChainId[] {
    return this.#chainIds;
  }

  /** §96: an empty whitelist must refuse to run rather than report "no pools". */
  assertScannable(): void {
    this.#config.whitelist.assertWhitelistNonEmpty();
    if (this.#chainIds.length === 0) {
      throw new PoolDataError(
        POOL_DATA_ERROR_CODES.INVALID_ARGUMENT,
        'no chain to scan: the chain whitelist is empty (§11)',
      );
    }
    for (const chainId of this.#chainIds) {
      for (const entry of this.#config.whitelist.dexes.filter((dex) => dex.chainId === chainId)) {
        this.#config.whitelist.assertWhitelistedDex(chainId, entry.dex);
      }
    }
  }

  /**
   * Scan every candidate pair on every configured chain.
   *
   * The discovery call is made once per chain (GeckoTerminal is queried per stock token,
   * DexPaprika per stock token) rather than per (pair, fee tier); the fan-out only exists for the
   * cheap `eth_call` factory existence probe.
   *
   * The provider owns its own TTL cache, and the §14 cadence (60 min) is far longer than that TTL,
   * so no second cache layer is needed here.
   */
  async scan(): Promise<PoolScanSummary> {
    this.assertScannable();
    const failures: PoolSourceFailure[] = [];
    const probes: PoolProbe[] = [];
    const onchainVerifiedByPool: Record<PoolId, boolean> = {};
    const pairs = enumerateCandidatePairs({
      whitelist: this.#config.whitelist,
      chainIds: this.#chainIds,
    });

    const poolsByChain = new Map<ChainId, readonly PoolSnapshot[]>();
    for (const chainId of this.#chainIds) {
      const chainPairs = pairs.filter((pair) => pair.chainId === chainId);
      if (chainPairs.length === 0) continue;
      const query: PoolDiscoveryQuery = {
        chainId,
        tokenAddresses: dedupeAddresses(chainPairs.map((pair) => pair.stockToken)),
        stablecoinAddresses: dedupeAddresses(chainPairs.map((pair) => pair.stablecoin)),
        dexes: [...new Set(chainPairs.map((pair) => pair.dex))],
      };
      if (supportsDetail(this.#provider)) {
        const result = await this.#provider.getPoolsDetailed(query);
        poolsByChain.set(chainId, result.pools);
        failures.push(...result.failures);
        for (const diagnostic of result.diagnostics ?? []) {
          onchainVerifiedByPool[diagnostic.poolId] = diagnostic.onchainVerified;
        }
      } else {
        // A provider without the detail surface cannot report failures, so "no pool discovered"
        // would be indistinguishable from "the source failed" — record that as a fatal limitation
        // instead of pretending the scan was complete (fail closed).
        const pools = await this.#provider.getPools(query);
        poolsByChain.set(chainId, pools);
        failures.push({
          source: DATA_SOURCES.UNAVAILABLE,
          scope: 'discovery',
          severity: POOL_SOURCE_FAILURE_SEVERITIES.FATAL,
          message: `${this.#provider.name}: provider exposes no getPoolsDetailed, so "no pool exists" cannot be distinguished from "the source failed"`,
        });
      }
    }

    const discoveryFailedByToken = new Set<Address>();
    for (const failure of failures) {
      if (failure.scope === 'discovery' && failure.subject !== undefined) {
        discoveryFailedByToken.add(failure.subject);
      }
    }
    const discoveryTruncated =
      failures.some((failure) => failure.severity === 'fatal' && failure.scope === 'discovery') &&
      discoveryFailedByToken.size === 0;

    for (const chainId of this.#chainIds) {
      const chainPairs = pairs.filter((pair) => pair.chainId === chainId);
      const pools = poolsByChain.get(chainId) ?? [];
      for (const dex of [...new Set(chainPairs.map((pair) => pair.dex))]) {
        const dexPairs = chainPairs.filter((pair) => pair.dex === dex);
        for (const feeTier of this.#feeTiersByDex[dex] ?? []) {
          for (const pair of dexPairs) {
            const match = this.#matchSnapshot(pools, pair, feeTier);
            if (match !== null) {
              probes.push({
                chainId,
                dex,
                feeTier,
                stockToken: pair.stockToken,
                stablecoin: pair.stablecoin,
                existence: POOL_EXISTENCE.FOUND,
                evidence: POOL_EXISTENCE_EVIDENCE.HTTP_DISCOVERY,
                snapshot: match,
                note: `discovered as ${match.poolId}`,
              });
              continue;
            }
            // Not discovered for this (pair, fee tier). Module 1 makes NO chain call (architecture §3),
            // so the only honest answer is one of two, and they must never be conflated:
            //   · the source failed for this token  → UNVERIFIED (a pool here may simply be unread)
            //   · the source answered               → NOT_LISTED (no such pool in its results)
            const discoveryFailed = discoveryFailedByToken.has(pair.stockToken);
            probes.push({
              chainId,
              dex,
              feeTier,
              stockToken: pair.stockToken,
              stablecoin: pair.stablecoin,
              existence: discoveryFailed ? POOL_EXISTENCE.UNVERIFIED : POOL_EXISTENCE.NOT_LISTED,
              evidence: discoveryFailed
                ? POOL_EXISTENCE_EVIDENCE.DISCOVERY_FAILED
                : discoveryTruncated
                  ? POOL_EXISTENCE_EVIDENCE.DISCOVERY_TRUNCATED
                  : POOL_EXISTENCE_EVIDENCE.HTTP_NOT_LISTED,
              note: discoveryFailed
                ? 'a discovery source failed for this stock token during this scan; whether this pool exists cannot be asserted'
                : discoveryTruncated
                  ? 'discovery reported more pages than were read, so this pool may exist beyond the pages read'
                  : `the discovery source listed no ${dex} pool for this pair at fee ${feeTier}`,
            });
            continue;
          }
        }
      }
    }

    const pools: PoolSnapshot[] = [];
    for (const chainId of this.#chainIds) pools.push(...(poolsByChain.get(chainId) ?? []));

    const blockers = failures
      .filter((failure) => failure.severity === POOL_SOURCE_FAILURE_SEVERITIES.FATAL)
      .map((failure) => `[${failure.source}/${failure.scope}] ${failure.message}`);
    for (const probe of probes) {
      if (probe.existence !== POOL_EXISTENCE.UNVERIFIED) continue;
      blockers.push(
        `[${String(probe.chainId)}/${probe.dex}/${probe.feeTier}] ${probe.stockToken}/${probe.stablecoin}: ${probe.evidence} — ${probe.note ?? 'no reason recorded'}`,
      );
    }

    const primaryChain = this.#chainIds[0] ?? 0;
    return {
      chainId: primaryChain,
      scannedAt: new Date().toISOString(),
      feeTiersByDex: this.#feeTiersByDex,
      stockTokens: dedupeAddresses(
        pairs.filter((pair) => pair.chainId === primaryChain).map((pair) => pair.stockToken),
      ),
      stablecoins: dedupeAddresses(
        pairs.filter((pair) => pair.chainId === primaryChain).map((pair) => pair.stablecoin),
      ),
      dexes: [...new Set(pairs.map((pair) => pair.dex))],
      probes,
      pools,
      onchainVerifiedByPool,
      failures,
      complete: blockers.length === 0,
      blockers,
    };
  }

  /**
   * Match a discovered snapshot to a (pair, feeTier) probe.
   *
   * Token order is deliberately NOT assumed — the pool's `token0/token1` come from the chain, so
   * the match is set-based. A snapshot whose `feeTier` is the unknown sentinel `0` (no RPC and no
   * GeckoTerminal percentage) matches nothing: the fee tier is part of the factory probe key, so it
   * cannot be guessed.
   */
  #matchSnapshot(
    pools: readonly PoolSnapshot[],
    pair: PoolCandidatePair,
    feeTier: FeeTier,
  ): PoolSnapshot | null {
    const legs = new Set([pair.stockToken.toLowerCase(), pair.stablecoin.toLowerCase()]);
    for (const pool of pools) {
      if (pool.dex !== pair.dex) continue;
      if (!legs.has(pool.token0.toLowerCase()) || !legs.has(pool.token1.toLowerCase())) continue;
      if (pool.feeTier !== feeTier) continue;
      return pool;
    }
    return null;
  }

}

export function createPoolScanner(options: PoolScannerOptions): PoolScanner {
  return new PoolScanner(options);
}

/** Every `found` pool, in discovery order — the input to `filterPools`. */
export function foundPools(summary: PoolScanSummary): readonly PoolSnapshot[] {
  return summary.pools;
}

/**
 * `filterPools` with the scan's own on-chain verification flags attached.
 *
 * The two ways of building a verdict must never drift, so this lives next to the scanner rather
 * than in the smoke script: a discovered pool whose `tick`/`liquidity`/`fee` were not read cannot
 * be shown to satisfy §16's swap-impact gate or §34's tick alignment, and is rejected as
 * `ONCHAIN_UNVERIFIED` instead of being compared against a placeholder (§96).
 */
export function filterScannedPools(
  summary: PoolScanSummary,
  thresholds: PoolFilterThresholds,
  evaluatedAt: IsoTimestamp,
): PoolFilterOutcome {
  return filterPools(summary.pools, thresholds, {
    evaluatedAt,
    isOnchainVerified: (snapshot) => summary.onchainVerifiedByPool[snapshot.poolId] ?? false,
  });
}

/**
 * Combinations the discovery source listed no pool for, formatted for the operator log.
 *
 * Named `describeNotListed` rather than `describeAbsences` on purpose: without a chain probe there is no
 * proof of absence (architecture §3), and a function named for proof would invite a caller to treat this
 * as one.
 */
export function describeNotListed(summary: PoolScanSummary): readonly string[] {
  return summary.probes
    .filter((probe) => probe.existence === POOL_EXISTENCE.NOT_LISTED)
    .map(
      (probe) =>
        `${probe.dex} ${probe.stockToken}/${probe.stablecoin} fee ${probe.feeTier}: ${probe.note ?? 'not listed'}`,
    );
}

/** Unverifiable probes, formatted for the operator log (these are what make a scan incomplete). */
export function describeUnverified(summary: PoolScanSummary): readonly string[] {
  return summary.probes
    .filter((probe) => probe.existence === POOL_EXISTENCE.UNVERIFIED)
    .map(
      (probe) =>
        `${probe.dex} ${probe.stockToken}/${probe.stablecoin} fee ${probe.feeTier}: ${probe.evidence}`,
    );
}

export { poolIdFor };
