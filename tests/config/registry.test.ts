import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEX_IDS, TOKEN_KINDS } from '../../src/types/primitives.ts';
import {
  BSC_ADDRESSES,
  BSC_BSTOCKS,
  BUILTIN_TOKENS,
  BSC_DEX_CONTRACTS,
} from '../../src/config/builtins.ts';
import {
  InMemoryTokenRegistry,
  createBuiltinRegistry,
  mergeTokensWithOverrides,
  tokenIdFor,
} from '../../src/config/registry.ts';
import {
  ConfigError,
  createWhitelist,
  loadConfig,
  parseStrategyYaml,
  parseTokenOverrides,
} from '../../src/config/index.ts';
import { WhitelistError } from '../../src/types/registry.ts';

const QQQB = '0x205812CdBed920aFf76C6580abD681a46D11efc7';
const QQQB_LOWER = '0x205812cdbed920aff76c6580abd681a46d11efc7';
const USDC = '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d';
const IMPOSTOR = '0xb904108b7f6d3b27c23128ca2b62738061b8a689';


/**
 * Load the repository config with a patched `strategy.yaml`.
 *
 * Cross-field invariants only run inside `loadConfig` (a per-field schema cannot express them), so
 * they must be exercised through the real loader rather than `parseStrategyYaml`.
 */
async function loadConfigWithStrategyPatch(patch: string): Promise<unknown> {
  const dir = await mkdtemp(path.join(tmpdir(), 'lptrader-config-'));
  const [tokensText, stableText] = await Promise.all([
    readFile('config/tokens.yaml', 'utf8'),
    readFile('config/stablecoins.yaml', 'utf8'),
  ]);
  await Promise.all([
    writeFile(path.join(dir, 'strategy.yaml'), `${patch}\nwhitelist:\n  chains: [56]\n`),
    writeFile(path.join(dir, 'tokens.yaml'), tokensText),
    writeFile(path.join(dir, 'stablecoins.yaml'), stableText),
  ]);
  return loadConfig({ configDir: dir });
}

describe('token registry — address is the only identity', () => {
  it('resolves by contract address and normalises checksummed input', () => {
    const registry = createBuiltinRegistry();
    const checksummed = registry.getTokenByAddress(56, QQQB);
    const lowered = registry.getTokenByAddress(56, QQQB_LOWER);
    expect(checksummed?.symbol).toBe('QQQB');
    expect(lowered?.id).toBe(tokenIdFor(56, QQQB_LOWER));
    expect(checksummed?.id).toBe(lowered?.id);
  });

  it('returns null for an address that is not whitelisted (impostor contract)', () => {
    const registry = createBuiltinRegistry();
    expect(registry.getTokenByAddress(56, IMPOSTOR)).toBeNull();
    expect(() => registry.requireTokenByAddress(56, IMPOSTOR)).toThrow(WhitelistError);
  });

  it('does not expose any symbol→address resolution', () => {
    const registry = createBuiltinRegistry();
    const surface = registry as unknown as Record<string, unknown>;
    for (const forbidden of ['getBySymbol', 'getTokenBySymbol', 'resolveSymbol', 'findBySymbol']) {
      expect(surface[forbidden]).toBeUndefined();
    }
    // The only lookup that exists is address-keyed.
    expect(typeof registry.getTokenByAddress).toBe('function');
  });

  it('keeps a whitelisted symbol from being treated as an identity by proxy', () => {
    const registry = createBuiltinRegistry();
    const impostor = registry.getTokenByAddress(56, IMPOSTOR);
    expect(impostor).toBeNull();
    // A symbol string must never satisfy any registry call.
    expect(() => registry.requireTokenByAddress(56, 'QQQB' as `0x${string}`)).toThrow(WhitelistError);
  });

  it('fails closed when the whitelist is empty', () => {
    const empty = new InMemoryTokenRegistry([]);
    expect(empty.isEmpty()).toBe(true);
    expect(() => empty.assertNonEmpty()).toThrow(/empty/u);
    const whitelist = createWhitelist([], [56], [{ chainId: 56, dex: DEX_IDS.PANCAKESWAP_V3 }]);
    expect(() => whitelist.assertWhitelistNonEmpty()).toThrow(/empty/u);
  });

  it('rejects duplicate addresses (identity must be unique)', () => {
    const duplicate = [...BSC_BSTOCKS, { ...BSC_BSTOCKS[0]! }];
    expect(() => new InMemoryTokenRegistry(duplicate)).toThrow(/duplicate/u);
  });
});

describe('builtin whitelist contents', () => {
  const registry = createBuiltinRegistry();

  it('contains the 8 official bStocks with 18 decimals and bstocks kind', () => {
    const stocks = registry.listStockTokens();
    expect(stocks).toHaveLength(8);
    expect(stocks.every((token) => token.decimals === 18)).toBe(true);
    expect(stocks.every((token) => token.kind === TOKEN_KINDS.BSTOCKS)).toBe(true);
    expect(stocks.map((token) => token.symbol).sort()).toEqual(
      ['AAPLB', 'AMZNB', 'METAB', 'MSFTB', 'NVDAB', 'PLTRB', 'QQQB', 'TSLAB'].sort(),
    );
  });

  it('marks CORE auto-tradeable and HIGH_VOL monitor-only', () => {
    const core = registry.listStockTokens({ autoTradeOnly: true }).map((token) => token.symbol);
    expect(core.sort()).toEqual(['AAPLB', 'AMZNB', 'METAB', 'MSFTB', 'QQQB']);
    const monitorOnly = registry
      .listStockTokens()
      .filter((token) => !token.autoTrade)
      .map((token) => token.symbol);
    expect(monitorOnly.sort()).toEqual(['NVDAB', 'PLTRB', 'TSLAB']);
  });

  it('contains the stablecoins with BSC 18-decimal PEG addresses ordered by priority', () => {
    const stables = registry.listStablecoins();
    expect(stables.map((token) => token.symbol)).toEqual(['USDC', 'USDT']);
    expect(stables.every((token) => token.decimals === 18)).toBe(true);
    expect(stables[0]?.address).toBe(BSC_ADDRESSES.USDC);
    expect(stables[1]?.address).toBe(BSC_ADDRESSES.USDT);
  });

  it('contains WBNB as the wrapped native leg', () => {
    const wbnb = registry.getTokenByAddress(56, BSC_ADDRESSES.WBNB);
    expect(wbnb?.kind).toBe(TOKEN_KINDS.WRAPPED_NATIVE);
    expect(wbnb?.decimals).toBe(18);
    expect(wbnb?.autoTrade).toBe(false);
  });

  it('uses PancakeSwap own Permit2 deployment, not Uniswap canonical', () => {
    const pancake = BSC_DEX_CONTRACTS[DEX_IDS.PANCAKESWAP_V3];
    const uniswap = BSC_DEX_CONTRACTS[DEX_IDS.UNISWAP_V3];
    expect(pancake?.permit2).not.toBe(uniswap?.permit2);
    expect(uniswap?.permit2).toBe('0x000000000022d473030f116ddee9f6b43ac78ba3');
  });
});

describe('config overrides', () => {
  it('lets config re-tier a builtin but cannot change decimals or drop it', () => {
    const merged = mergeTokensWithOverrides(BUILTIN_TOKENS, [
      {
        chainId: 56,
        address: QQQB_LOWER as `0x${string}`,
        symbol: 'QQQB',
        riskTier: 'HIGH_VOL',
        autoTrade: false,
        fromStablecoinsFile: false,
      },
    ]);
    const qqqb = merged.find((token) => token.address === QQQB_LOWER);
    expect(qqqb?.riskTier).toBe('HIGH_VOL');
    expect(qqqb?.autoTrade).toBe(false);
    expect(qqqb?.decimals).toBe(18);
    expect(qqqb?.kind).toBe(TOKEN_KINDS.BSTOCKS);
    // Every other builtin survives an override of just one entry.
    expect(merged).toHaveLength(BUILTIN_TOKENS.length);
  });

  it('rejects an override that contradicts a builtin decimal count', () => {
    expect(() =>
      mergeTokensWithOverrides(BUILTIN_TOKENS, [
        {
          chainId: 56,
          address: USDC as `0x${string}`,
          symbol: 'USDC',
          decimals: 6,
          fromStablecoinsFile: true,
        },
      ]),
    ).toThrow(/decimals/u);
  });

  it('defaults an added unknown token to non-auto-tradeable, and requires decimals', () => {
    expect(() =>
      mergeTokensWithOverrides(BUILTIN_TOKENS, [
        {
          chainId: 56,
          address: IMPOSTOR as `0x${string}`,
          symbol: 'QQQx',
          fromStablecoinsFile: false,
        },
      ]),
    ).toThrow(/decimals/u);

    const merged = mergeTokensWithOverrides(BUILTIN_TOKENS, [
      {
        chainId: 56,
        address: IMPOSTOR as `0x${string}`,
        symbol: 'QQQx',
        decimals: 18,
        fromStablecoinsFile: false,
      },
    ]);
    const added = merged.find((token) => token.address === IMPOSTOR);
    expect(added?.autoTrade).toBe(false);
    expect(added?.riskTier).toBe('HIGH_VOL');
  });

  it('parses the shipped tokens.yaml and stablecoins.yaml without error', async () => {
    const [tokensText, stableText] = await Promise.all([
      readFile('config/tokens.yaml', 'utf8'),
      readFile('config/stablecoins.yaml', 'utf8'),
    ]);
    const overrides = parseTokenOverrides(tokensText, stableText);
    expect(overrides).toHaveLength(11);
    expect(overrides.filter((entry) => entry.fromStablecoinsFile)).toHaveLength(2);
    expect(overrides.every((entry) => entry.address === entry.address.toLowerCase())).toBe(true);
  });
});

describe('loadConfig', () => {
  it('loads the repository config and exposes whitelist helpers', async () => {
    const config = await loadConfig({ cwd: process.cwd() });
    expect(config.whitelist.isWhitelistedChain(56)).toBe(true);
    expect(config.whitelist.isWhitelistedChain(1)).toBe(false);
    expect(config.whitelist.isWhitelistedDex(56, DEX_IDS.PANCAKESWAP_V3)).toBe(true);
    expect(config.whitelist.isWhitelistedDex(56, 'sushiswap' as never)).toBe(false);
    expect(() => config.whitelist.assertWhitelistedChain(1)).toThrow(WhitelistError);
    expect(() =>
      config.whitelist.assertWhitelistedDex(56, 'sushiswap' as never),
    ).toThrow(WhitelistError);
    config.whitelist.assertWhitelistNonEmpty();
    expect(config.whitelist.getTokenByAddress(56, QQQB_LOWER)?.symbol).toBe('QQQB');
    expect(() => config.whitelist.requireTokenByAddress(56, IMPOSTOR)).toThrow(WhitelistError);
    expect(config.whitelist.requireTokenByAddress(56, QQQB_LOWER).symbol).toBe('QQQB');
  });

  it('applies the baseline defaults and the approvals/telegram additions', async () => {
    const config = await loadConfig({ cwd: process.cwd() });
    expect(config.capital.maxLpRatio).toBe(0.7);
    expect(config.range.lowerRatio).toBe(0.85);
    expect(config.range.upperRatio).toBe(1.16);
    expect(config.swap.maxPriceImpact).toBe(0.005);
    expect(config.fees.autoCompound).toBe(false);
    expect(config.approvals).toEqual({
      buildPosition: 'confirm',
      switchPool: 'confirm',
      others: 'auto',
      timeoutMinutes: 30,
    });
    expect(config.telegram.enabled).toBe(false);
    expect(config.whitelist.registry.list()).toHaveLength(BUILTIN_TOKENS.length);
  });

  it('works with builtins only, without touching disk', async () => {
    const config = await loadConfig({ useBuiltinsOnly: true });
    expect(config.sourcePath).toBe('<builtins>');
    expect(config.whitelist.registry.list()).toHaveLength(BUILTIN_TOKENS.length);
    expect(config.whitelist.isWhitelistedDex(56, DEX_IDS.UNISWAP_V3)).toBe(true);
  });

  it('rejects unknown keys instead of silently ignoring a typo', () => {
    expect(() => parseStrategyYaml('strategy:\n  risk:\n    max_drawdwn: 0.2\n')).toThrow(
      ConfigError,
    );
  });

  it('rejects an out-of-range threshold', () => {
    expect(() => parseStrategyYaml('strategy:\n  swap:\n    max_slippage: 1.5\n')).toThrow(
      /max_slippage/u,
    );
  });

  it('rejects a depeg ladder that is not strictly increasing', async () => {
    await expect(
      loadConfigWithStrategyPatch(
        ['strategy:', '  risk:', '    peg_warning: 0.05', '    emergency_exit: 0.02'].join('\n'),
      ),
    ).rejects.toThrow(/depeg ladder must increase/u);
  });

  it('rejects a swap impact gate looser than the pool filter', async () => {
    await expect(
      loadConfigWithStrategyPatch(
        [
          'strategy:',
          '  swap:',
          '    max_price_impact: 0.02',
          '  pool:',
          '    max_swap_price_impact: 0.005',
        ].join('\n'),
      ),
    ).rejects.toThrow(/pool\.max_swap_price_impact/u);
  });

  it('rejects a capital split that exceeds 100%', async () => {
    await expect(
      loadConfigWithStrategyPatch(
        ['strategy:', '  capital:', '    max_lp_ratio: 0.8', '    reserve_ratio: 0.3'].join('\n'),
      ),
    ).rejects.toThrow(/must be <= 1/u);
  });

  it('rejects auto_compound: true (V1 must never compound)', () => {
    expect(() => parseStrategyYaml('strategy:\n  fees:\n    auto_compound: true\n')).toThrow(
      ConfigError,
    );
  });

  it('rejects a DEX whitelisted on an unlisted chain', () => {
    expect(() =>
      createWhitelist(BUILTIN_TOKENS, [56], [{ chainId: 97, dex: DEX_IDS.PANCAKESWAP_V3 }]),
    ).toThrow(/not in the chain whitelist/u);
  });
});
