/**
 * LP position reads (T5) — `NonfungiblePositionManager.positions(tokenId)` plus enumeration.
 *
 * §108 "read LP Position" and "read unclaimed fees" both resolve to `positions()`:
 *
 * - `liquidity` is the raw `L` of the position, the value that `decreaseLiquidity` burns.
 * - `tokensOwed0/1` are **already-accounted** fees from a previous `decreaseLiquidity`/`collect`
 *   and are always collectible.
 * - `feeGrowthInside0/1LastX128` is the checkpoint from the last fee update; unclaimed-but-unrecorded
 *   fees are `(currentFeeGrowthInside - lastX128) * liquidity / 2^128`. That arithmetic needs the
 *   current growth from `feeGrowthGlobal` and the tick snapshots, which is why it is **not** invented
 *   here: this reader reports exactly what the chain says, and the projection lives with the
 *   portfolio valuation code where its approximation can be documented.
 *
 * The manager address is taken from `BSC_DEX_CONTRACTS` (not from an SDK): `@pancakeswap/chains`
 * exports no `contracts` block for chain 56 (research §4.2), so the SDK-free constant is the truth.
 */
import { getAddress } from 'viem';
import { POSITION_MANAGER_ABI } from './abis.ts';
import { ChainError, CHAIN_ERROR_CODES } from './errors.ts';
import type { BscChainAdapter } from './adapter.ts';
import type { LpPositionView } from '../types/adapters.ts';
import type { Address, ChainId, DexId, PoolId } from '../types/primitives.ts';
import { BSC_DEX_CONTRACTS } from '../config/builtins.ts';

/** A position as the chain reports it, plus the DEX/manager it came from. */
export interface LpPositionRead extends LpPositionView {
  readonly chainId: ChainId;
  readonly dex: DexId;
  readonly positionManager: Address;
  /**
   * The owner as reported by `ownerOf`. `positions().operator` is only the approved operator and is
   * `0x0` for a self-custodied position, so ownership must come from `ownerOf`.
   */
  readonly confirmedOwner: Address;
}

/** Raw `positions()` tuple as decoded from the contract. */
export interface RawPositionTuple {
  readonly nonce: bigint;
  readonly operator: Address;
  readonly token0: Address;
  readonly token1: Address;
  readonly fee: number;
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly liquidity: bigint;
  readonly feeGrowthInside0LastX128: bigint;
  readonly feeGrowthInside1LastX128: bigint;
  readonly tokensOwed0: bigint;
  readonly tokensOwed1: bigint;
}

/**
 * Reads LP positions from a position manager.
 *
 * `dex` is required on every call so the manager address is never guessed: PancakeSwap and Uniswap
 * deploy different `NonfungiblePositionManager`s on BSC, and a tokenId is only meaningful together
 * with the manager that minted it.
 */
export class PositionReader {
  private readonly adapter: BscChainAdapter;
  private readonly chainId: ChainId;
  /** Cached manager address per DEX; the DEX whitelist is validated before the first use. */
  private readonly managers = new Map<DexId, Address>();

  constructor(adapter: BscChainAdapter, chainId: ChainId) {
    this.adapter = adapter;
    this.chainId = chainId;
  }

  /** Manager address for a whitelisted DEX; throws when the DEX has no configured deployment. */
  positionManagerFor(dex: DexId): Address {
    const cached = this.managers.get(dex);
    if (cached !== undefined) return cached;
    this.adapter.assertWhitelistedDex(dex);
    const contracts = BSC_DEX_CONTRACTS[dex];
    if (contracts === undefined) {
      throw new ChainError(
        CHAIN_ERROR_CODES.DEX_NOT_WHITELISTED,
        `no position manager configured for DEX ${dex} on chain ${this.chainId}`,
        { dex, chainId: this.chainId },
      );
    }
    this.managers.set(dex, contracts.positionManager);
    return contracts.positionManager;
  }

  /**
   * `positions(tokenId)` for one position.
   *
   * A `tokenId` that does not exist reverts inside the manager. The caller of `getPosition` in §81 is
   * allowed to receive `null` ("no such position"), so the revert is translated into `null` — but only
   * for the *explicit* `ownerOf` probe, never for a network failure.
   */
  async readRawPosition(
    positionManager: Address,
    tokenId: bigint,
  ): Promise<RawPositionTuple | null> {
    const result = await this.adapter.tryReadContract<
      readonly [
        bigint,
        Address,
        Address,
        Address,
        number,
        number,
        number,
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
      ]
    >({
      address: positionManager,
      abi: POSITION_MANAGER_ABI,
      functionName: 'positions',
      args: [tokenId],
    });
    if (result.value === null) return null;
    const [
      nonce,
      operator,
      token0,
      token1,
      fee,
      tickLower,
      tickUpper,
      liquidity,
      feeGrowthInside0LastX128,
      feeGrowthInside1LastX128,
      tokensOwed0,
      tokensOwed1,
    ] = result.value;

    return {
      nonce,
      operator,
      token0: getAddress(token0),
      token1: getAddress(token1),
      fee: Number(fee),
      tickLower: Number(tickLower),
      tickUpper: Number(tickUpper),
      liquidity,
      feeGrowthInside0LastX128,
      feeGrowthInside1LastX128,
      tokensOwed0,
      tokensOwed1,
    };
  }

  /**
   * A position plus its provenance: pool id, manager, confirmed owner.
   *
   * `poolId` is reconstructed as `chainId:dex:poolAddress`, requiring the pool address, because §13
   * forbids identifying a pool by its token pair and fee tier. The pool address is therefore either
   * supplied by the caller or derived from the factory.
   */
  async getPositionView(input: {
    readonly dex: DexId;
    readonly tokenId: bigint;
    readonly poolAddress: Address;
    readonly expectedOwner?: Address;
  }): Promise<LpPositionRead | null> {
    const positionManager = this.positionManagerFor(input.dex);
    const raw = await this.readRawPosition(positionManager, input.tokenId);
    const owner = await this.adapter.readContract<Address>({
      address: positionManager,
      abi: POSITION_MANAGER_ABI,
      functionName: 'ownerOf',
      args: [input.tokenId],
    });

    if (raw === null) return null;

    const confirmedOwner = getAddress(owner.value);
    if (
      input.expectedOwner !== undefined &&
      confirmedOwner.toLowerCase() !== input.expectedOwner.toLowerCase()
    ) {
      throw new ChainError(
        CHAIN_ERROR_CODES.DECODE_FAILED,
        `position ${input.tokenId} is owned by ${confirmedOwner}, not the expected ` +
          `${input.expectedOwner}; refusing to report a position we do not control`,
        { tokenId: input.tokenId.toString(), confirmedOwner, expectedOwner: input.expectedOwner },
      );
    }

    const poolId: PoolId = `${this.chainId}:${input.dex}:${input.poolAddress.toLowerCase()}`;
    return {
      poolId,
      positionTokenId: input.tokenId,
      owner: confirmedOwner,
      token0: raw.token0,
      token1: raw.token1,
      feeTier: raw.fee,
      tickLower: raw.tickLower,
      tickUpper: raw.tickUpper,
      liquidity: raw.liquidity,
      feeGrowthInside0LastX128: raw.feeGrowthInside0LastX128,
      feeGrowthInside1LastX128: raw.feeGrowthInside1LastX128,
      tokensOwed0Raw: raw.tokensOwed0,
      tokensOwed1Raw: raw.tokensOwed1,
      chainId: this.chainId,
      dex: input.dex,
      positionManager,
      confirmedOwner,
    };
  }

  /**
   * Enumerate every position a wallet holds on one manager: `balanceOf(owner)` then
   * `tokenOfOwnerByIndex(owner, i)`.
   *
   * Both calls depend on ERC-721 enumerable bookkeeping. When a manager does not implement
   * `tokenOfOwnerByIndex` this throws rather than returning an empty list — "I could not enumerate"
   * must never look like "the wallet has no positions", because that would understate NAV (§ NAV >
   * Wallet Balance) and could license a second build on top of an existing position.
   */
  async listPositionIds(dex: DexId, owner: Address): Promise<readonly bigint[]> {
    const positionManager = this.positionManagerFor(dex);
    const balance = await this.adapter.readContract<bigint>({
      address: positionManager,
      abi: POSITION_MANAGER_ABI,
      functionName: 'balanceOf',
      args: [owner],
    });
    const count = Number(balance.value);
    const ids: bigint[] = [];
    for (let index = 0; index < count; index += 1) {
      const tokenId = await this.adapter.readContract<bigint>({
        address: positionManager,
        abi: POSITION_MANAGER_ABI,
        functionName: 'tokenOfOwnerByIndex',
        args: [owner, BigInt(index)],
      });
      ids.push(tokenId.value);
    }
    return ids;
  }

  /** Every position of `owner` on `dex`, with `poolId` derived from each position's pool address. */
  async listPositions(input: {
    readonly dex: DexId;
    readonly owner: Address;
    /** Resolves the pool address for a position's (token0, token1, fee) triple. */
    readonly resolvePoolAddress: (token0: Address, token1: Address, fee: number) => Promise<Address | null>;
  }): Promise<readonly LpPositionRead[]> {
    const ids = await this.listPositionIds(input.dex, input.owner);
    const positions: LpPositionRead[] = [];
    for (const tokenId of ids) {
      const positionManager = this.positionManagerFor(input.dex);
      const raw = await this.readRawPosition(positionManager, tokenId);
      if (raw === null) continue;
      const poolAddress = await input.resolvePoolAddress(raw.token0, raw.token1, raw.fee);
      if (poolAddress === null) {
        throw new ChainError(
          CHAIN_ERROR_CODES.DECODE_FAILED,
          `cannot resolve the pool for position ${tokenId} ` +
            `(token0=${raw.token0}, token1=${raw.token1}, fee=${raw.fee}); refusing to report it ` +
            'with a guessed poolId',
          { tokenId: tokenId.toString(), token0: raw.token0, token1: raw.token1, fee: raw.fee },
        );
      }
      const view = await this.getPositionView({
        dex: input.dex,
        tokenId,
        poolAddress,
        expectedOwner: input.owner,
      });
      if (view !== null) positions.push(view);
    }
    return positions;
  }

  /** §108 "unclaimed fees": `tokensOwed0/1` for a position, as raw amounts. */
  async readUnclaimedFees(
    positionManager: Address,
    tokenId: bigint,
  ): Promise<{ readonly tokensOwed0Raw: bigint; readonly tokensOwed1Raw: bigint } | null> {
    const raw = await this.readRawPosition(positionManager, tokenId);
    if (raw === null) return null;
    return { tokensOwed0Raw: raw.tokensOwed0, tokensOwed1Raw: raw.tokensOwed1 };
  }
}
