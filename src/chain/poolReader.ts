/**
 * CLMM pool reads (T5) — `slot0` / `liquidity` / `fee` / `token0` / `token1` / reserves.
 *
 * These five fields are precisely the ones **no free HTTP data source provides** (research §4.4), yet
 * `tick` and `liquidity` are the inputs a concentrated-liquidity strategy cannot fake. So they are
 * read straight from the pool contract through the cross-checked RPC pool.
 *
 * Two rules the code enforces:
 * - **`tickSpacing` comes from the pool, not from the fee tier.** `fee → tickSpacing` happens to be
 *   injective across the Pancake/Uniswap tiers in play, but that is a coincidence of the current
 *   whitelist; reading it makes an unaligned range impossible even if a DEX changes its spacing.
 * - **Token order is the pool's, not ours.** `token0()`/`token1()` decide which address is leg 0, so
 *   price derivation (`token1` per `token0`) cannot be silently inverted.
 */
import { getAddress } from 'viem';
import { CLMM_POOL_ABI, ERC20_ABI } from './abis.ts';
import { ChainError, CHAIN_ERROR_CODES } from './errors.ts';
import type { RpcProvenance, RpcReadResult } from './rpc.ts';
import type { BscChainAdapter } from './adapter.ts';
import type { PoolPriceView } from '../types/adapters.ts';
import type { Address, ChainId, DexId, PoolId, Tick } from '../types/primitives.ts';
import type { TokenMeta } from '../types/token.ts';
import type { TokenRegistry } from '../types/registry.ts';

/** Q96 fixed-point denominator used by the CLMM `sqrtPriceX96` encoding. */
export const Q96 = 2n ** 96n;

/** Uniswap/Pancake V3 bound on a usable tick; outside this the position is unrepresentable. */
export const MIN_TICK = -887_272;
export const MAX_TICK = 887_272;

/**
 * Raw (undecimalled) `token1 per token0` price from `sqrtPriceX96`:
 * `price = (sqrtPriceX96 / 2^96)^2`, computed in floating point because it is a display/threshold
 * quantity — the exact values (`sqrtPriceX96`, `tick`) are returned alongside it untouched.
 */
export function sqrtPriceX96ToRawPrice(sqrtPriceX96: bigint): number {
  const sqrtPrice = Number(sqrtPriceX96) / Number(Q96);
  return sqrtPrice * sqrtPrice;
}

/**
 * Decimal-adjusted `token1 per token0` price. `rawPrice` is expressed in raw base units, so the
 * adjustment is `10^(decimals0 - decimals1)`.
 */
export function sqrtPriceX96ToPrice(
  sqrtPriceX96: bigint,
  decimals0: number,
  decimals1: number,
): number {
  return sqrtPriceX96ToRawPrice(sqrtPriceX96) * 10 ** (decimals0 - decimals1);
}

/**
 * `token0 per token1`, the reciprocal. Guarded because a zero sqrt price (uninitialised pool) makes
 * the raw price zero and the reciprocal infinite.
 */
export function invertPrice(price: number): number {
  if (!Number.isFinite(price) || price === 0) return Number.NaN;
  return 1 / price;
}

/** Full on-chain state of one pool, as returned by `readPool`. */
export interface PoolState extends PoolPriceView {
  readonly chainId: ChainId;
  readonly dex: DexId;
  readonly poolAddress: Address;
  readonly token0: Address;
  readonly token1: Address;
  readonly tickSpacing: number;
  /** RAW reserves held by the pool contract for each leg (not the in-range liquidity). */
  readonly reserve0Raw: bigint;
  readonly reserve1Raw: bigint;
  /** The blocks the values were read at, per leg of the batch. */
  readonly blockNumber: bigint;
  readonly provenance: RpcProvenance;
}

/** A resolved pool identity plus its registry metadata, the input to every downstream read. */
export interface PoolTarget {
  readonly poolId: PoolId;
  readonly poolAddress: Address;
  readonly dex: DexId;
  readonly chainId: ChainId;
  readonly token0: TokenMeta;
  readonly token1: TokenMeta;
  /** `fee()` as reported by the pool contract (the §108 fee-tier truth). */
  readonly feeTier: number;
  /** `tickSpacing()` as reported by the pool contract; ranges must align to it. */
  readonly tickSpacing: number;
}

/**
 * Reads pool state for a whitelisted pool.
 *
 * The pool *addresses* are supplied by the caller (the scanner discovers them; `getPoolAddress` on
 * the adapter derives them from the factory). Everything read afterwards is contract truth.
 */
export class PoolReader {
  private readonly adapter: BscChainAdapter;
  private readonly registry: TokenRegistry;
  private readonly chainId: ChainId;
  private readonly knownDecimals: Record<string, number> = {};

  constructor(adapter: BscChainAdapter, registry: TokenRegistry, chainId: ChainId) {
    this.adapter = adapter;
    this.registry = registry;
    this.chainId = chainId;
  }

  /**
   * Read `token0`/`token1`/`fee`/`tickSpacing` for a pool address and pair them with registry
   * metadata.
   *
   * Both legs must be whitelisted: an unwhitelisted leg means the pool cannot be valued, filtered or
   * traded, so it is refused here rather than surfacing as a `null` deep inside the scanner.
   */
  async resolvePool(poolAddress: Address, dex: DexId): Promise<PoolTarget> {
    const [token0Result, token1Result, feeResult, tickSpacingResult] = await Promise.all([
      this.readAddress(poolAddress, 'token0'),
      this.readAddress(poolAddress, 'token1'),
      this.readNumber(poolAddress, 'fee'),
      this.readNumber(poolAddress, 'tickSpacing'),
    ]);

    const token0 = this.registry.requireTokenByAddress(this.chainId, token0Result);
    const token1 = this.registry.requireTokenByAddress(this.chainId, token1Result);
    return {
      poolId: `${this.chainId}:${dex}:${poolAddress.toLowerCase()}`,
      poolAddress,
      dex,
      chainId: this.chainId,
      token0,
      token1,
      feeTier: feeResult,
      tickSpacing: tickSpacingResult,
    };
  }

  /**
   * The complete on-chain view of a pool: `slot0`, `liquidity`, `fee` and both reserves, batched.
   *
   * `liquidity()` is the **in-range active liquidity** — the number that determines how far a swap of
   * a given size moves the price. It is deliberately not "TVL", which is a USD figure requiring
   * prices; the scanner keeps the two apart.
   */
  async readPool(target: PoolTarget): Promise<PoolState> {
    const [slot0, liquidity, fee, token0, token1, tickSpacing, reserve0, reserve1, blockNumber] =
      await Promise.all([
        this.adapter.readContract<readonly [bigint, number, number, number, number, number, boolean]>({
          address: target.poolAddress,
          abi: CLMM_POOL_ABI,
          functionName: 'slot0',
        }),
        this.adapter.readContract<bigint>({
          address: target.poolAddress,
          abi: CLMM_POOL_ABI,
          functionName: 'liquidity',
        }),
        this.adapter.readContract<number>({
          address: target.poolAddress,
          abi: CLMM_POOL_ABI,
          functionName: 'fee',
        }),
        this.adapter.readContract<Address>({
          address: target.poolAddress,
          abi: CLMM_POOL_ABI,
          functionName: 'token0',
        }),
        this.adapter.readContract<Address>({
          address: target.poolAddress,
          abi: CLMM_POOL_ABI,
          functionName: 'token1',
        }),
        this.adapter.readContract<number>({
          address: target.poolAddress,
          abi: CLMM_POOL_ABI,
          functionName: 'tickSpacing',
        }),
        this.adapter.readContract<bigint>({
          address: target.token0.address,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [target.poolAddress],
        }),
        this.adapter.readContract<bigint>({
          address: target.token1.address,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [target.poolAddress],
        }),
        this.adapter.getBlockNumber(),
      ]);

    // The pool's own token order is authoritative; a factory/registry disagreement is a defect, not
    // something to reconcile silently.
    if (getAddress(token0.value) !== getAddress(target.token0.address)) {
      throw new ChainError(
        CHAIN_ERROR_CODES.DECODE_FAILED,
        `pool ${target.poolAddress} token0() is ${token0.value} but the caller expected ` +
          `${target.token0.address} (${target.token0.symbol})`,
        { poolAddress: target.poolAddress, onChain: token0.value, expected: target.token0.address },
      );
    }
    if (getAddress(token1.value) !== getAddress(target.token1.address)) {
      throw new ChainError(
        CHAIN_ERROR_CODES.DECODE_FAILED,
        `pool ${target.poolAddress} token1() is ${token1.value} but the caller expected ` +
          `${target.token1.address} (${target.token1.symbol})`,
        { poolAddress: target.poolAddress, onChain: token1.value, expected: target.token1.address },
      );
    }

    const sqrtPriceX96 = slot0.value[0];
    const tick = slot0.value[1];
    if (tick < MIN_TICK || tick > MAX_TICK) {
      throw new ChainError(
        CHAIN_ERROR_CODES.DECODE_FAILED,
        `pool ${target.poolAddress} reports tick ${tick}, outside the representable range ` +
          `[${MIN_TICK}, ${MAX_TICK}]`,
        { poolAddress: target.poolAddress, tick },
      );
    }
    if (sqrtPriceX96 <= 0n) {
      throw new ChainError(
        CHAIN_ERROR_CODES.DECODE_FAILED,
        `pool ${target.poolAddress} is not initialised (sqrtPriceX96 = 0)`,
        { poolAddress: target.poolAddress },
      );
    }

    return {
      poolId: target.poolId,
      chainId: target.chainId,
      dex: target.dex,
      poolAddress: target.poolAddress,
      sqrtPriceX96,
      tick,
      liquidity: liquidity.value,
      feeTier: fee.value,
      tickSpacing: tickSpacing.value,
      priceToken1PerToken0: sqrtPriceX96ToPrice(
        sqrtPriceX96,
        target.token0.decimals,
        target.token1.decimals,
      ),
      asOf: new Date().toISOString(),
      token0: getAddress(token0.value),
      token1: getAddress(token1.value),
      reserve0Raw: reserve0.value,
      reserve1Raw: reserve1.value,
      blockNumber: blockNumber,
      provenance: liquidity.provenance,
    };
  }

  /** `slot0()` only — the cheapest way to answer "is the current tick inside the range?". */
  async readSlot0(poolAddress: Address): Promise<{ readonly sqrtPriceX96: bigint; readonly tick: Tick }> {
    const slot0 = await this.adapter.readContract<
      readonly [bigint, number, number, number, number, number, boolean]
    >({
      address: poolAddress,
      abi: CLMM_POOL_ABI,
      functionName: 'slot0',
    });
    return { sqrtPriceX96: slot0.value[0], tick: slot0.value[1] };
  }

  /** `liquidity()` — the §108 "Active Liquidity" acceptance item. */
  async readActiveLiquidity(poolAddress: Address): Promise<RpcReadResult<bigint>> {
    return this.adapter.readContract<bigint>({
      address: poolAddress,
      abi: CLMM_POOL_ABI,
      functionName: 'liquidity',
    });
  }

  private async readAddress(poolAddress: Address, functionName: 'token0' | 'token1'): Promise<Address> {
    const result = await this.adapter.readContract<Address>({
      address: poolAddress,
      abi: CLMM_POOL_ABI,
      functionName,
    });
    return getAddress(result.value);
  }

  private async readNumber(
    poolAddress: Address,
    functionName: 'fee' | 'tickSpacing',
  ): Promise<number> {
    const result = await this.adapter.readContract<number>({
      address: poolAddress,
      abi: CLMM_POOL_ABI,
      functionName,
    });
    return Number(result.value);
  }

  /** Decimals resolution is cached per address; `decimals()` never changes for a contract. */
  async decimalsOf(tokenAddress: Address): Promise<number> {
    const cached = this.knownDecimals[tokenAddress];
    if (cached !== undefined) return cached;
    const result = await this.adapter.readContract<number>({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: 'decimals',
    });
    this.knownDecimals[tokenAddress] = Number(result.value);
    return Number(result.value);
  }
}
