import type { Address, ChainId, DexId, TokenId } from './primitives.ts';
import type { TokenMeta } from './token.ts';

/**
 * The whitelist Registry contract (baseline §8/§9/§10/§12).
 *
 * IDENTITY CONTRACT — frozen:
 * - Lookup is ONLY by `(chainId, contractAddress)`; the address is lowercased before comparison.
 * - There is deliberately NO symbol→token lookup. `QQQB`/`QQQx`/`QQQon` and the 8-decimal
 *   impostor contracts coexist on BSC (research §1), and on-chain ticker casing is inconsistent,
 *   so symbol-based resolution would be an identity vulnerability. Symbols may only be used to
 *   render output that came from an address lookup.
 * - Unknown addresses return `null` (or throw from `requireTokenByAddress`) — never a guess.
 * - A registry may span several whitelisted chains, so `chainId` is part of every key.
 */
export interface TokenRegistry {
  /** Chains that have at least one whitelisted token. */
  readonly chains: readonly ChainId[];

  /** `null` when the address is not whitelisted on that chain. */
  getTokenByAddress(chainId: ChainId, address: Address): TokenMeta | null;
  /** Throws `WhitelistError` when the address is not whitelisted. Fail-closed helper. */
  requireTokenByAddress(chainId: ChainId, address: Address): TokenMeta;
  /** Whitelisted stock-token legs (§9), optionally filtered to auto-tradeable ones. */
  listStockTokens(options?: { readonly autoTradeOnly?: boolean }): readonly TokenMeta[];
  /** Whitelisted stablecoins (§10), ordered by §87 priority (USDC before USDT). */
  listStablecoins(): readonly TokenMeta[];
  /** Every whitelisted token (stock tokens + stablecoins + wrapped native), for iteration. */
  list(): readonly TokenMeta[];
  /** Addresses only — the shape every on-chain call actually needs. */
  listAddresses(chainId?: ChainId): readonly Address[];
  /** Canonical token id for address comparison/keys: `${chainId}:${lowercased address}`. */
  idFor(chainId: ChainId, address: Address): TokenId;
  /** §96 fail closed: a build must be refused when this is empty. */
  isEmpty(): boolean;
  /** Throws when the registry is empty (§96 / iteration constraint). */
  assertNonEmpty(): void;
}

/** One whitelisted DEX for one chain (§12). */
export interface WhitelistDexEntry {
  readonly chainId: ChainId;
  readonly dex: DexId;
}

/**
 * Overall whitelist view: chains (§11) + DEXes (§12) + token registry (§8/§9/§10).
 * `isWhitelisted*` return booleans so callers can shape their own error; the `assert*` helpers
 * fail closed with a descriptive error.
 */
export interface Whitelist {
  readonly chains: readonly ChainId[];
  readonly dexes: readonly WhitelistDexEntry[];
  readonly registry: TokenRegistry;
  isWhitelistedChain(chainId: ChainId): boolean;
  isWhitelistedDex(chainId: ChainId, dex: DexId): boolean;
  assertWhitelistedChain(chainId: ChainId): void;
  assertWhitelistedDex(chainId: ChainId, dex: DexId): void;
  /** §96: refuses to run when no token is whitelisted (an empty whitelist must never trade). */
  assertWhitelistNonEmpty(): void;
  /** Convenience delegation to the registry (`getTokenByAddress` by name — the only lookup). */
  getTokenByAddress(chainId: ChainId, address: Address): TokenMeta | null;
  /** Convenience delegation to the registry (throws when not whitelisted). */
  requireTokenByAddress(chainId: ChainId, address: Address): TokenMeta;
}

/** Thrown for every whitelist violation; carries the offending identity for the audit log. */
export class WhitelistError extends Error {
  readonly chainId?: ChainId;
  readonly address?: Address;
  readonly dex?: DexId;

  constructor(
    message: string,
    context: { chainId?: ChainId; address?: Address; dex?: DexId } = {},
  ) {
    super(message);
    this.name = 'WhitelistError';
    this.chainId = context.chainId;
    this.address = context.address;
    this.dex = context.dex;
  }
}
