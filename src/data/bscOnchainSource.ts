/**
 * BSC RPC truth for the pool scanner — the concrete `PoolStateSource` (and QuoterV2 quoting) that
 * `poolDataProvider.ts` declares.
 *
 * WHY THIS FILE EXISTS AND WHAT IT REPLACES
 * ----------------------------------------
 * `src/chain/**` (T4/T5) owns chain access and is the long-term home of this logic. T6 needs
 * `fee`/`tick`/`liquidity`/`token0`/`token1` and a QuoterV2 quote — none of which any free HTTP API
 * provides (research §4.4) — so this module implements exactly those four reads against a BSC RPC,
 * behind the narrow `PoolStateSource` interface. **WIRING POINT:** when `ChainAdapter` +
 * `DexAdapter` land, replace an instance of this class with a 3-line adapter over
 * `dexAdapter.getPoolPrice()`/`getLiquidity()`/`getPool()` and delete nothing else — the provider,
 * the scanner and the filter are written against the interface, not against viem.
 *
 * Deliberately NOT a `ChainAdapter` implementation: no writes exist here at all (this slice may not
 * send a transaction), no nonce management, no keystore, no tx state machine. `sendTransaction` is
 * absent by construction.
 *
 * MULTICALL: pool state is read with `Multicall3.aggregate3` in ONE `eth_call` (per batch), which
 * matters because the BSC public dataseed endpoints throttle aggressively.
 *
 * FAIL CLOSED: every method throws on a failed read. A zeroed `sqrtPriceX96`/`liquidity` would be
 * indistinguishable from a real empty pool, so nothing is ever substituted (§96).
 */
import {
  createPublicClient,
  encodeFunctionData,
  decodeAbiParameters,
  http,
  type PublicClient,
} from 'viem';
import { CHAIN_ERROR_CODES, ChainError, RpcUnavailableError } from '../chain/errors.ts';
import { CLMM_FACTORY_ABI, CLMM_POOL_ABI, MULTICALL3_AGGREGATE3_ABI } from '../chain/abis.ts';
import { BSC_DEX_CONTRACTS, BSC_ADDRESSES } from '../config/builtins.ts';
import {
  DEX_IDS,
  type Address,
  type ChainId,
  type DexId,
  type FeeTier,
  type IsoTimestamp,
} from '../types/primitives.ts';
import type {
  OnchainPoolReserves,
  OnchainPoolState,
  PoolStateSource,
} from './poolDataProvider.ts';

/** QuoterV2 `quoteExactInputSingle`. Selector and ABI shape are identical on both DEXes. */
export const QUOTER_V2_ABI = [
  {
    type: 'function',
    name: 'quoteExactInputSingle',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'fee', type: 'uint24' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'sqrtPriceX96After', type: 'uint160' },
      { name: 'initializedTicksCrossed', type: 'uint32' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
  },
] as const;

/** Raw `balanceOf(address)` selector; the pool holds its own reserves. */
const ERC20_BALANCE_OF_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface BscOnchainSourceOptions {
  readonly chainId?: ChainId;
  /** Primary RPC. Defaults to `BSC_RPC_URL` from the environment, then the public dataseed. */
  readonly rpcUrl?: string;
  /** Optional failover, used when the primary throws. Defaults to `BSC_RPC_URL_SECONDARY`. */
  readonly secondaryRpcUrl?: string;
  readonly timeoutMs?: number;
  /** Pools per `aggregate3` call (6 reads each; kept well under any node's gas cap). */
  readonly batchSize?: number;
  /** Injected for tests; when omitted a viem public client is built from the URLs. */
  readonly client?: PublicClient;
  readonly secondaryClient?: PublicClient;
}

/** Public BSC dataseed; used only when no `BSC_RPC_URL` is configured. */
export const DEFAULT_BSC_RPC_URL = 'https://bsc-dataseed.bnbchain.org';

/** `fee()` selector values a CLMM factory can return; anything else is a decode problem, not a pool. */
const KNOWN_FEE_TIERS = new Set([100, 500, 2500, 3000, 10_000]);

export class BscOnchainPoolStateSource implements PoolStateSource {
  readonly chainId: ChainId;
  readonly #primary: PublicClient;
  readonly #secondary: PublicClient | undefined;
  readonly #batchSize: number;

  constructor(options: BscOnchainSourceOptions = {}) {
    this.chainId = options.chainId ?? 56;
    if (this.chainId !== 56) {
      throw new ChainError(
        CHAIN_ERROR_CODES.CHAIN_NOT_WHITELISTED,
        `only BNB Chain (56) is wired for pool reads, got ${this.chainId}`,
      );
    }
    const primaryUrl = options.rpcUrl ?? process.env['BSC_RPC_URL'] ?? DEFAULT_BSC_RPC_URL;
    const secondaryUrl = options.secondaryRpcUrl ?? process.env['BSC_RPC_URL_SECONDARY'];
    const timeout = options.timeoutMs ?? 15_000;
    this.#primary =
      options.client ?? (createPublicClient({ transport: http(primaryUrl, { timeout }) }) as PublicClient);
    this.#secondary =
      options.secondaryClient ??
      (secondaryUrl === undefined || secondaryUrl.length === 0
        ? undefined
        : (createPublicClient({ transport: http(secondaryUrl, { timeout }) }) as PublicClient));
    this.#batchSize = options.batchSize ?? 20;
  }

  /** `slot0()`, `liquidity()`, `fee()`, `tickSpacing()`, `token0()`, `token1()` in one batch. */
  async readPoolStates(poolAddresses: readonly Address[]): Promise<readonly OnchainPoolState[]> {
    const states: OnchainPoolState[] = [];
    for (let offset = 0; offset < poolAddresses.length; offset += this.#batchSize) {
      const batch = poolAddresses.slice(offset, offset + this.#batchSize);
      const calls = batch.flatMap((pool) => [
        { target: pool, allowFailure: false, callData: '0x3850c7bd' as const }, // slot0()
        { target: pool, allowFailure: false, callData: '0x1a686502' as const }, // liquidity()
        { target: pool, allowFailure: false, callData: '0xddca3f43' as const }, // fee()
        { target: pool, allowFailure: false, callData: '0xd0c93a7c' as const }, // tickSpacing()
        { target: pool, allowFailure: false, callData: '0x0dfe1681' as const }, // token0()
        { target: pool, allowFailure: false, callData: '0xd21220a7' as const }, // token1()
      ]);
      const results = await this.#aggregate(calls);
      const asOf = new Date().toISOString();
      for (let index = 0; index < batch.length; index += 1) {
        const pool = batch[index];
        if (pool === undefined) continue;
        const slot0 = results[index * 6];
        const liquidity = results[index * 6 + 1];
        const fee = results[index * 6 + 2];
        const tickSpacing = results[index * 6 + 3];
        const token0 = results[index * 6 + 4];
        const token1 = results[index * 6 + 5];
        if (
          slot0 === undefined ||
          liquidity === undefined ||
          fee === undefined ||
          tickSpacing === undefined ||
          token0 === undefined ||
          token1 === undefined
        ) {
          throw new RpcUnavailableError(
            
            `multicall returned ${results.length} results for ${batch.length} pools (expected ${String(batch.length * 6)})`,
          );
        }
        states.push({
          poolAddress: pool.toLowerCase() as Address,
          ...decodePoolState({ slot0, liquidity, fee, tickSpacing, token0, token1, asOf }),
        });
      }
    }
    return states;
  }

  /** Raw `balanceOf(pool)` for both legs — the TVL reserve cross-check. */
  async readPoolReserves(
    poolAddresses: readonly Address[],
  ): Promise<readonly OnchainPoolReserves[]> {
    const states = await this.readPoolStates(poolAddresses);
    const reserves: OnchainPoolReserves[] = [];
    const calls = states.flatMap((state) => [
      {
        target: state.token0,
        allowFailure: false,
        callData: encodeFunctionData({
          abi: ERC20_BALANCE_OF_ABI,
          functionName: 'balanceOf',
          args: [state.poolAddress],
        }),
      },
      {
        target: state.token1,
        allowFailure: false,
        callData: encodeFunctionData({
          abi: ERC20_BALANCE_OF_ABI,
          functionName: 'balanceOf',
          args: [state.poolAddress],
        }),
      },
    ]);
    const results = calls.length === 0 ? [] : await this.#aggregate(calls);
    const asOf = new Date().toISOString();
    for (let index = 0; index < states.length; index += 1) {
      const state = states[index];
      const token0Raw = results[index * 2];
      const token1Raw = results[index * 2 + 1];
      if (state === undefined) continue;
      if (token0Raw === undefined || token1Raw === undefined) {
        throw new RpcUnavailableError(
          
          `multicall returned ${results.length} results for ${states.length} reserve pairs`,
        );
      }
      reserves.push({
        poolAddress: state.poolAddress,
        token0Raw: decodeUint256(token0Raw),
        token1Raw: decodeUint256(token1Raw),
        asOf,
      });
    }
    return reserves;
  }

  /** `factory.getPool(tokenA, tokenB, fee)`; the zero address means "this pool does not exist". */
  async findPool(params: {
    readonly dex: DexId;
    readonly tokenA: Address;
    readonly tokenB: Address;
    readonly feeTier: FeeTier;
  }): Promise<Address | null> {
    const factory = this.#factoryOf(params.dex);
    const data = encodeFunctionData({
      abi: CLMM_FACTORY_ABI,
      functionName: 'getPool',
      args: [params.tokenA, params.tokenB, params.feeTier],
    });
    const result = await this.#call(factory, data);
    const decoded = decodeAbiParameters([{ type: 'address' }], result);
    const address = String(decoded[0]).toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address) || address === ZERO_ADDRESS) return null;
    return address as Address;
  }

  /** QuoterV2 `quoteExactInputSingle`. Read-only (`eth_call`), RAW amount in, RAW amount out. */
  async quoteExactInputSingle(params: {
    readonly dex: DexId;
    readonly poolAddress: Address;
    readonly tokenIn: Address;
    readonly tokenOut: Address;
    readonly amountInRaw: bigint;
    readonly feeTier: FeeTier;
  }): Promise<bigint> {
    const quoter = BSC_DEX_CONTRACTS[params.dex]?.quoterV2;
    if (quoter === undefined) {
      throw new ChainError(
        CHAIN_ERROR_CODES.DEX_NOT_WHITELISTED,
        `no QuoterV2 address is known for dex ${params.dex}`,
      );
    }
    const data = encodeFunctionData({
      abi: QUOTER_V2_ABI,
      functionName: 'quoteExactInputSingle',
      args: [
        {
          tokenIn: params.tokenIn,
          tokenOut: params.tokenOut,
          amountIn: params.amountInRaw,
          fee: params.feeTier,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    const result = await this.#call(quoter, data);
    const decoded = decodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint160' }, { type: 'uint32' }, { type: 'uint256' }],
      result,
    );
    const amountOut = decoded[0];
    if (typeof amountOut !== 'bigint') {
      throw new ChainError(
        CHAIN_ERROR_CODES.DECODE_FAILED,
        `quoter returned a non-integer amountOut: ${String(amountOut)}`,
      );
    }
    return amountOut;
  }

  #factoryOf(dex: DexId): Address {
    const factory = BSC_DEX_CONTRACTS[dex]?.factory;
    if (factory === undefined) {
      throw new ChainError(
        CHAIN_ERROR_CODES.DEX_NOT_WHITELISTED,
        `no factory address is known for dex ${dex}`,
      );
    }
    return factory;
  }

  /** `eth_call`, primary then secondary. Both failing is a hard `RpcUnavailableError`. */
  async #call(to: Address, data: `0x${string}`): Promise<`0x${string}`> {
    try {
      const { data: result } = await this.#primary.call({ to, data });
      if (result === undefined) {
        throw new ChainError(CHAIN_ERROR_CODES.DECODE_FAILED, `eth_call to ${to} returned no data`);
      }
      return result;
    } catch (primaryError) {
      if (this.#secondary === undefined) {
        throw new RpcUnavailableError(
          
          `eth_call to ${to} failed on the primary RPC: ${describe(primaryError)}`,
        );
      }
      try {
        const { data: result } = await this.#secondary.call({ to, data });
        if (result === undefined) {
          throw new ChainError(CHAIN_ERROR_CODES.DECODE_FAILED, `eth_call to ${to} returned no data`);
        }
        return result;
      } catch (secondaryError) {
        throw new RpcUnavailableError(
          
          `eth_call to ${to} failed on both RPCs (primary: ${describe(primaryError)}; secondary: ${describe(secondaryError)})`,
        );
      }
    }
  }

  /** `Multicall3.aggregate3`, primary then secondary, decoding each sub-result. */
  async #aggregate(
    calls: readonly { readonly target: Address; readonly callData: `0x${string}` }[],
  ): Promise<readonly `0x${string}`[]> {
    const data = encodeFunctionData({
      abi: MULTICALL3_AGGREGATE3_ABI,
      functionName: 'aggregate3',
      args: [
        calls.map((call) => ({
          target: call.target,
          allowFailure: false as const,
          callData: call.callData,
        })),
      ],
    });
    const multicall = BSC_ADDRESSES.MULTICALL3;
    const raw = await this.#call(multicall, data);
    const decoded = decodeAbiParameters(
      [
        {
          type: 'tuple[]',
          components: [{ name: 'success', type: 'bool' }, { name: 'returnData', type: 'bytes' }],
        },
      ],
      raw,
    );
    const results = decoded[0];
    if (!Array.isArray(results)) {
      throw new ChainError(
        CHAIN_ERROR_CODES.DECODE_FAILED,
        'aggregate3 did not return an array of results',
      );
    }
    return results.map((entry: { readonly success: boolean; readonly returnData: string }) => {
      if (!entry.success) {
        throw new ChainError(
          CHAIN_ERROR_CODES.RPC_NODE_ERROR,
          'aggregate3 reported a failed sub-call (allowFailure was false, so this is a node invariant break)',
        );
      }
      return entry.returnData as `0x${string}`;
    });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function decodeUint256(data: `0x${string}`): bigint {
  const [value] = decodeAbiParameters([{ type: 'uint256' }], data);
  if (typeof value !== 'bigint') {
    throw new ChainError(CHAIN_ERROR_CODES.DECODE_FAILED, `expected uint256, got ${typeof value}`);
  }
  return value;
}

/**
 * Decode the six multicall results for one pool. `fee()` is validated against the known CLMM fee
 * tiers: an unexpected value means the address is not a CLMM pool (or the ABI is wrong), which must
 * abort rather than produce a snapshot with a nonsense fee tier.
 */
function decodePoolState(params: {
  readonly slot0: `0x${string}`;
  readonly liquidity: `0x${string}`;
  readonly fee: `0x${string}`;
  readonly tickSpacing: `0x${string}`;
  readonly token0: `0x${string}`;
  readonly token1: `0x${string}`;
  readonly asOf: IsoTimestamp;
}): Omit<OnchainPoolState, 'poolAddress'> {
  const slot0 = decodeAbiParameters(
    [
      { type: 'uint160' },
      { type: 'int24' },
      { type: 'uint16' },
      { type: 'uint16' },
      { type: 'uint16' },
      { type: 'uint8' },
      { type: 'bool' },
    ],
    params.slot0,
  );
  const sqrtPriceX96 = slot0[0];
  const tick = slot0[1];
  if (typeof sqrtPriceX96 !== 'bigint' || typeof tick !== 'number') {
    throw new ChainError(CHAIN_ERROR_CODES.DECODE_FAILED, 'slot0() decoded to unexpected types');
  }
  if (sqrtPriceX96 <= 0n) {
    throw new ChainError(
      CHAIN_ERROR_CODES.DECODE_FAILED,
      'slot0() returned sqrtPriceX96 = 0, which cannot be a live pool',
    );
  }
  const liquidity = decodeUint256(params.liquidity);
  const feeRaw = decodeUint256(params.fee);
  const feeTier = Number(feeRaw);
  if (!KNOWN_FEE_TIERS.has(feeTier)) {
    throw new ChainError(
      CHAIN_ERROR_CODES.DECODE_FAILED,
      `fee() returned ${String(feeTier)}, which is not a known CLMM fee tier — the address is probably not a pool`,
    );
  }
  const tickSpacingRaw = decodeAbiParameters([{ type: 'int24' }], params.tickSpacing);
  const tickSpacing = tickSpacingRaw[0];
  if (typeof tickSpacing !== 'number' || tickSpacing <= 0) {
    throw new ChainError(
      CHAIN_ERROR_CODES.DECODE_FAILED,
      `tickSpacing() decoded to ${String(tickSpacing)}, which is not a positive integer`,
    );
  }
  const [token0] = decodeAbiParameters([{ type: 'address' }], params.token0);
  const [token1] = decodeAbiParameters([{ type: 'address' }], params.token1);
  const token0String = String(token0).toLowerCase();
  const token1String = String(token1).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(token0String) || !/^0x[0-9a-f]{40}$/.test(token1String)) {
    throw new ChainError(CHAIN_ERROR_CODES.DECODE_FAILED, 'token0()/token1() did not decode to addresses');
  }
  if (token0String === token1String) {
    throw new ChainError(
      CHAIN_ERROR_CODES.DECODE_FAILED,
      'token0() and token1() returned the same address, which cannot be a pool',
    );
  }
  return {
    token0: token0String as Address,
    token1: token1String as Address,
    feeTier,
    tickSpacing,
    sqrtPriceX96,
    tick,
    liquidity,
    asOf: params.asOf,
  };
}

/** Selector-documented read surface, kept next to the decoder so the two cannot drift. */
export const CLMM_POOL_SELECTORS = {
  slot0: '0x3850c7bd',
  liquidity: '0x1a686502',
  fee: '0xddca3f43',
  tickSpacing: '0xd0c93a7c',
  token0: '0x0dfe1681',
  token1: '0xd21220a7',
} as const satisfies Record<string, `0x${string}`>;

void CLMM_POOL_ABI;
void DEX_IDS.UNISWAP_V3;
