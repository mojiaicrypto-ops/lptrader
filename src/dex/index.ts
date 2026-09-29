/**
 * §82 DEX adapter factory and the cross-adapter invariants.
 *
 * ## Why the fee→tickSpacing table lives with the DEX, not the pool
 * PancakeSwap and Uniswap V3 do **not** share a fee enum. Pancake deploys 100/500/2500/10000 and
 * Uniswap deploys 100/500/3000/10000. Handing a Uniswap fee of `3000` to a Pancake lookup finds no
 * entry, and — worse — a lookup that fell back to a default would silently select the *wrong pool* for
 * the right token pair. So this module has no default: an unmapped fee is an error, and the mapping
 * is per-DEX by construction. `tickSpacingForFee` in the strategy layer is the same table the planner
 * uses, so the two can never disagree about a pool's grid.
 *
 * ## Why adapters are created here
 * Every adapter must pass its whitelist check before a caller can reach a quote or a calldata path.
 * Doing the `assertWhitelisted()` in the factory means a non-whitelisted DEX cannot be constructed at
 * all, rather than being caught later by whichever call happened to remember (§12).
 */
import type { BscChainAdapter } from '../chain/adapter.ts';
import type { DexAdapter } from '../types/adapters.ts';
import type { ChainId, DexId } from '../types/primitives.ts';
import type { Whitelist } from '../types/registry.ts';
import { DEX_IDS } from '../types/primitives.ts';
import { tickSpacingForFee } from '../strategy/positionPlanner.ts';

/** Per-DEX fee tiers, exactly as deployed. No default: an unknown fee tier is a mistake, not a guess. */
export const DEX_FEE_TIERS: Readonly<Record<DexId, readonly number[]>> = {
  // Pancake has no 3000 and no 60-spacing tier.
  [DEX_IDS.PANCAKESWAP_V3]: [100, 500, 2500, 10_000],
  // Uniswap has no 2500 and no 50-spacing tier.
  [DEX_IDS.UNISWAP_V3]: [100, 500, 3000, 10_000],
};

/**
 * Tick spacing for a fee tier on a specific DEX.
 *
 * Delegates to the planner's table so the pool grid used to align a position and the grid used to
 * build the calldata are the same number — a mismatch between those two is a mint that reverts, or
 * worse, a position on the wrong ticks.
 */
export function tickSpacingFor(dex: DexId, feeTier: number): number {
  return tickSpacingForFee(dex, feeTier);
}

/** Fee tiers this DEX can have a pool for. Used by the scanner's existence probe. */
export function feeTiersFor(dex: DexId): readonly number[] {
  const tiers = DEX_FEE_TIERS[dex];
  if (tiers === undefined) {
    throw new Error(`no fee tier table for DEX "${dex}"`);
  }
  return tiers;
}

export interface DexAdapterFactoryOptions {
  readonly chainId: ChainId;
  readonly whitelist: Whitelist;
  /**
   * The chain layer the adapter reads and writes through.
   *
   * Required, and deliberately NOT optional: every read and the one write path go through
   * `src/chain/**`, and the swap recipient comes from `chain.getSignerAddress()`. An adapter that
   * constructed its own `BscChainAdapter` would silently be signer-less in production while looking
   * correct in tests — so the chain is injected once, by the runtime, and never re-created.
   */
  readonly chain: BscChainAdapter;
  /** §40 slippage tolerance for quotes this adapter produces; defaults to the §40 value. */
  readonly slippageTolerance?: number;
  /** Injectable clock so `expiresAt` and quote freshness are deterministic under test. */
  readonly now?: () => Date;
}

/**
 * Every DEX this build can construct, in the order a build should prefer them.
 *
 * PancakeSwap first is deliberate and load-bearing: it is the only whitelisted venue whose router can
 * perform the §42 atomic swap+add-liquidity build (Uniswap V3's router multicall is a
 * self-delegatecall and cannot swap). Preferring it means the default path is the all-or-nothing one.
 */
export const DEX_PREFERENCE: readonly DexId[] = [DEX_IDS.PANCAKESWAP_V3, DEX_IDS.UNISWAP_V3];

/**
 * Build the adapter for one DEX, or throw.
 *
 * `constructors` is injected rather than imported so this module stays free of both SDK families: the
 * Pancake adapter pulls in `@pancakeswap/v3-sdk` and the Uniswap adapter must NOT share a module graph
 * with it (research §5 — the two `FeeAmount` enums would mis-select a pool).
 */
export function createDexAdapter(
  dex: DexId,
  options: DexAdapterFactoryOptions,
  constructors: Readonly<Partial<Record<DexId, (options: DexAdapterFactoryOptions) => DexAdapter>>>,
): DexAdapter {
  const factory = constructors[dex];
  if (factory === undefined) {
    throw new Error(
      `no adapter is registered for DEX "${dex}"; whitelisted: ${DEX_PREFERENCE.join(', ')} (§12 forbids entering an unknown DEX)`,
    );
  }
  const adapter = factory(options);
  if (adapter.dex !== dex) {
    throw new Error(`adapter for "${dex}" reports itself as "${adapter.dex}"`);
  }
  // §12: a DEX that is not whitelisted for this chain must never be usable.
  options.whitelist.assertWhitelistedChain(options.chainId);
  options.whitelist.assertWhitelistedDex(options.chainId, dex);
  adapter.assertWhitelisted();
  return adapter;
}

/**
 * The zero-address "pool does not exist" answer from `factory.getPool(token0, token1, fee)`.
 *
 * A pool address of zero is a **proven absence**; a thrown call is **not** (it is an unverifiable
 * read). The scanner depends on that distinction, so the constant and the meaning live together.
 */
export const NO_POOL = '0x0000000000000000000000000000000000000000' as const;

/** True when a factory answered with the zero address. */
export function isNoPool(address: string): boolean {
  return address.toLowerCase() === NO_POOL;
}
