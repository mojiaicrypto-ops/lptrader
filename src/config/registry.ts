import { TOKEN_KINDS, TOKEN_RISK_TIERS } from '../types/primitives.ts';
import {
  UI_AMOUNT_MODES,
  type TokenMeta,
  type UiAmountPolicy,
} from '../types/token.ts';
import type { Address, ChainId, TokenId } from '../types/primitives.ts';
import { WhitelistError, type TokenRegistry } from '../types/registry.ts';
import { BUILTIN_TOKENS } from './builtins.ts';

/** Canonical token key — the ONLY identity used by the registry (baseline §8). */
export function tokenIdFor(chainId: ChainId, address: Address): TokenId {
  return `${chainId}:${address.toLowerCase()}`;
}

const BEP677_POLICY: UiAmountPolicy = {
  mode: UI_AMOUNT_MODES.BEP677_SCALED,
  multiplierDecimals: 18,
};
const PLAIN_POLICY: UiAmountPolicy = {
  mode: UI_AMOUNT_MODES.PLAIN,
  multiplierDecimals: 0,
};

/**
 * Immutable, address-keyed whitelist registry.
 *
 * Built from the builtin facts (`builtins.ts`) overlaid with the YAML entries. Overrides are
 * matched **by contract address**, so a config file cannot redefine a token to a different
 * contract while keeping its symbol, nor can it drop a builtin address (fail closed).
 */
export class InMemoryTokenRegistry implements TokenRegistry {
  readonly chains: readonly ChainId[];
  private readonly byKey: ReadonlyMap<string, TokenMeta>;

  constructor(tokens: readonly TokenMeta[]) {
    const map = new Map<string, TokenMeta>();
    for (const token of tokens) {
      const key = tokenIdFor(token.chainId, token.address);
      if (map.has(key)) {
        throw new WhitelistError(
          `duplicate whitelist entry for ${key} (address identity must be unique)`,
          { chainId: token.chainId, address: token.address },
        );
      }
      map.set(key, token);
    }
    this.byKey = map;
    this.chains = [...new Set(tokens.map((token) => token.chainId))].sort((a, b) => a - b);
  }

  getTokenByAddress(chainId: ChainId, address: Address): TokenMeta | null {
    return this.byKey.get(tokenIdFor(chainId, address)) ?? null;
  }

  requireTokenByAddress(chainId: ChainId, address: Address): TokenMeta {
    const token = this.getTokenByAddress(chainId, address);
    if (token === null) {
      throw new WhitelistError(
        `token ${address} is not whitelisted on chain ${chainId} (Contract Address > Token Symbol)`,
        { chainId, address },
      );
    }
    return token;
  }

  listStockTokens(options?: { readonly autoTradeOnly?: boolean }): readonly TokenMeta[] {
    return this.list().filter(
      (token) =>
        token.isStockToken && (!options?.autoTradeOnly || token.autoTrade),
    );
  }

  listStablecoins(): readonly TokenMeta[] {
    return this.list()
      .filter((token) => token.kind === TOKEN_KINDS.STABLECOIN)
      .sort((a, b) => (a.stablecoinPriority ?? 99) - (b.stablecoinPriority ?? 99));
  }

  list(): readonly TokenMeta[] {
    return [...this.byKey.values()];
  }

  listAddresses(chainId?: ChainId): readonly Address[] {
    return this.list()
      .filter((token) => chainId === undefined || token.chainId === chainId)
      .map((token) => token.address);
  }

  idFor(chainId: ChainId, address: Address): TokenId {
    return tokenIdFor(chainId, address);
  }

  isEmpty(): boolean {
    return this.byKey.size === 0;
  }

  assertNonEmpty(): void {
    if (this.isEmpty()) {
      throw new WhitelistError(
        'token whitelist is empty: refusing to operate (fail closed)',
      );
    }
  }
}

/** An override captured from YAML, already validated and normalised by `schema.ts`. */
export interface TokenOverride {
  readonly chainId: ChainId;
  readonly address: Address;
  readonly symbol: string;
  readonly name?: string;
  readonly decimals?: number;
  readonly riskTier?: TokenMeta['riskTier'];
  readonly autoTrade?: boolean;
  readonly notes?: string;
  /** Only meaningful for stablecoins (§87). */
  readonly stablecoinPriority?: number;
  /** Which file the override came from, so the merged role can be checked. */
  readonly fromStablecoinsFile: boolean;
}

/**
 * Merge builtin facts with YAML overrides, keyed by address.
 *
 * - A YAML entry whose address is not builtin is an ADDITION. Stock-token entries added this way
 *   default to `HIGH_VOL` + `auto_trade: false` (an unknown contract must never be auto-traded),
 *   stablecoin entries default to `CORE`. `decimals` cannot be defaulted safely for a new token,
 *   so it is required unless the entry is already builtin.
 * - A YAML entry with a builtin address OVERRIDES the mutable attributes (symbol/name/notes/
 *   risk tier/auto_trade/priority). Immutable facts (`decimals` for BEP-677 tokens, the
 *   `uiAmount` policy, `isStockToken`) are taken from the builtin so a config edit cannot turn a
 *   scaled token into a plain one. A contradicting `decimals` is an error.
 * - Builtin entries are never removed: the result always contains all builtins.
 */
export function mergeTokensWithOverrides(
  builtins: readonly TokenMeta[],
  overrides: readonly TokenOverride[],
): TokenMeta[] {
  const merged = new Map<string, TokenMeta>(
    builtins.map((token) => [tokenIdFor(token.chainId, token.address), token]),
  );

  for (const override of overrides) {
    const key = tokenIdFor(override.chainId, override.address);
    const builtin = merged.get(key);

    if (builtin === undefined) {
      if (override.decimals === undefined) {
        throw new WhitelistError(
          `token ${override.address} (${override.symbol}) is not a builtin entry and has no ` +
            `decimals; refusing to guess (fail closed)`,
          { chainId: override.chainId, address: override.address },
        );
      }
      merged.set(key, {
        id: key,
        chainId: override.chainId,
        address: override.address,
        kind: override.fromStablecoinsFile ? TOKEN_KINDS.STABLECOIN : TOKEN_KINDS.BSTOCKS,
        decimals: override.decimals,
        symbol: override.symbol,
        ...(override.name === undefined ? {} : { name: override.name }),
        riskTier: override.riskTier ?? TOKEN_RISK_TIERS.HIGH_VOL,
        autoTrade: override.autoTrade ?? false,
        isStockToken: !override.fromStablecoinsFile,
        uiAmount: override.fromStablecoinsFile ? PLAIN_POLICY : BEP677_POLICY,
        ...(override.stablecoinPriority === undefined
          ? {}
          : { stablecoinPriority: override.stablecoinPriority }),
        ...(override.notes === undefined ? {} : { notes: override.notes }),
      });
      continue;
    }

    if (override.decimals !== undefined && override.decimals !== builtin.decimals) {
      throw new WhitelistError(
        `token ${override.address} declares decimals=${override.decimals} but the builtin ` +
          `value is ${builtin.decimals}; decimals are an on-chain fact and cannot be overridden`,
        { chainId: override.chainId, address: override.address },
      );
    }

    merged.set(key, {
      ...builtin,
      symbol: override.symbol,
      ...(override.name === undefined ? {} : { name: override.name }),
      ...(override.riskTier === undefined ? {} : { riskTier: override.riskTier }),
      ...(override.autoTrade === undefined ? {} : { autoTrade: override.autoTrade }),
      ...(override.notes === undefined ? {} : { notes: override.notes }),
      ...(override.stablecoinPriority === undefined
        ? {}
        : { stablecoinPriority: override.stablecoinPriority }),
    });
  }

  return [...merged.values()];
}

/** The registry every run starts from: builtins only, no YAML required. */
export function createBuiltinRegistry(): TokenRegistry {
  return new InMemoryTokenRegistry(mergeTokensWithOverrides(BUILTIN_TOKENS, []));
}
