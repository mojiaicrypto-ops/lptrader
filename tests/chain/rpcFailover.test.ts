/**
 * §99 multi-RPC behaviour: failover, the chain-id guard and cross-check disagreement.
 *
 * These tests drive the real `viem` transport stack against an in-memory JSON-RPC handler, because
 * the property under test *is* the classification of endpoint failures — a stubbed adapter would
 * assert nothing.
 */
import { describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import { createBuiltinRegistry } from '../../src/config/registry.ts';
import { createWhitelist, defaultDexWhitelist } from '../../src/config/index.ts';
import { BSC_ADDRESSES } from '../../src/config/builtins.ts';
import { BscChainAdapter } from '../../src/chain/adapter.ts';
import { CHAIN_ERROR_CODES, CrossCheckError, RpcNodeError } from '../../src/chain/errors.ts';
import { WhitelistError } from '../../src/types/registry.ts';
import { handlerTransport, resolveEndpoints } from '../../src/chain/rpc.ts';
import { ERC20_ABI } from '../../src/chain/abis.ts';
import { createMockNode, entry, MULTICALL3_MOCK_ADDRESS } from './mockNode.ts';
import { UI_AMOUNT_MODES, TOKEN_KINDS, TOKEN_RISK_TIERS } from '../../src/types/index.ts';
import type { TokenMeta } from '../../src/types/token.ts';

const USDC = BSC_ADDRESSES.USDC;
const WALLET = '0x1111111111111111111111111111111111111111' as const;

function whitelistFor(tokens: readonly TokenMeta[]) {
  return createWhitelist(tokens, [56], defaultDexWhitelist([56]));
}

/** Adapter bound to two mock endpoints, with a fixed balance answer per endpoint. */
function adapterWithEndpoints(
  balances: readonly bigint[],
  options: { readonly crossCheck?: boolean; readonly chainIds?: readonly number[] } = {},
) {
  const nodes = balances.map((balance, index) => {
    // Each endpoint gets its own contract table so a cross-check test controls both answers.

    const contracts: Record<string, Record<string, `0x${string}` | 'revert'>> = {};
    contracts[USDC.toLowerCase()] = entry({}, 'balanceOf(address)', balance);
    return createMockNode({
      contracts,
      chainId: options.chainIds?.[index] ?? 56,
    });
  });
  const adapter = new BscChainAdapter({
    chainId: 56,
    whitelist: whitelistFor(createBuiltinRegistry().list()),
    rpc: {
      endpoints: nodes.map((_endpoint, index) => ({ label: `node${index + 1}`, url: `mock://node${index + 1}` })),
      transportFactory: (endpoint) => {
        const index = Number(endpoint.label.replace('node', '')) - 1;
        return handlerTransport(nodes[index]!.handle);
      },
      crossCheckEndpoints: 2,
      retries: 0,
    },
    ...(options.crossCheck === undefined ? {} : { crossCheck: options.crossCheck }),
  });
  return { adapter, nodes };
}

describe('§99 multi-RPC failover', () => {
  it('falls over to the secondary endpoint when the primary transport fails', async () => {
    const primary = createMockNode({});
    const secondaryContracts: Record<string, Record<string, `0x${string}` | 'revert'>> = {
      [USDC.toLowerCase()]: entry({}, 'balanceOf(address)', 1_500n),
    };
    const secondary = createMockNode({ contracts: secondaryContracts });

    const adapter = new BscChainAdapter({
      chainId: 56,
      whitelist: whitelistFor(createBuiltinRegistry().list()),
      rpc: {
        endpoints: [
          { label: 'dead', url: 'mock://dead' },
          { label: 'live', url: 'mock://live' },
        ],
        crossCheckEndpoints: 2,
        retries: 0,
        transportFactory: (endpoint) =>
          endpoint.label === 'dead'
            ? handlerTransport(async () => {
                throw new TypeError('connect ECONNREFUSED');
              })
            : handlerTransport(secondary.handle),
      },
    });

    // The primary answers nothing at all, so the read must come from the secondary, flagged degraded
    // (a redundant endpoint was lost — usable, but not cross-checked).
    const result = await adapter.readContract<bigint>({
      address: USDC,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [WALLET],
    });
    expect(result.value).toBe(1_500n);
    expect(result.provenance.degraded).toBe(true);
    expect(result.provenance.observedBy).toEqual(['live']);
    expect(primary.countOf('eth_call')).toBe(0);
  });

  it('reports every endpoint failure when no endpoint can serve the read', async () => {
    const adapter = new BscChainAdapter({
      chainId: 56,
      whitelist: whitelistFor(createBuiltinRegistry().list()),
      rpc: {
        endpoints: [
          { label: 'a', url: 'mock://a' },
          { label: 'b', url: 'mock://b' },
        ],
        retries: 0,
        transportFactory: () =>
          handlerTransport(async () => {
            throw new TypeError('socket hang up');
          }),
      },
    });

    await expect(
      adapter.readContract<bigint>({
        address: USDC,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [WALLET],
      }),
    ).rejects.toMatchObject({ code: CHAIN_ERROR_CODES.RPC_UNAVAILABLE });
  });

  it('refuses to fail over on a node-level revert (the contract answered)', async () => {
    const revertNode = createMockNode({
      contracts: { [USDC.toLowerCase()]: entry({}, 'balanceOf(address)', 'revert') },
    });
    const otherNode = createMockNode({
      contracts: { [USDC.toLowerCase()]: entry({}, 'balanceOf(address)', 42n) },
    });

    const adapter = new BscChainAdapter({
      chainId: 56,
      whitelist: whitelistFor(createBuiltinRegistry().list()),
      rpc: {
        endpoints: [
          { label: 'n1', url: 'mock://n1' },
          { label: 'n2', url: 'mock://n2' },
        ],
        retries: 0,
        transportFactory: (endpoint) =>
          handlerTransport(endpoint.label === 'n1' ? revertNode.handle : otherNode.handle),
      },
    });

    const error = await adapter
      .readContract<bigint>({
        address: USDC,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [WALLET],
      })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(RpcNodeError);
    expect((error as RpcNodeError).isRevert).toBe(true);
    // n2 has a valid answer, but a revert is a property of the contract, so it must NOT be used.
    expect(otherNode.countOf('eth_call')).toBe(0);
  });

  it('rejects an endpoint that reports a different chain id', async () => {
    const node = createMockNode({ chainId: 97 });
    const adapter = new BscChainAdapter({
      chainId: 56,
      whitelist: whitelistFor(createBuiltinRegistry().list()),
      rpc: {
        endpoints: [{ label: 'wrong-chain', url: 'mock://wrong' }],
        retries: 0,
        transportFactory: () => handlerTransport(node.handle),
      },
    });

    await expect(adapter.getBlockNumber()).rejects.toMatchObject({
      code: CHAIN_ERROR_CODES.RPC_UNAVAILABLE,
    });
    // The chain-id probe must have happened before any read was attempted.
    expect(node.countOf('eth_blockNumber')).toBe(0);
  });

  it('resolves endpoints from the environment and de-duplicates repeated URLs', () => {
    const resolved = resolveEndpoints(
      {
        env: {
          BSC_RPC_URL: 'https://a.example/',
          BSC_RPC_URL_SECONDARY: 'https://a.example',
        },
      },
      56,
    );
    // A copy-pasted `.env` must not look like two independent nodes.
    expect(resolved).toHaveLength(1);

    const two = resolveEndpoints(
      { env: { BSC_RPC_URL: 'https://a.example', BSC_RPC_URL_SECONDARY: 'https://b.example' } },
      56,
    );
    expect(two.map((endpoint) => endpoint.label)).toEqual(['BSC_RPC_URL', 'BSC_RPC_URL_SECONDARY']);
  });
});

describe('§99 cross-check on critical reads', () => {
  it('accepts a value both endpoints agree on', async () => {
    const { adapter, nodes } = adapterWithEndpoints([7_000n, 7_000n]);
    const result = await adapter.readContract<bigint>({
      address: USDC,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [WALLET],
    });
    expect(result.value).toBe(7_000n);
    expect(result.provenance).toEqual({ observedBy: ['node1', 'node2'], degraded: false });
    expect(nodes[0]!.countOf('eth_call')).toBe(1);
    expect(nodes[1]!.countOf('eth_call')).toBe(1);
  });

  it('throws instead of picking a winner when the two endpoints disagree', async () => {
    const { adapter } = adapterWithEndpoints([7_000n, 6_999n]);
    const error = await adapter
      .readContract<bigint>({
        address: USDC,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [WALLET],
      })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(CrossCheckError);
    const cross = error as CrossCheckError;
    expect(cross.code).toBe(CHAIN_ERROR_CODES.CROSS_CHECK_MISMATCH);
    expect(cross.observations.map((observation) => observation.value)).toEqual(['7000', '6999']);
  });

  it('cross-checks batched balances too', async () => {
    const { adapter } = adapterWithEndpoints([7_000n, 6_999n]);
    await expect(
      adapter.getTokenBalancesWithProvenance([USDC], WALLET),
    ).rejects.toBeInstanceOf(CrossCheckError);
  });

  it('does not cross-check gas price (it legitimately differs per block)', async () => {
    const { adapter, nodes } = adapterWithEndpoints([1n, 1n]);
    await adapter.getGasPrice();
    expect(nodes.every((node) => node.countOf('eth_gasPrice') <= 1)).toBe(true);
  });

  it('pins ONE block height for every observation, so a block-mutable read cannot self-fail', async () => {
    // Measured production failure this prevents: two endpoints at slightly different heads returned
    // `sqrtPriceX96` differing in the 9th significant digit with an identical tick — one block of real
    // price movement — and the exact-equality cross-check rejected the read. Comparing different blocks
    // is not a disagreement, so every observation must be taken at the same height.
    const blockTags: unknown[] = [];
    const nodes = [0, 1].map(() =>
      createMockNode({
        contracts: { [USDC.toLowerCase()]: entry({}, 'balanceOf(address)', 7_000n) },
        chainId: 56,
      }),
    );
    const adapter = new BscChainAdapter({
      chainId: 56,
      whitelist: whitelistFor(createBuiltinRegistry().list()),
      rpc: {
        endpoints: nodes.map((_endpoint, index) => ({ label: `node${index + 1}`, url: `mock://node${index + 1}` })),
        transportFactory: (endpoint) => {
          const index = Number(endpoint.label.replace('node', '')) - 1;
          const node = nodes[index]!;
          // Wrap the node so the block tag carried by `eth_call` is observable.
          return handlerTransport((request) => {
            if (request.method === 'eth_call') {
              // eth_call params: [{to, data}, blockTag].
              const params = request.params as readonly unknown[];
              blockTags.push(params[1] ?? null);
            }
            return node.handle(request);
          });
        },
        crossCheckEndpoints: 2,
        retries: 0,
      },
    });

    const result = await adapter.readContract<bigint>({
      address: USDC,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [WALLET],
    });

    expect(result.value).toBe(7_000n);
    // The height is resolved exactly once and then reused for both observations.
    const blockRequests = nodes.reduce((total, node) => total + node.countOf('eth_blockNumber'), 0);
    expect(blockRequests).toBe(1);
    // Both calls carried the SAME explicit block tag — which is what makes the comparison valid.
    expect(blockTags).toHaveLength(2);
    expect(new Set(blockTags.map((tag) => JSON.stringify(tag))).size).toBe(1);
    expect(blockTags[0]).not.toBeNull();
  });

  it('fails closed when no endpoint can supply a height to pin', async () => {
    // Without a height there is no meaningful cross-check, and silently falling back to unpinned reads
    // would restore exactly the flakiness the pin exists to prevent.
    const nodes = [0, 1].map(() => createMockNode({ chainId: 56 }));
    const adapter = new BscChainAdapter({
      chainId: 56,
      whitelist: whitelistFor(createBuiltinRegistry().list()),
      rpc: {
        endpoints: nodes.map((_endpoint, index) => ({ label: `node${index + 1}`, url: `mock://node${index + 1}` })),
        transportFactory: (endpoint) => {
          const index = Number(endpoint.label.replace('node', '')) - 1;
          const node = nodes[index]!;
          return handlerTransport((request) => {
            if (request.method === 'eth_blockNumber') {
              return Promise.reject(new Error('this node cannot report its head'));
            }
            return node.handle(request);
          });
        },
        crossCheckEndpoints: 2,
        retries: 0,
      },
    });

    await expect(
      adapter.readContract<bigint>({
        address: USDC,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [WALLET],
      }),
    ).rejects.toMatchObject({ code: CHAIN_ERROR_CODES.RPC_UNAVAILABLE });
  });
});

describe('whitelist gate on reads', () => {
  it('refuses to read an address that is not whitelisted (§8)', async () => {
    const impostor = '0xb904108b7f6d3b27c23128ca2b62738061b8a689' as const;
    const { adapter } = adapterWithEndpoints([1n, 1n]);
    await expect(adapter.getTokenBalanceOf(impostor, WALLET)).rejects.toMatchObject({
      code: CHAIN_ERROR_CODES.ADDRESS_NOT_WHITELISTED,
    });
  });

  it('refuses to construct an adapter on a non-whitelisted chain (§11)', () => {
    const whitelist = whitelistFor(createBuiltinRegistry().list());
    expect(
      () =>
        new BscChainAdapter({
          chainId: 1,
          whitelist,
          rpc: { endpoints: [{ label: 'x', url: 'mock://x' }] },
        }),
    ).toThrowError(WhitelistError);
  });
});

describe('address normalisation', () => {
  it('returns checksummed pool addresses while registry keys stay lowercased', async () => {
    const registry = createBuiltinRegistry().getTokenByAddress(56, BSC_ADDRESSES.USDC.toUpperCase() as `0x${string}`);
    // The registry is case-insensitive on input and lowercases its key; `getAddress` re-checksums.
    expect(registry?.address).toBe(USDC);
    expect(getAddress(USDC)).toBe('0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d');
  });
});

describe('default token whitelist sanity for the chain layer', () => {
  it('knows USDC/USDT are 18 decimals and BEP-677 tokens are scaled', () => {
    const registry = createBuiltinRegistry();
    expect(registry.requireTokenByAddress(56, USDC).decimals).toBe(18);
    expect(registry.requireTokenByAddress(56, BSC_ADDRESSES.USDT).decimals).toBe(18);
    const qqqb = registry.requireTokenByAddress(56, '0x205812cdbed920aff76c6580abd681a46d11efc7');
    expect(qqqb.uiAmount.mode).toBe(UI_AMOUNT_MODES.BEP677_SCALED);
    expect(qqqb.kind).toBe(TOKEN_KINDS.BSTOCKS);
    expect(qqqb.riskTier).toBe(TOKEN_RISK_TIERS.CORE);
  });

  it('exposes the multicall3 address the adapter batches through', async () => {
    const { adapter } = adapterWithEndpoints([5n, 5n]);
    const balances = await adapter.getTokenBalancesWithProvenance([USDC], WALLET);
    expect(balances.balances[0]?.raw).toBe(5n);
    expect(balances.balances[0]?.decimals).toBe(18);
    expect(MULTICALL3_MOCK_ADDRESS).toBe('0xca11bde05977b3631167028862be2a173976ca11');
  });
});
