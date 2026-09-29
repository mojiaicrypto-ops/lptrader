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
import type { DexAdapter, PoolDataProvider, PoolDiscoveryQuery } from '../types/adapters.ts';
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

export const POOL_EXISTENCE = {
  /** Discovered (and, when possible, confirmed by the on-chain factory). */
  FOUND: 'found',
  /** Proven absent: the on-chain factory returned the zero address. */
  ABSENT: 'absent',
  /** Unknown: nothing was discovered, and absence could not be proven. */
  UNVERIFIED: 'unverified',
} as const;
export type PoolExistence = (typeof POOL_EXISTENCE)[keyof typeof POOL_EXISTENCE];

export const POOL_EXISTENCE_EVIDENCE = {
  /** Discovered through the HTTP discovery layer. */
  HTTP_DISCOVERY: 'http-discovery',
  /** Confirmed independently by `factory.getPool(tokenA, tokenB, fee)`. */
  ONCHAIN_FACTORY: 'onchain-factory',
  /** The factory answered with the zero address — an authoritative absence. */
  ONCHAIN_FACTORY_ABSENT: 'onchain-factory-absent',
  /** No factory probe is wired, so absence cannot be asserted (fail closed). */
  NO_FACTORY_PROBE: 'no-factory-probe',
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
  /** Present iff `existence === 'absent'` (the on-chain factory answer). */
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
   * `PoolSnapshot` has no availability bit on those raw fields, so §16's filter needs this beside
   * the snapshot: a pool present in `pools` but `false` here must be rejected by
   * `filterScannedPools` rather than evaluated against a placeholder `tick`/`liquidity` (§96).
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
   * Per-DEX adapters, used for the authoritative `factory.getPool(...)` existence probe (§82).
   * Optional: without it, "no pool discovered" stays `unverified` rather than becoming `absent`.
   */
  readonly dexAdapters?: readonly DexAdapter[];
  /**
   * Raw on-chain factory probe, used when a `DexAdapter` is not wired for this DEX.
   * `null` means "the factory answered with the zero address" = a proven absence.
   */
  readonly findOnchainPool?: (params: {
    readonly chainId: ChainId;
    readonly dex: DexId;
    readonly tokenA: Address;
    readonly tokenB: Address;
    readonly feeTier: FeeTier;
  }) => Promise<Address | null>;
  /** Chains to scan. Defaults to `config.whitelist.chains`. */
  readonly chainIds?: readonly ChainId[];
  /**
   * Fee tiers probed per DEX for the factory existence check. CLMM pools are fee-tier keyed, so
   * "no pool exists" is only provable by probing the tiers the DEX supports (research §5:
   * Pancake 100/500/2500/10000, Uniswap 500/3000/10000).
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
 * stock token, DexPaprika per stock token, the chain once) — the per-(pair, feeTier) fan-out only
 * exists for the *existence* probe, which is a cheap `eth_call` to the factory.
 */
export class PoolScanner {
  readonly #config: StrategyConfig;
  readonly #provider: PoolDataProvider;
  readonly #dexAdapters: ReadonlyMap<DexId, DexAdapter>;
  readonly #findOnchainPool: PoolScannerOptions['findOnchainPool'];
  readonly #chainIds: readonly ChainId[];
  readonly #feeTiersByDex: Readonly<Record<string, readonly FeeTier[]>>;

  constructor(options: PoolScannerOptions) {
    this.#config = options.config;
    this.#provider = options.provider;
    const adapters = new Map<DexId, DexAdapter>();
    for (const adapter of options.dexAdapters ?? []) adapters.set(adapter.dex, adapter);
    this.#dexAdapters = adapters;
    this.#findOnchainPool = options.findOnchainPool;
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
            // Not discovered for this (pair, fee tier): absent, or simply not read?
            const onchainAddress = await this.#proveExistence({
              chainId,
              dex,
              feeTier,
              pair,
            });
            // The probe answers three distinct things and they MUST NOT be conflated: a real
            // address (the pool exists — `#proveExistence` passes it through, JSON-RPC lowercased),
            // the `'absent'` sentinel (the factory answered the zero address = proven absence), and
            // `null` (nothing wired / the probe failed). `typeof x === 'string'` is true for BOTH
            // strings, so it would report a pool that was just FOUND as "proven absent".
            if (onchainAddress === 'absent') {
              probes.push({
                chainId,
                dex,
                feeTier,
                stockToken: pair.stockToken,
                stablecoin: pair.stablecoin,
                existence: POOL_EXISTENCE.ABSENT,
                evidence: POOL_EXISTENCE_EVIDENCE.ONCHAIN_FACTORY_ABSENT,
                note: `proven absent: factory.getPool returned the zero address for fee ${feeTier}`,
              });
              continue;
            }
            if (typeof onchainAddress === 'string') {
              probes.push({
                chainId,
                dex,
                feeTier,
                stockToken: pair.stockToken,
                stablecoin: pair.stablecoin,
                existence: POOL_EXISTENCE.FOUND,
                evidence: POOL_EXISTENCE_EVIDENCE.ONCHAIN_FACTORY,
                note: `factory.getPool confirms this pool exists at ${onchainAddress} (fee ${feeTier}), but no snapshot could be composed during this scan`,
              });
              continue;
            }
            const noProbe =
              this.#findOnchainPool === undefined && this.#dexAdapters.get(dex) === undefined;
            probes.push({
              chainId,
              dex,
              feeTier,
              stockToken: pair.stockToken,
              stablecoin: pair.stablecoin,
              existence: POOL_EXISTENCE.UNVERIFIED,
              evidence: discoveryFailedByToken.has(pair.stockToken)
                ? POOL_EXISTENCE_EVIDENCE.DISCOVERY_FAILED
                : noProbe
                  ? POOL_EXISTENCE_EVIDENCE.NO_FACTORY_PROBE
                  : discoveryTruncated
                    ? POOL_EXISTENCE_EVIDENCE.DISCOVERY_TRUNCATED
                    : POOL_EXISTENCE_EVIDENCE.NO_FACTORY_PROBE,
              note: discoveryFailedByToken.has(pair.stockToken)
                ? 'a discovery source failed for this stock token during this scan; absence cannot be asserted'
                : noProbe
                  ? 'no factory probe is wired, so absence cannot be proven (§96)'
                  : 'discovery was incomplete, so absence cannot be asserted',
            });
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

  /**
   * Ask the chain whether the pool exists.
   * Returns the pool address when found, the string `'absent'` for a proven zero-address answer,
   * and `null` when existence could not be determined (nothing wired, or the probe failed).
   */
  async #proveExistence(params: {
    chainId: ChainId;
    dex: DexId;
    feeTier: FeeTier;
    pair: PoolCandidatePair;
  }): Promise<Address | 'absent' | null> {
    const adapter = this.#dexAdapters.get(params.dex);
    if (adapter !== undefined) {
      try {
        const pool = await adapter.getPool(
          params.pair.stockToken,
          params.pair.stablecoin,
          params.feeTier,
        );
        return pool === null ? 'absent' : pool.poolAddress;
      } catch {
        return null;
      }
    }
    const probe = this.#findOnchainPool;
    if (probe === undefined) return null;
    try {
      const found = await probe({
        chainId: params.chainId,
        dex: params.dex,
        tokenA: params.pair.stockToken,
        tokenB: params.pair.stablecoin,
        feeTier: params.feeTier,
      });
      return found ?? 'absent';
    } catch {
      return null;
    }
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

/** Proven-absent (pair, feeTier) probes, formatted for the operator log. */
export function describeAbsences(summary: PoolScanSummary): readonly string[] {
  return summary.probes
    .filter((probe) => probe.existence === POOL_EXISTENCE.ABSENT)
    .map(
      (probe) =>
        `${probe.dex} ${probe.stockToken}/${probe.stablecoin} fee ${probe.feeTier}: ${probe.note ?? 'absent'}`,
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
