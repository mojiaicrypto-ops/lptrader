/**
 * In-memory JSON-RPC node used by the chain tests.
 *
 * The point of a mock node (rather than stubbing the adapter) is that the multi-RPC behaviour under
 * test lives in the *transport* layer: failover, the chain-id guard and the §99 cross-check all
 * depend on how viem surfaces endpoint failures. Only a real JSON-RPC round trip exercises that.
 *
 * Every handler is address- and selector-keyed, so a test cannot accidentally pass because the mock
 * answered a call it was not asked about.
 */
import {
  decodeFunctionData,
  encodeFunctionData,
  encodeFunctionResult,
  toFunctionSelector,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { BEP677_ABI, ERC165_ABI, ERC20_ABI, MULTICALL3_AGGREGATE3_ABI, CLMM_POOL_ABI, POSITION_MANAGER_ABI } from '../../src/chain/abis.ts';

/** Marker returned by a handler to make `eth_call` revert (as BSC nodes do: `code 3`, data `0x`). */
export const REVERT = 'revert' as const;

export interface MockNodeOptions {
  readonly chainId?: number;
  readonly blockNumber?: bigint;
  readonly gasPrice?: bigint;
  /** `contracts[address][selector]` → encoded return data, or `REVERT`. */
  readonly contracts?: Record<string, Record<string, Hex | typeof REVERT>>;
  readonly nativeBalances?: Record<string, bigint>;
  readonly receipts?: Record<string, MockReceipt | null>;
  readonly transactions?: Record<string, MockTransaction | null>;
  /** Responses for methods the mock does not model; `undefined` → raise "unsupported". */
  readonly extra?: Record<string, (params: readonly unknown[]) => unknown>;
}

export interface MockReceipt {
  readonly blockNumber: bigint;
  readonly from: Address;
  readonly to: Address;
  readonly status: 'success' | 'reverted';
  readonly gasUsed: bigint;
  readonly effectiveGasPrice: bigint;
}

export interface MockTransaction {
  readonly blockNumber: bigint | null;
  readonly from: Address;
  readonly to: Address;
  readonly value: bigint;
  readonly gasPrice?: bigint;
}

/** A recorded RPC method invocation. */
export interface MockCallLog {
  readonly method: string;
  readonly to?: string;
  readonly selector?: string;
}

export interface MockNode {
  readonly handle: (request: { method: string; params?: unknown }) => Promise<unknown>;
  readonly calls: MockCallLog[];
  readonly label: string;
  /** Number of times a given method was invoked (asserted by failover tests). */
  countOf(method: string): number;
}

/**
 * Encode a single-output view function's return data.
 *
 * When the ABI declares `uint8`/`uint16`/`uint24`/`uint32` but the real deployment returns a wider
 * value in that slot (PancakeSwap V3's `slot0` packs `feeProtocol` as `uint32` while Uniswap V3
 * declares `uint8`), `viem`'s encoder rejects the fixture. The value is masked to the declared width
 * so one fixture serves both DEX ABIs — the byte layout on the wire is identical either way.
 */
export function encodeResult(abi: Abi, functionName: string, value: unknown): Hex {
  try {
    return encodeFunctionResult({ abi, functionName, result: value } as never) as Hex;
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('IntegerOutOfRangeError')) throw error;
    const item = abi.find(
      (candidate) => (candidate as { name?: string }).name === functionName,
    ) as { outputs?: readonly { type?: string }[] } | undefined;
    const narrow = (item?.outputs ?? []).map((output) => {
      const width = /^uint(\d+)$/u.exec(output.type ?? '');
      return width === null ? null : Number(width[1]);
    });
    if (narrow.length === 0) throw error;
    const masked = narrow.map((bits, index) =>
      bits === null
        ? (value as readonly unknown[])[index]
        : (value as readonly bigint[])[index]! & ((1n << BigInt(bits)) - 1n),
    );
    return encodeFunctionResult({ abi, functionName, result: masked } as never) as Hex;
  }
}

/** Convenience: a `contracts` entry keyed by **selector** (answers every argument list). */
export function entry(
  card: Record<string, Hex | typeof REVERT>,
  signature: string,
  value: unknown,
  abi?: Abi,
): Record<string, Hex | typeof REVERT> {
  const selector = toFunctionSelector(signature);
  const resolvedAbi = abi ?? ABI_FOR_SIGNATURE[signature.split('(')[0] as string];
  if (resolvedAbi === undefined) {
    throw new Error(`no ABI registered for ${signature}; pass one explicitly`);
  }
  card[selector] = value === REVERT ? REVERT : encodeResult(resolvedAbi, signature.split('(')[0] as string, value);
  return card;
}

/**
 * A `contracts` entry keyed by the **full calldata** (selector + encoded args).
 *
 * Needed whenever one selector must answer differently per argument — e.g. `supportsInterface` for
 * the BEP-677 core id must return `true` while the invalid id returns `false`.
 */
export function callEntry(
  card: Record<string, Hex | typeof REVERT>,
  signature: string,
  args: readonly unknown[],
  value: unknown,
  abi?: Abi,
): Record<string, Hex | typeof REVERT> {
  const functionName = signature.split('(')[0] as string;
  const resolvedAbi = abi ?? ABI_FOR_SIGNATURE[functionName];
  if (resolvedAbi === undefined) {
    throw new Error(`no ABI registered for ${signature}; pass one explicitly`);
  }
  const data = encodeFunctionData({ abi: resolvedAbi, functionName, args } as never) as Hex;
  card[data.toLowerCase()] =
    value === REVERT
      ? REVERT
      : encodeFunctionResult({ abi: resolvedAbi, functionName, result: value } as never);
  return card;
}

/** Which ABI a bare function name belongs to, for `entry()`. */
export const ABI_FOR_SIGNATURE: Readonly<Record<string, Abi>> = {
  uiMultiplier: BEP677_ABI,
  balanceOfUI: BEP677_ABI,
  totalSupplyUI: BEP677_ABI,
  toUIAmount: BEP677_ABI,
  fromUIAmount: BEP677_ABI,
  supportsInterface: ERC165_ABI,
  balanceOf: ERC20_ABI,
  allowance: ERC20_ABI,
  decimals: ERC20_ABI,
  totalSupply: ERC20_ABI,
  slot0: CLMM_POOL_ABI,
  liquidity: CLMM_POOL_ABI,
  fee: CLMM_POOL_ABI,
  tickSpacing: CLMM_POOL_ABI,
  token0: CLMM_POOL_ABI,
  token1: CLMM_POOL_ABI,
  positions: POSITION_MANAGER_ABI,
  ownerOf: POSITION_MANAGER_ABI,
  tokenOfOwnerByIndex: POSITION_MANAGER_ABI,
};

/**
 * Build one mock endpoint. `label` is used for assertions about *which* endpoint answered.
 *
 * `aggregate3` is implemented (not stubbed): it decodes the batched calldata, dispatches each
 * sub-call through the same contract table and re-encodes the results, so a batched read test sees
 * exactly the per-call answers it configured.
 */
export function createMockNode(options: MockNodeOptions = {}): MockNode {
  const chainId = options.chainId ?? 56;
  const calls: MockCallLog[] = [];
  const aggregate3Selector = toFunctionSelector('aggregate3((address,bool,bytes)[])');

  const dispatchCall = (to: string, data: Hex): Hex => {
    const selector = data.slice(0, 10).toLowerCase();
    const contract = options.contracts?.[to.toLowerCase()];
    // Exact-calldata keys take precedence so one selector can answer differently per argument
    // (`balanceOf(address)` per holder, `supportsInterface(bytes4)` per interface id).
    const answer = contract?.[data.toLowerCase()] ?? contract?.[selector];
    if (answer === undefined) {
      throw jsonRpcError(`no mock answer for ${to} ${data.slice(0, 10)}`, -32000, '0x');
    }
    if (answer === REVERT) {
      // BSC returns `code 3` with empty data for a plain revert.
      throw jsonRpcError('execution reverted', 3, '0x');
    }
    return answer;
  };

  const handle = async (request: { method: string; params?: unknown }): Promise<unknown> => {
    const params = (request.params ?? []) as readonly unknown[];
    switch (request.method) {
      case 'eth_chainId':
        calls.push({ method: request.method });
        return `0x${chainId.toString(16)}`;
      case 'eth_blockNumber':
        calls.push({ method: request.method });
        return toQuantity(options.blockNumber ?? 1_000n);
      case 'eth_gasPrice':
        calls.push({ method: request.method });
        return toQuantity(options.gasPrice ?? 3_000_000_000n);
      case 'eth_estimateGas':
        calls.push({ method: request.method });
        return toQuantity(200_000n);
      case 'eth_getBalance': {
        const address = String(params[0]).toLowerCase();
        calls.push({ method: request.method, to: address });
        return toQuantity(options.nativeBalances?.[address] ?? 0n);
      }
      case 'eth_call': {
        const call = params[0] as { to: string; data: Hex };
        const to = call.to.toLowerCase();
        const selector = call.data.slice(0, 10).toLowerCase();
        calls.push({ method: request.method, to, selector });

        if (to === MULTICALL3_MOCK_ADDRESS && selector === aggregate3Selector) {
          const decoded = decodeFunctionData({
            abi: MULTICALL3_AGGREGATE3_ABI,
            data: call.data,
          }) as { args: readonly (readonly { target: string; allowFailure: boolean; callData: Hex }[])[] };
          const subCalls = decoded.args[0] ?? [];
          const results = subCalls.map((subCall) => {
            try {
              return { success: true, returnData: dispatchCall(subCall.target, subCall.callData) };
            } catch {
              if (!subCall.allowFailure) throw jsonRpcError('execution reverted', 3, '0x');
              return { success: false, returnData: '0x' as Hex };
            }
          });
          return encodeResult(MULTICALL3_AGGREGATE3_ABI, 'aggregate3', results);
        }
        return dispatchCall(to, call.data);
      }
      case 'eth_getTransactionReceipt': {
        const hash = String(params[0]).toLowerCase();
        calls.push({ method: request.method });
        const receipt = options.receipts?.[hash];
        if (receipt === undefined || receipt === null) return null;
        return {
          blockNumber: toQuantity(receipt.blockNumber),
          from: receipt.from,
          to: receipt.to,
          status: receipt.status === 'success' ? '0x1' : '0x0',
          gasUsed: toQuantity(receipt.gasUsed),
          effectiveGasPrice: toQuantity(receipt.effectiveGasPrice),
          transactionHash: hash,
          logs: [],
        };
      }
      case 'eth_getTransactionByHash': {
        const hash = String(params[0]).toLowerCase();
        calls.push({ method: request.method });
        const tx = options.transactions?.[hash];
        if (tx === undefined || tx === null) return null;
        return {
          blockNumber: tx.blockNumber === null ? null : toQuantity(tx.blockNumber),
          from: tx.from,
          to: tx.to,
          value: toQuantity(tx.value),
          gasPrice: toQuantity(tx.gasPrice ?? 3_000_000_000n),
          hash,
        };
      }
      default: {
        const handler = options.extra?.[request.method];
        if (handler === undefined) {
          throw jsonRpcError(`mock node does not implement ${request.method}`, -32601, undefined);
        }
        calls.push({ method: request.method });
        return handler(params);
      }
    }
  };

  return {
    handle,
    calls,
    label: 'mock',
    countOf: (method: string) => calls.filter((entry) => entry.method === method).length,
  };
}

/** Multicall3's real address; the mock answers it in-process. */
export const MULTICALL3_MOCK_ADDRESS = '0xca11bde05977b3631167028862be2a173976ca11';

function toQuantity(value: bigint): Hex {
  return `0x${value.toString(16)}` as Hex;
}

/** A JSON-RPC error shaped the way a BSC node reports a revert. */
function jsonRpcError(message: string, code: number, data: string | undefined): Error {
  const error = new Error(message) as Error & { code?: number; data?: unknown };
  error.code = code;
  error.data = data;
  return error;
}
