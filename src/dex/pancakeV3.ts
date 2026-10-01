/**
 * PancakeSwap V3 `DexAdapter` — quotes and LP actions on BSC (chainId 56).
 *
 * ## Why this adapter uses the official Pancake SDK while the Uniswap one does not
 * Research §5: `@uniswap/v3-sdk` and `@pancakeswap/v3-sdk` are not interchangeable (JSBI vs
 * `bigint`, ethers vs viem ABIs, and — fatally — different `FeeAmount` sets, so a fee tier carried
 * across the package boundary silently selects the *wrong pool*). Pancake is the one whitelisted
 * venue whose router can compose a swap and a mint in a single call (§42), and that composition is
 * only available from `@pancakeswap/smart-router`, so this file is the one place the SDK is used.
 * Nothing from this module may leak into the Uniswap adapter (research §5, "one SDK family per
 * venue").
 *
 * ## Three things this file must not get wrong
 * 1. **Atomicity.** `supportsAtomicBuild = true`, and `addLiquidity({swapForDeficit})` MUST be one
 *    transaction to the SmartRouter. The v3 `SwapRouter`/`NPM` `multicall` is a **self-delegatecall**
 *    over their own ABI — it cannot perform a swap — so a "fallback" to two transactions would
 *    silently destroy the all-or-nothing guarantee §42 exists for. When the composition is not
 *    possible this adapter throws; it never splits.
 * 2. **Price impact is not encodable.** The SmartRouter can enforce slippage inside the atomic call
 *    (`amountOutMinimum`/`amountInMaximum` + `amount0Min`/`amount1Min`), but it takes **no**
 *    price-impact parameter and only uses impact internally to decide on a `refundETH` leg.
 *    `priceImpact` is therefore computed here from the pool mid price and the raw amounts, before
 *    anything is encoded (research §4.2, baseline §40).
 * 3. **Deadlines.** The SmartRouter accepts a `previousBlockhash` deadline
 *    (`multicall(bytes32,bytes[])`, selector `0x1f0464d1`, verified present in the deployed runtime
 *    code), which is immune to clock drift. The v3 `SwapRouter` and the `NonfungiblePositionManager`
 *    on BSC expose only `multicall(bytes[])` (`0xac9650d8`) and deadline-bearing parameter structs,
 *    so for their paths a `previous-blockhash` deadline is unencodable and is refused rather than
 *    silently converted into a timestamp.
 *
 * ## Unit agreement
 * Every amount crossing this module is RAW token units and the matching `decimals` comes from the
 * whitelist registry (`TokenRegistry`), never assumed — BSC USDC/USDT are 18 decimals, not 6
 * (research §1).
 */
import { CurrencyAmount, Percent, Token, TradeType } from '@pancakeswap/sdk';
import {
  NoTickDataProvider,
  Pool as PancakePool,
  Position as PancakePosition,
  nonfungiblePositionManagerABI,
  quoterV2ABI,
  swapRouterABI,
} from '@pancakeswap/v3-sdk';
import {
  PoolType,
  RouteType,
  SMART_ROUTER_ADDRESSES,
  SwapRouter,
  type Route,
  type SmartRouterTrade,
  type V3Pool,
} from '@pancakeswap/smart-router';
import { encodeFunctionData, getAddress } from 'viem';
import type { BscChainAdapter } from '../chain/adapter.ts';
import { CLMM_FACTORY_ABI, CLMM_POOL_ABI, POSITION_MANAGER_ABI } from '../chain/abis.ts';
import { CHAIN_ERROR_CODES, ChainError, TxGuardError } from '../chain/errors.ts';
import { PoolReader, type PoolState, type PoolTarget } from '../chain/poolReader.ts';
import type { RpcReadResult } from '../chain/rpc.ts';
import { PositionReader, type RawPositionTuple } from '../chain/positionReader.ts';
import { BSC_ADDRESSES, BSC_DEX_CONTRACTS, type DexContracts } from '../config/builtins.ts';
import { isNoPool, tickSpacingFor, type DexAdapterFactoryOptions } from './index.ts';
import { silentLogger, type Logger } from '../util/logger.ts';
import { computePriceImpact } from '../strategy/swapPlanner.ts';
import { applyFloorRatio, toFloat } from '../util/decimal.ts';
import type {
  AddLiquidityRequest,
  ApprovalType,
  CollectFeesRequest,
  DeadlineSpec,
  DexAdapter,
  LiquidityExecutionResult,
  LpPositionView,
  PoolPriceView,
  PoolRefView,
  RemoveLiquidityRequest,
  SwapExecutionRequest,
  SwapExecutionResult,
  SwapQuote,
  SwapQuoteRequest,
  TickRangeRef,
  TxGuardChecks,
} from '../types/adapters.ts';
import { APPROVAL_TYPES, TX_STATES } from '../types/adapters.ts';
import {
  DEX_IDS,
  TOKEN_KINDS,
  type Address,
  type DexId,
  type FeeTier,
  type Hash,
  type Hex,
  type Tick,
} from '../types/primitives.ts';
import type { Whitelist } from '../types/registry.ts';

const PANCAKE_DEX: DexId = DEX_IDS.PANCAKESWAP_V3;

/** §40 default slippage; overridden per adapter instance from `StrategyConfig.swap.maxSlippage`. */
const DEFAULT_SLIPPAGE_TOLERANCE = 0.003;

/** `applyFloorRatio`'s scale, reused so a slippage ratio converts to a `Percent` losslessly. */
const RATIO_SCALE = 1_000_000_000n;

/**
 * Max per-leg amount a `collect`/`decreaseLiquidity` pull may take; this is what every v3 periphery
 * front-end passes to mean "send me whatever is owed".
 */
const MAX_UINT128 = 2n ** 128n - 1n;

/**
 * BSC USDT reverts an `approve` from a non-zero allowance, so the router must clear it first
 * (`approveZeroThenMax`). The mapping is by contract address because the failure mode is a property
 * of that specific deployment, not of a symbol (research §4.2).
 */
const ZERO_THEN_MAX_TOKENS: Readonly<Record<string, true>> = {
  [BSC_ADDRESSES.USDT.toLowerCase()]: true,
};

/** `IApproveAndCall.ApprovalType`, as the SDK's `ApprovalTypes` enum spells it (values 0..4). */
const SDK_APPROVAL_MAX = 1;
const SDK_APPROVAL_ZERO_THEN_MAX = 3;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** Which write path is running, used only to make a refusal name the caller. */
type WriteAction = 'executeSwap' | 'addLiquidity' | 'removeLiquidity' | 'collectFees';

/**
 * An unset recipient (`0x0`) would burn the proceeds instead of transferring them, so it is refused
 * rather than passed through to `collect`/`mint`.
 */
function assertNotZeroAddress(value: Address, operation: string, label: string): void {
  if (value.toLowerCase() === ZERO_ADDRESS) {
    throw new ChainError(
      CHAIN_ERROR_CODES.INVALID_ARGUMENT,
      `${operation}: ${label} is the zero address; the proceeds would be burned instead of ` +
        'transferred, so an unset recipient is refused',
      { operation, [label]: value },
    );
  }
}

/** The two legs of a trade resolved against a concrete pool's own `token0`/`token1`/`fee`. */
interface ResolvedPoolLegs {
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly feeTier: FeeTier;
}

export class PancakeV3Adapter implements DexAdapter {
  readonly dex: DexId = PANCAKE_DEX;
  readonly chainId: number;
  /**
   * §42 capability of the DEPLOYED contracts: `swapAndAddCallParameters` on the Pancake SmartRouter
   * performs the deficit swap and the mint in one transaction. It is a constant of this class, not a
   * runtime probe.
   */
  readonly supportsAtomicBuild = true;

  /** Where this adapter narrates execution. Silent unless the composition root supplies one. */
  readonly #log: Logger;
  readonly #whitelist: Whitelist;
  readonly #chain: BscChainAdapter;
  readonly #pools: PoolReader;
  readonly #positions: PositionReader;
  readonly #slippageTolerance: number;
  readonly #now: () => Date;

  constructor(options: DexAdapterFactoryOptions) {
    this.#log = options.logger ?? silentLogger;
    // The options carry both the declared chain id and the chain layer; a mismatch would point reads
    // and the write path at different chains, which is unrecoverable downstream.
    if (options.chain.chainId !== options.chainId) {
      throw new ChainError(
        CHAIN_ERROR_CODES.INVALID_ARGUMENT,
        `PancakeV3Adapter was given chainId ${options.chainId} and a chain layer bound to ` +
          `${options.chain.chainId}; refusing to construct`,
        { declared: options.chainId, chain: options.chain.chainId },
      );
    }
    this.chainId = options.chainId;
    this.#whitelist = options.whitelist;
    this.#chain = options.chain;
    this.#slippageTolerance = options.slippageTolerance ?? DEFAULT_SLIPPAGE_TOLERANCE;
    this.#now = options.now ?? (() => new Date());
    // §12: fail at construction, not on the first write, when this DEX is not whitelisted for the chain.
    this.assertWhitelisted();
    if (BSC_DEX_CONTRACTS[PANCAKE_DEX] === undefined) {
      throw new ChainError(
        CHAIN_ERROR_CODES.DEX_NOT_WHITELISTED,
        `no deployed contract set for ${PANCAKE_DEX} on chain ${options.chainId}`,
        { dex: PANCAKE_DEX },
      );
    }
    this.#pools = new PoolReader(this.#chain, this.#whitelist.registry, this.chainId);
    this.#positions = new PositionReader(this.#chain, this.chainId);
  }

  /** §12 whitelist check. */
  assertWhitelisted(): void {
    this.#whitelist.assertWhitelistedChain(this.chainId);
    this.#whitelist.assertWhitelistedDex(this.chainId, PANCAKE_DEX);
  }

  // -------------------------------------------------------------------------------------------
  // Read-only surface
  // -------------------------------------------------------------------------------------------

  /**
   * `factory.getPool(tokenA, tokenB, fee)` — a real `eth_call`, so "the factory answered the zero
   * address" is a *proven absence* (`null`) while a transport failure throws: the scanner depends on
   * that distinction and must never read "the node is down" as "the pool does not exist" (§96).
   *
   * `token0`/`token1` are reported in the pool's own canonical (address-sorted) order, not in the
   * caller's argument order: a caller that treated its first argument as `token0` would inverse the
   * price of every pool whose ordering is the reverse.
   */
  async getPool(token0: Address, token1: Address, feeTier: FeeTier): Promise<PoolRefView | null> {
    const expectedSpacing = tickSpacingFor(PANCAKE_DEX, feeTier);
    const poolAddress = await this.#factoryPoolAddress(token0, token1, feeTier);
    if (poolAddress === null) return null;

    // The address the factory returned is authoritative for `token0`/`token1`/`fee` order: a caller
    // that assumed its first argument was `token0` would inverse the price of every pool whose
    // ordering is the reverse, so read the order from the pool instead of from the arguments.
    const target = await this.#pools.resolvePool(poolAddress, PANCAKE_DEX);
    if (target.feeTier !== feeTier) {
      throw new ChainError(
        CHAIN_ERROR_CODES.DECODE_FAILED,
        `factory returned pool ${poolAddress} for fee ${feeTier}, but the pool reports fee ` +
          `${target.feeTier}; refusing to report it as a ${feeTier} pool`,
        { poolAddress, requestedFee: feeTier, onChainFee: target.feeTier },
      );
    }
    if (target.tickSpacing !== expectedSpacing) {
      throw new ChainError(
        CHAIN_ERROR_CODES.DECODE_FAILED,
        `pool ${poolAddress} reports tickSpacing ${target.tickSpacing} for fee ${feeTier}, but ` +
          `${PANCAKE_DEX} maps that fee to ${expectedSpacing}; refusing to plan on the wrong grid`,
        { poolAddress, fee: feeTier, onChainTickSpacing: target.tickSpacing, expectedSpacing },
      );
    }

    return {
      chainId: this.chainId,
      dex: PANCAKE_DEX,
      poolAddress: target.poolAddress,
      poolId: target.poolId,
      token0: getAddress(target.token0.address),
      token1: getAddress(target.token1.address),
      feeTier: target.feeTier,
      tickSpacing: target.tickSpacing,
    };
  }

  /** §108 pool state, via the shared `PoolReader` (chain layer — never a second implementation). */
  async getPoolPrice(poolAddress: Address): Promise<PoolPriceView> {
    const target = await this.#resolvePool(poolAddress);
    const state = await this.#pools.readPool(target);
    return {
      poolId: state.poolId,
      sqrtPriceX96: state.sqrtPriceX96,
      tick: state.tick,
      liquidity: state.liquidity,
      feeTier: state.feeTier,
      tickSpacing: state.tickSpacing,
      priceToken1PerToken0: state.priceToken1PerToken0,
      asOf: state.asOf,
    };
  }

  /** `liquidity()` — the in-range active liquidity, the number that sizes a swap's price move. */
  async getLiquidity(poolAddress: Address): Promise<bigint> {
    const result = await this.#pools.readActiveLiquidity(getAddress(poolAddress));
    return result.value;
  }

  /** `slot0().tick` — the cheapest read that answers "is the price inside the range?". */
  async getTick(poolAddress: Address): Promise<Tick> {
    const slot0 = await this.#pools.readSlot0(getAddress(poolAddress));
    return slot0.tick;
  }

  /**
   * §39/§40 quote from the real QuoterV2 (`eth_call`). Nothing is simulated off-chain here: a quote
   * that looks plausible but was not produced by the deployed quoter is worse than no quote, because
   * the §40 gate would then pass on invented data.
   *
   * `priceImpact` is computed locally from the pool mid price and the raw amounts — the SDK cannot
   * express that bound inside the call (research §4.2), so the gate in `evaluateSwapQuote` depends on
   * this number being derived from *this* quote and *this* pool state.
   */
  async quoteSwap(request: SwapQuoteRequest): Promise<SwapQuote> {
    const poolAddress = this.#poolAddressFromId(request.poolId);
    const target = await this.#resolvePool(poolAddress);
    const state = await this.#pools.readPool(target);

    const tokenIn = getAddress(request.tokenIn);
    const tokenOut = getAddress(request.tokenOut);
    this.#assertPoolLegsMatchTokenPair(target.token0.address, target.token1.address, tokenIn, tokenOut);

    if (request.amountIn <= 0n) {
      throw new ChainError(
        CHAIN_ERROR_CODES.INVALID_ARGUMENT,
        `quoteSwap requires a positive raw amountIn, got ${request.amountIn.toString()}`,
        { poolId: request.poolId },
      );
    }
    if (!Number.isFinite(request.ttlSeconds) || request.ttlSeconds <= 0) {
      throw new ChainError(
        CHAIN_ERROR_CODES.INVALID_ARGUMENT,
        `quoteSwap requires a positive ttlSeconds, got ${String(request.ttlSeconds)}`,
        { poolId: request.poolId },
      );
    }

    const quoteResult = await this.#chain.readContract<readonly [bigint, bigint, number, bigint]>({
      address: this.#contracts().quoterV2,
      abi: quoterV2ABI,
      functionName: 'quoteExactInputSingle',
      args: [
        {
          tokenIn,
          tokenOut,
          amountIn: request.amountIn,
          fee: state.feeTier,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    const amountOutRaw = quoteResult.value[0];

    const tokenInIsToken0 = target.token0.address.toLowerCase() === tokenIn.toLowerCase();
    const decimalsIn = tokenInIsToken0 ? target.token0.decimals : target.token1.decimals;
    const decimalsOut = tokenInIsToken0 ? target.token1.decimals : target.token0.decimals;
    const symbolIn = tokenInIsToken0 ? target.token0.symbol : target.token1.symbol;
    const symbolOut = tokenInIsToken0 ? target.token1.symbol : target.token0.symbol;

    const quotedAt = this.#now();
    return {
      poolId: state.poolId,
      tokenIn,
      tokenOut,
      amountInRaw: request.amountIn,
      amountOutRaw,
      amountInUsd: this.#usdValueOfInput({
        target,
        tokenInIsToken0,
        amountInRaw: request.amountIn,
        decimalsIn,
        priceToken1PerToken0: state.priceToken1PerToken0,
      }),
      priceImpact: computePriceImpact({
        pool: { poolId: state.poolId, priceToken1PerToken0: state.priceToken1PerToken0 },
        tokenIn,
        tokenOut,
        amountInRaw: request.amountIn,
        amountOutRaw,
        tokenInDecimals: decimalsIn,
        tokenOutDecimals: decimalsOut,
        poolToken0: target.token0.address,
      }),
      slippageTolerance: this.#slippageTolerance,
      amountOutMinimumRaw: applyFloorRatio(amountOutRaw, 1 - this.#slippageTolerance),
      quotedAt: quotedAt.toISOString(),
      expiresAt: new Date(quotedAt.getTime() + request.ttlSeconds * 1000).toISOString(),
      route: [`${symbolIn}/${symbolOut} ${(state.feeTier / 10_000).toFixed(2)}%`],
    };
  }

  // -------------------------------------------------------------------------------------------
  // Write surface
  // -------------------------------------------------------------------------------------------

  /**
   * A single v3 `exactInputSingle` swap — **never** an add-liquidity.
   *
   * The v3 `SwapRouter`'s `multicall` is a self-delegatecall over its own ABI: it can batch several
   * swaps, but it cannot call the `NonfungiblePositionManager`, so this router and the NPM can never
   * be combined into one atomic swap+add. That is exactly why the atomic build is expressed as
   * `addLiquidity({ swapForDeficit })` through the SmartRouter, and why this method must not grow a
   * "mint too" branch.
   */
  async executeSwap(request: SwapExecutionRequest): Promise<SwapExecutionResult> {
    this.#assertGuardOk(request.guard, 'executeSwap');
    const recipient = this.#requireSigner('executeSwap');
    const deadline = this.#unixDeadline(request.deadline, 'executeSwap');

    const quote = request.quote;
    const poolAddress = this.#poolAddressFromId(quote.poolId);
    const pool = await this.#poolLegs(poolAddress, quote.tokenIn, quote.tokenOut);

    const data = this.#encodeExactInputSingle({
      tokenIn: pool.tokenIn,
      tokenOut: pool.tokenOut,
      feeTier: pool.feeTier,
      recipient,
      deadline,
      amountIn: quote.amountInRaw,
      amountOutMinimum: quote.amountOutMinimumRaw,
    });

    const txHash = await this.#send(this.#contracts().swapRouter, data, 0n, request.guard);
    return {
      txHash,
      state: TX_STATES.SUBMITTED,
      amountInRaw: quote.amountInRaw,
      amountOutRaw: quote.amountOutRaw,
      approvalType: this.#requiredApprovalType(quote.tokenIn),
    };
  }

  /**
   * §33-§38 add liquidity, in one of two shapes:
   *
   * - **without `swapForDeficit`** — a plain `mint` on the `NonfungiblePositionManager`, using the
   *   request's own `amount0Desired`/`amount0Min`. The executor derived those from the §40 tolerance,
   *   and the request carries no `slippageTolerance` field, so re-deriving them here would mean
   *   inventing a bound;
   * - **with `swapForDeficit`** — ONE transaction to the Pancake **SmartRouter** built by
   *   `SwapRouter.swapAndAddCallParameters`, which contains the swap legs, the pulls that top the
   *   position up, the router→NPM approvals and the `mint`/`increaseLiquidity`, all inside one
   *   `multicall`. If that composition cannot be built for any reason this method throws: falling back
   *   to two transactions would be a silent downgrade of §42's all-or-nothing guarantee.
   */
  async addLiquidity(request: AddLiquidityRequest): Promise<LiquidityExecutionResult> {
    this.#assertGuardOk(request.guard, 'addLiquidity');
    assertNotZeroAddress(request.recipient, 'addLiquidity', 'recipient');
    // A signer is still required, and not only for the broadcast: the SmartRouter's `pull` legs and the
    // NPM's `mint` transferFrom draw the position's tokens from `msg.sender`, so the address that signs
    // is the address the capital must already sit in.
    this.#requireSigner('addLiquidity');

    const poolAddress = this.#poolAddressFromId(request.poolId);
    const target = await this.#resolvePool(poolAddress);
    this.#assertRangeAligned(request.tickRange, target.feeTier, target.tickSpacing);

    if (request.amount0DesiredRaw <= 0n || request.amount1DesiredRaw <= 0n) {
      throw new ChainError(
        CHAIN_ERROR_CODES.INVALID_ARGUMENT,
        `addLiquidity needs positive desired amounts, got ${request.amount0DesiredRaw.toString()}/` +
          `${request.amount1DesiredRaw.toString()}`,
        { poolId: request.poolId },
      );
    }

    if (request.swapForDeficit !== undefined) {
      return this.#addLiquidityAtomic(request, target);
    }

    const data = this.#encodeMint({
      token0: target.token0.address,
      token1: target.token1.address,
      feeTier: target.feeTier,
      tickLower: request.tickRange.lowerTick,
      tickUpper: request.tickRange.upperTick,
      amount0Desired: request.amount0DesiredRaw,
      amount1Desired: request.amount1DesiredRaw,
      amount0Min: request.amount0MinRaw,
      amount1Min: request.amount1MinRaw,
      recipient: request.recipient,
      deadline: this.#unixDeadline(request.deadline, 'addLiquidity'),
    });

    const txHash = await this.#send(this.#contracts().positionManager, data, 0n, request.guard);
    return { txHash, state: TX_STATES.SUBMITTED };
  }

  /**
   * `decreaseLiquidity` (+ `burn` on a full exit) followed by `collect`, batched through the NPM's
   * own `multicall(bytes[])`.
   *
   * `liquidityRaw === null` is the full-exit case: the whole `L` is burned and the emptied NFT is
   * destroyed in the same call.
   */
  async removeLiquidity(request: RemoveLiquidityRequest): Promise<LiquidityExecutionResult> {
    this.#assertGuardOk(request.guard, 'removeLiquidity');
    assertNotZeroAddress(request.recipient, 'removeLiquidity', 'recipient');
    const deadline = this.#unixDeadline(request.deadline, 'removeLiquidity');

    const requested = request.liquidityRaw;
    if (requested !== null && requested <= 0n) {
      throw new ChainError(
        CHAIN_ERROR_CODES.INVALID_ARGUMENT,
        `removeLiquidity liquidityRaw must be positive or null (full exit), got ${requested.toString()}`,
        { positionTokenId: request.positionTokenId.toString() },
      );
    }
    // The position is read on both paths: a full exit takes its exact `L` from here, and a partial exit
    // is checked against it. Burning more than the position holds would revert on chain, and encoding a
    // doomed call is strictly worse than refusing it — the operator would see a failure with no cause.
    const position = await this.#readRawPosition(request.positionTokenId, 'removeLiquidity');
    await this.#assertPositionMatchesPool(request.poolId, position, 'removeLiquidity');
    const onChainLiquidity = position.liquidity;
    if (requested !== null && requested > onChainLiquidity) {
      throw new ChainError(
        CHAIN_ERROR_CODES.INVALID_ARGUMENT,
        `position ${request.positionTokenId.toString()} holds ${onChainLiquidity.toString()} liquidity ` +
          `but ${requested.toString()} was requested; decreaseLiquidity would revert`,
        {
          positionTokenId: request.positionTokenId.toString(),
          requested: requested.toString(),
          onChain: onChainLiquidity.toString(),
        },
      );
    }
    const burnLiquidity = requested ?? onChainLiquidity;

    const calls: Hex[] = [
      encodeFunctionData({
        abi: nonfungiblePositionManagerABI,
        functionName: 'decreaseLiquidity',
        args: [
          {
            tokenId: request.positionTokenId,
            liquidity: burnLiquidity,
            amount0Min: request.amount0MinRaw,
            amount1Min: request.amount1MinRaw,
            deadline,
          },
        ],
      }),
      this.#encodeCollect(request.positionTokenId, getAddress(request.recipient)),
    ];
    if (requested === null) {
      calls.push(
        encodeFunctionData({
          abi: nonfungiblePositionManagerABI,
          functionName: 'burn',
          args: [request.positionTokenId],
        }),
      );
    }

    const txHash = await this.#send(
      this.#contracts().positionManager,
      this.#encodeMulticall(calls),
      0n,
      request.guard,
    );
    return { txHash, state: TX_STATES.SUBMITTED, ...(requested === null ? {} : { liquidity: requested }) };
  }

  /**
   * `collect` with `type(uint128).max` on both legs — "send me whatever is owed".
   *
   * The maxima bound what may be *transferred out*, they do not authorise spending, so the §93
   * "never unlimited" rule (which is about ERC-20 allowances) does not apply to them.
   */
  async collectFees(request: CollectFeesRequest): Promise<LiquidityExecutionResult> {
    this.#assertGuardOk(request.guard, 'collectFees');
    assertNotZeroAddress(request.recipient, 'collectFees', 'recipient');
    const position = await this.#readRawPosition(request.positionTokenId, 'collectFees');
    await this.#assertPositionMatchesPool(request.poolId, position, 'collectFees');
    const data = this.#encodeCollect(request.positionTokenId, getAddress(request.recipient));
    const txHash = await this.#send(this.#contracts().positionManager, data, 0n, request.guard);
    return { txHash, state: TX_STATES.SUBMITTED, positionTokenId: request.positionTokenId };
  }

  /**
   * `positions(tokenId)` + `ownerOf(tokenId)`, with the §13 `poolId` rebuilt from the pool the
   * position actually points at.
   *
   * A `tokenId` that does not exist reverts inside the manager; `PositionReader.readRawPosition` turns
   * exactly that revert into `null` ("no such position") while still raising on a transport failure,
   * so "the node is down" is never reported as "you have no position".
   */
  async getPosition(tokenId: bigint): Promise<LpPositionView | null> {
    const positionManager = this.#positions.positionManagerFor(PANCAKE_DEX);
    const raw = await this.#positions.readRawPosition(positionManager, tokenId);
    if (raw === null) return null;

    const [ownerResult, poolAddress] = await Promise.all([
      this.#chain.readContract<Address>({
        address: positionManager,
        abi: POSITION_MANAGER_ABI,
        functionName: 'ownerOf',
        args: [tokenId],
      }),
      this.#factoryPoolAddress(raw.token0, raw.token1, raw.fee),
    ]);
    if (poolAddress === null) {
      throw new ChainError(
        CHAIN_ERROR_CODES.DECODE_FAILED,
        `position ${tokenId.toString()} points at ${raw.token0}/${raw.token1} fee ${raw.fee}, for ` +
          'which the Pancake factory reports no pool; refusing to report a position whose pool cannot ' +
          'be identified (§13)',
        { tokenId: tokenId.toString(), token0: raw.token0, token1: raw.token1, fee: raw.fee },
      );
    }

    return {
      // §13 identity: `chainId:dex:poolAddress`, lowercased so the key is stable.
      poolId: `${this.chainId}:${PANCAKE_DEX}:${poolAddress.toLowerCase()}`,
      positionTokenId: tokenId,
      owner: getAddress(ownerResult.value),
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
    };
  }

  // -------------------------------------------------------------------------------------------
  // §42 atomic build
  // -------------------------------------------------------------------------------------------

  /**
   * The single-transaction swap+add-liquidity build.
   *
   * The SmartRouter is the only contract that can do this: `SwapRouter.swapAndAddCallParameters`
   * encodes the swap legs (with `routerMustCustody`, so each leg's output goes to the router), the
   * pulls that top the position up to its mint amounts, the router→NPM approvals, the `mint`
   * (`ApproveAndCall.mint`, selector `0x11ed56c9`) and two sweeps, all inside one
   * `multicall(bytes32 previousBlockhash, bytes[])` (selector `0x1f0464d1`).
   *
   * Slippage is enforced on chain: `options.slippageTolerance` becomes each swap leg's
   * `amountOutMinimum`/`amountInMaximum` and, through `minimalPosition`, the mint's
   * `amount0Min`/`amount1Min` — the SDK takes the *tighter* of the two, so the encoded bound never
   * exceeds what was approved. Price impact is not encodable and was gated before this point (§40).
   */
  async #addLiquidityAtomic(
    request: AddLiquidityRequest,
    target: PoolTarget,
  ): Promise<LiquidityExecutionResult> {
    const swapForDeficit = request.swapForDeficit;
    if (swapForDeficit === undefined) {
      throw new ChainError(
        CHAIN_ERROR_CODES.INVALID_ARGUMENT,
        'internal: the atomic path was entered without swapForDeficit',
      );
    }
    const quote = swapForDeficit.quote;
    // The trade and the position MUST be the same pool: swapping in one pool and minting in another
    // would still be atomic but would not be the build that was approved.
    if (quote.poolId !== request.poolId) {
      throw new ChainError(
        CHAIN_ERROR_CODES.INVALID_ARGUMENT,
        `atomic build refused: the deficit swap is quoted on ${quote.poolId} but the position is on ` +
          `${request.poolId}; the swap and the mint must target one pool (${PANCAKE_DEX})`,
        { quotePoolId: quote.poolId, positionPoolId: request.poolId },
      );
    }
    this.#assertPoolLegsMatchTokenPair(
      target.token0.address,
      target.token1.address,
      getAddress(quote.tokenIn),
      getAddress(quote.tokenOut),
    );
    if (quote.amountInRaw <= 0n || quote.amountOutRaw <= 0n) {
      throw new ChainError(
        CHAIN_ERROR_CODES.INVALID_ARGUMENT,
        'atomic build refused: the deficit swap has non-positive amounts ' +
          `(${quote.amountInRaw.toString()} in / ${quote.amountOutRaw.toString()} out)`,
        { poolId: request.poolId },
      );
    }

    const state: PoolState = await this.#pools.readPool(target);
    const sdkPool = this.#sdkPool(target, state);
    const tokenIn = this.#sdkToken(target, quote.tokenIn);
    const tokenOut = this.#sdkToken(target, quote.tokenOut);
    const inputAmount = CurrencyAmount.fromRawAmount(tokenIn, quote.amountInRaw);
    const outputAmount = CurrencyAmount.fromRawAmount(tokenOut, quote.amountOutRaw);
    const route: Route = {
      type: RouteType.V3,
      percent: 100,
      path: [tokenIn, tokenOut],
      pools: [this.#sdkRoutePool(target, state, target.poolAddress)],
      inputAmount,
      outputAmount,
    };
    const trade: SmartRouterTrade<typeof TradeType.EXACT_INPUT> = {
      tradeType: TradeType.EXACT_INPUT,
      inputAmount,
      outputAmount,
      routes: [route],
      gasEstimate: 190_000n,
    };

    // Router-compatible rounding (`useFullPrecision: false`): the router computes the mintable `L`
    // the same way, so the position encoded here cannot ask for more liquidity than the NPM accepts.
    const position = PancakePosition.fromAmounts({
      pool: sdkPool,
      tickLower: request.tickRange.lowerTick,
      tickUpper: request.tickRange.upperTick,
      amount0: request.amount0DesiredRaw,
      amount1: request.amount1DesiredRaw,
      useFullPrecision: false,
    });
    if (position.liquidity <= 0n) {
      throw new ChainError(
        CHAIN_ERROR_CODES.INVALID_ARGUMENT,
        `atomic build refused: the desired amounts yield zero liquidity for ` +
          `[${request.tickRange.lowerTick}, ${request.tickRange.upperTick}] at tick ${state.tick}; the ` +
          'mint would revert with ZERO_LIQUIDITY',
        { poolId: request.poolId, tick: state.tick, amount0: request.amount0DesiredRaw.toString() },
      );
    }

    const params = SwapRouter.swapAndAddCallParameters(
      trade,
      {
        slippageTolerance: this.#ratioToPercent(quote.slippageTolerance),
        recipient: request.recipient,
        // research §4.2: the `previousBlockhash` variant avoids a clock-drift revert on unattended runs.
        deadlineOrPreviousBlockhash: this.#atomicDeadline(request.deadline),
      },
      position,
      { recipient: request.recipient },
      this.#sdkApprovalType(quote.tokenIn),
      this.#sdkApprovalType(quote.tokenOut),
    );

    /*
     * Everything needed to diagnose a revert, BEFORE the send attempt.
     *
     * A failed `eth_estimateGas` never reaches the chain, so no hash exists and nothing is recorded
     * anywhere: the calldata that caused it is the only artefact, and it existed solely in memory. Logging
     * it here means the next failure is readable directly rather than reconstructed from a pasted error.
     */
    this.#log.info('execute', 'atomic build (swap + mint in one transaction)', {
      router: this.#smartRouterAddress(),
      value: params.value,
      approvalTokenIn: quote.tokenIn,
      approvalTokenOut: quote.tokenOut,
      approvalTypeIn: this.#sdkApprovalType(quote.tokenIn),
      approvalTypeOut: this.#sdkApprovalType(quote.tokenOut),
      amount0Desired: request.amount0DesiredRaw,
      amount1Desired: request.amount1DesiredRaw,
      liquidity: position.liquidity,
      calldataBytes: (params.calldata.length - 2) / 2,
    });
    // The calldata itself at debug: it is long, and only needed once something has failed.
    this.#log.debug('execute', 'calldata', { data: params.calldata });

    let txHash: Hash;
    try {
      txHash = await this.#send(
        this.#smartRouterAddress(),
        params.calldata,
        BigInt(params.value),
        request.guard,
      );
    } catch (error) {
      // The failure branch: report the encoded call alongside the reason, so the two can be read together.
      this.#log.error('execute', 'atomic build FAILED', {
        reason: errorMessage(error),
        revertData: revertDataOf(error),
        to: this.#smartRouterAddress(),
        calldata: params.calldata,
      });
      throw error;
    }
    this.#log.info('execute', 'atomic build submitted', { txHash });
    return {
      txHash,
      state: TX_STATES.SUBMITTED,
      liquidity: position.liquidity,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Encoding helpers
  // -------------------------------------------------------------------------------------------

  /** `collect` with an uncapped per-leg amount — "send me whatever is owed" (selector `0xfc6f7865`). */
  #encodeCollect(tokenId: bigint, recipient: Address): Hex {
    return encodeFunctionData({
      abi: nonfungiblePositionManagerABI,
      functionName: 'collect',
      args: [{ tokenId, recipient, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }],
    });
  }

  /** `exactInputSingle` on the v3 SwapRouter — the deadline-bearing struct (selector `0x414bf389`). */
  #encodeExactInputSingle(params: {
    readonly tokenIn: Address;
    readonly tokenOut: Address;
    readonly feeTier: FeeTier;
    readonly recipient: Address;
    readonly deadline: bigint;
    readonly amountIn: bigint;
    readonly amountOutMinimum: bigint;
  }): Hex {
    return encodeFunctionData({
      abi: swapRouterABI,
      functionName: 'exactInputSingle',
      args: [
        {
          tokenIn: params.tokenIn,
          tokenOut: params.tokenOut,
          fee: params.feeTier,
          recipient: params.recipient,
          deadline: params.deadline,
          amountIn: params.amountIn,
          amountOutMinimum: params.amountOutMinimum,
          // 0 = no price limit; the on-chain `amountOutMinimum` is the enforced bound.
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
  }

  /** `mint` on the NPM (selector `0x88316456`), with the request's explicit minimums. */
  #encodeMint(params: {
    readonly token0: Address;
    readonly token1: Address;
    readonly feeTier: FeeTier;
    readonly tickLower: Tick;
    readonly tickUpper: Tick;
    readonly amount0Desired: bigint;
    readonly amount1Desired: bigint;
    readonly amount0Min: bigint;
    readonly amount1Min: bigint;
    readonly recipient: Address;
    readonly deadline: bigint;
  }): Hex {
    return encodeFunctionData({
      abi: nonfungiblePositionManagerABI,
      functionName: 'mint',
      args: [
        {
          token0: params.token0,
          token1: params.token1,
          fee: params.feeTier,
          tickLower: params.tickLower,
          tickUpper: params.tickUpper,
          amount0Desired: params.amount0Desired,
          amount1Desired: params.amount1Desired,
          amount0Min: params.amount0Min,
          amount1Min: params.amount1Min,
          recipient: params.recipient,
          deadline: params.deadline,
        },
      ],
    });
  }

  /**
   * `multicall(bytes[])` (selector `0xac9650d8`).
   *
   * A single call is returned unwrapped: the SDK's `Multicall.encodeMulticall` does the same, and
   * wrapping one call costs gas while adding no atomicity.
   */
  #encodeMulticall(calls: readonly Hex[]): Hex {
    const [first, ...rest] = calls;
    if (first === undefined) {
      throw new ChainError(CHAIN_ERROR_CODES.INVALID_ARGUMENT, 'refusing to encode an empty multicall');
    }
    if (rest.length === 0) return first;
    return encodeFunctionData({
      abi: nonfungiblePositionManagerABI,
      functionName: 'multicall',
      args: [[...calls]],
    });
  }

  // -------------------------------------------------------------------------------------------
  // Reads used by the write paths
  // -------------------------------------------------------------------------------------------

  /** `readPool` for a pool address, so callers never hand-build a `PoolTarget`. */
  async #resolvePool(poolAddress: Address): Promise<PoolTarget> {
    return this.#pools.resolvePool(getAddress(poolAddress), PANCAKE_DEX);
  }

  /** `factory.getPool(...)`; `null` means the factory answered the zero address (a proven absence). */
  async #factoryPoolAddress(
    tokenA: Address,
    tokenB: Address,
    feeTier: FeeTier,
  ): Promise<Address | null> {
    const factory = this.#contracts().factory;
    let result: RpcReadResult<Address>;
    try {
      result = await this.#chain.readContract<Address>({
        address: factory,
        abi: CLMM_FACTORY_ABI,
        functionName: 'getPool',
        args: [getAddress(tokenA), getAddress(tokenB), feeTier],
      });
    } catch (error) {
      // A reverting or unreachable factory probe is not a proven absence; only the zero address is.
      throw new ChainError(
        CHAIN_ERROR_CODES.RPC_NODE_ERROR,
        `factory.getPool(${tokenA}, ${tokenB}, ${feeTier}) could not be read: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        { factory, tokenA, tokenB, feeTier },
      );
    }
    if (isNoPool(result.value)) return null;
    return getAddress(result.value);
  }

  /** The pool's own `token0`/`token1`/`fee`, verified against the trade's token pair. */
  async #poolLegs(
    poolAddress: Address,
    tokenIn: Address,
    tokenOut: Address,
  ): Promise<ResolvedPoolLegs> {
    const [token0, token1, fee] = await Promise.all([
      this.#chain.readContract<Address>({
        address: poolAddress,
        abi: CLMM_POOL_ABI,
        functionName: 'token0',
      }),
      this.#chain.readContract<Address>({
        address: poolAddress,
        abi: CLMM_POOL_ABI,
        functionName: 'token1',
      }),
      this.#chain.readContract<number>({
        address: poolAddress,
        abi: CLMM_POOL_ABI,
        functionName: 'fee',
      }),
    ]);
    this.#assertPoolLegsMatchTokenPair(
      getAddress(token0.value),
      getAddress(token1.value),
      tokenIn,
      tokenOut,
    );
    return { tokenIn, tokenOut, feeTier: Number(fee.value) };
  }

  /**
   * The position's raw `positions()` record, or a refusal when the manager has no such token.
   *
   * A missing `tokenId` is not "nothing to do": the encoded call would revert with no cause, so the
   * adapter refuses before encoding and says which manager was asked.
   */
  async #readRawPosition(tokenId: bigint, action: WriteAction): Promise<RawPositionTuple> {
    const positionManager = this.#positions.positionManagerFor(PANCAKE_DEX);
    const raw = await this.#positions.readRawPosition(positionManager, tokenId);
    if (raw === null) {
      throw new ChainError(
        CHAIN_ERROR_CODES.DECODE_FAILED,
        `${action} refused: position ${tokenId.toString()} does not exist on ${positionManager}`,
        { tokenId: tokenId.toString(), positionManager },
      );
    }
    return raw;
  }

  /**
   * The position must belong to the pool the request names.
   *
   * The `poolId` is in the request for a reason: a collect or a decrease signed against a tokenId whose
   * pool is a different one would be recorded in the audit trail as an action on a pool it never
   * touched. The pool is derived from the position's own `(token0, token1, fee)` through the factory,
   * so no caller-supplied pairing is trusted.
   */
  async #assertPositionMatchesPool(poolId: string, raw: RawPositionTuple, action: WriteAction): Promise<void> {
    const requestedPool = this.#poolAddressFromId(poolId);
    const actualPool = await this.#factoryPoolAddress(raw.token0, raw.token1, raw.fee);
    if (actualPool === null || actualPool.toLowerCase() !== requestedPool.toLowerCase()) {
      throw new ChainError(
        CHAIN_ERROR_CODES.INVALID_ARGUMENT,
        `${action} refused: the position belongs to pool ${actualPool ?? 'that the factory does not ' +
          'know'}, but the request names ${requestedPool}`,
        { requestedPool, actualPool, token0: raw.token0, token1: raw.token1, fee: raw.fee },
      );
    }
  }

  // -------------------------------------------------------------------------------------------
  // Validation helpers
  // -------------------------------------------------------------------------------------------

  /**
   * §95: every write starts here. A guard that is not `ok` means at least one pre-flight check
   * failed, so nothing may be encoded — let alone sent.
   */
  #assertGuardOk(guard: TxGuardChecks, action: WriteAction): void {
    if (guard.ok === true) return;
    throw new TxGuardError(guard.failures.length > 0 ? guard.failures : ['guard.ok is false'], {
      action,
    });
  }

  /** §94: no signer means no write, and the swap/mint recipient cannot be invented. */
  #requireSigner(action: WriteAction): Address {
    const signer = this.#chain.getSignerAddress();
    if (signer === null) {
      throw new ChainError(
        CHAIN_ERROR_CODES.INVALID_ARGUMENT,
        `${action} refused: no signer is attached to the chain layer, so neither the recipient nor ` +
          'the broadcast can be resolved (§92/§94)',
        { action },
      );
    }
    return signer;
  }

  /**
   * A `timestamp` deadline becomes unix seconds. The `previous-blockhash` variant is **not**
   * expressible on the v3 `SwapRouter`/`NPM` — their `multicall(bytes32,bytes[])` overload does not
   * exist in the deployed bytecode (only `0xac9650d8`), their deadline is a parameter of the struct —
   * and converting a blockhash into a timestamp would silently replace a drift-immune deadline with
   * one that can revert. Refuse instead.
   */
  #unixDeadline(deadline: DeadlineSpec, action: WriteAction): bigint {
    if (deadline.kind === 'timestamp') {
      if (!Number.isInteger(deadline.unixSeconds) || deadline.unixSeconds <= 0) {
        throw new ChainError(
          CHAIN_ERROR_CODES.INVALID_ARGUMENT,
          `${action} refused: timestamp deadline ${String(deadline.unixSeconds)} is not a unix second`,
          { action },
        );
      }
      return BigInt(deadline.unixSeconds);
    }
    throw new ChainError(
      CHAIN_ERROR_CODES.INVALID_ARGUMENT,
      `${action} refused: a previous-blockhash deadline cannot be encoded for the v3 ` +
        'SwapRouter/NonfungiblePositionManager (they expose only multicall(bytes[]), selector ' +
        '0xac9650d8) and converting it to a timestamp would reintroduce clock-drift reverts. Use the ' +
        'atomic SmartRouter path, or supply a timestamp deadline',
      { action, blockhash: deadline.blockhash },
    );
  }

  /** The SmartRouter accepts both deadline forms; the blockhash variant is the drift-immune one. */
  #atomicDeadline(deadline: DeadlineSpec): bigint | string {
    if (deadline.kind === 'previous-blockhash') {
      if (!/^0x[0-9a-fA-F]{64}$/u.test(deadline.blockhash)) {
        throw new ChainError(
          CHAIN_ERROR_CODES.INVALID_ARGUMENT,
          `atomic build refused: ${deadline.blockhash} is not a 32-byte block hash`,
          { blockhash: deadline.blockhash },
        );
      }
      return deadline.blockhash;
    }
    if (!Number.isInteger(deadline.unixSeconds) || deadline.unixSeconds <= 0) {
      throw new ChainError(
        CHAIN_ERROR_CODES.INVALID_ARGUMENT,
        `atomic build refused: timestamp deadline ${String(deadline.unixSeconds)} is not a unix second`,
      );
    }
    return BigInt(deadline.unixSeconds);
  }

  /**
   * §34/§108: both ticks must sit on the pool's grid. The request's `tickSpacing` is asserted against
   * the pool's own `tickSpacing()` and against the per-DEX fee→spacing table, so a caller that planned
   * against the wrong DEX's grid is refused instead of minting on the wrong ticks.
   */
  #assertRangeAligned(range: TickRangeRef, feeTier: FeeTier, poolTickSpacing: number): void {
    const fromTable = tickSpacingFor(PANCAKE_DEX, feeTier);
    if (poolTickSpacing !== fromTable) {
      throw new ChainError(
        CHAIN_ERROR_CODES.DECODE_FAILED,
        `pool fee ${feeTier} reports tickSpacing ${poolTickSpacing} but ${PANCAKE_DEX} maps it to ` +
          `${fromTable}; refusing to align a range against an inconsistent grid`,
        { feeTier, poolTickSpacing, fromTable },
      );
    }
    if (range.tickSpacing !== poolTickSpacing) {
      throw new ChainError(
        CHAIN_ERROR_CODES.INVALID_ARGUMENT,
        `range was planned on tickSpacing ${range.tickSpacing} but the pool's is ${poolTickSpacing}`,
        { planned: range.tickSpacing, poolTickSpacing },
      );
    }
    if (range.lowerTick >= range.upperTick) {
      throw new ChainError(
        CHAIN_ERROR_CODES.INVALID_ARGUMENT,
        `range [${range.lowerTick}, ${range.upperTick}] is empty or inverted`,
        { lowerTick: range.lowerTick, upperTick: range.upperTick },
      );
    }
    if (range.lowerTick % poolTickSpacing !== 0 || range.upperTick % poolTickSpacing !== 0) {
      throw new ChainError(
        CHAIN_ERROR_CODES.INVALID_ARGUMENT,
        `ticks [${range.lowerTick}, ${range.upperTick}] are not aligned to tickSpacing ` +
          `${poolTickSpacing}; the v3 pool would revert the mint`,
        { lowerTick: range.lowerTick, upperTick: range.upperTick, tickSpacing: poolTickSpacing },
      );
    }
  }

  /** The trade's two legs must be the pool's two legs; a third token means the wrong pool. */
  #assertPoolLegsMatchTokenPair(
    poolToken0: Address,
    poolToken1: Address,
    tokenIn: Address,
    tokenOut: Address,
  ): void {
    const legs: Readonly<Record<string, true>> = {
      [poolToken0.toLowerCase()]: true,
      [poolToken1.toLowerCase()]: true,
    };
    const inPool = legs[tokenIn.toLowerCase()] === true;
    const outPool = legs[tokenOut.toLowerCase()] === true;
    if (!inPool || !outPool || tokenIn.toLowerCase() === tokenOut.toLowerCase()) {
      throw new ChainError(
        CHAIN_ERROR_CODES.INVALID_ARGUMENT,
        `trade legs ${tokenIn}/${tokenOut} are not the two tokens of pool ${poolToken0}/${poolToken1}`,
        { poolToken0, poolToken1, tokenIn, tokenOut },
      );
    }
  }

  // -------------------------------------------------------------------------------------------
  // SDK bridging
  // -------------------------------------------------------------------------------------------

  #sdkToken(target: PoolTarget, address: Address): Token {
    const lower = address.toLowerCase();
    if (target.token0.address.toLowerCase() === lower) {
      return new Token(this.chainId, target.token0.address, target.token0.decimals, target.token0.symbol);
    }
    if (target.token1.address.toLowerCase() === lower) {
      return new Token(this.chainId, target.token1.address, target.token1.decimals, target.token1.symbol);
    }
    throw new ChainError(
      CHAIN_ERROR_CODES.INVALID_ARGUMENT,
      `${address} is not a leg of pool ${target.poolAddress}`,
      { poolAddress: target.poolAddress, address },
    );
  }

  #sdkPool(target: PoolTarget, state: PoolState): PancakePool {
    return new PancakePool(
      this.#sdkToken(target, target.token0.address),
      this.#sdkToken(target, target.token1.address),
      target.feeTier,
      state.sqrtPriceX96,
      state.liquidity,
      state.tick,
      // Mint amounts depend only on `sqrtRatioX96`; a tick-crossing provider is not needed, and its
      // absence is explicit rather than a silently empty tick list.
      new NoTickDataProvider(),
    );
  }

  /**
   * The SmartRouter's own `V3Pool` view of the pool. It must be built from the same on-chain state as
   * the position's pool, or the encoded swap and the encoded mint would disagree about the pool they
   * are acting on.
   */
  #sdkRoutePool(target: PoolTarget, state: PoolState, poolAddress: Address): V3Pool {
    return {
      type: PoolType.V3,
      address: poolAddress,
      token0: this.#sdkToken(target, target.token0.address),
      token1: this.#sdkToken(target, target.token1.address),
      fee: target.feeTier,
      liquidity: state.liquidity,
      sqrtRatioX96: state.sqrtPriceX96,
      tick: state.tick,
      // `slot0().feeProtocol` packs the two protocol-fee shares, and `PoolReader` does not surface the
      // packed word, so zero is used here. Measured, not assumed: `swapAndAddCallParameters` produces
      // byte-identical calldata for a zero and for a non-zero share (it feeds only the router's
      // mid-price maths, never an encoded parameter), so this cannot change what is signed. Wiring the
      // real shares is listed as an open item in the report.
      token0ProtocolFee: new Percent(0, 1),
      token1ProtocolFee: new Percent(0, 1),
    };
  }

  #ratioToPercent(ratio: number): Percent {
    if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
      throw new ChainError(
        CHAIN_ERROR_CODES.INVALID_ARGUMENT,
        `slippage tolerance ${String(ratio)} is not a ratio in [0, 1]`,
        { ratio },
      );
    }
    return new Percent(BigInt(Math.round(ratio * Number(RATIO_SCALE))), RATIO_SCALE);
  }

  // -------------------------------------------------------------------------------------------
  // Misc
  // -------------------------------------------------------------------------------------------

  #contracts(): DexContracts {
    const contracts = BSC_DEX_CONTRACTS[PANCAKE_DEX];
    if (contracts === undefined) {
      throw new ChainError(
        CHAIN_ERROR_CODES.DEX_NOT_WHITELISTED,
        `no deployed contract set for ${PANCAKE_DEX} on chain ${this.chainId}`,
        { dex: PANCAKE_DEX },
      );
    }
    return contracts;
  }

  #smartRouterAddress(): Address {
    const address = SMART_ROUTER_ADDRESSES[this.chainId as keyof typeof SMART_ROUTER_ADDRESSES];
    if (address === undefined || address === '0x') {
      throw new ChainError(
        CHAIN_ERROR_CODES.INVALID_ARGUMENT,
        `no Pancake SmartRouter deployment is known for chain ${this.chainId}; the §42 atomic build ` +
          'cannot be encoded (refusing to guess an address)',
        { chainId: this.chainId },
      );
    }
    return getAddress(address);
  }

  /** §13 identity → address. The pool id is `${chainId}:${dex}:${poolAddress}`. */
  #poolAddressFromId(poolId: string): Address {
    const parts = poolId.split(':');
    const [chainPart, dexPart, addressPart] = parts;
    if (
      parts.length !== 3 ||
      chainPart === undefined ||
      dexPart === undefined ||
      addressPart === undefined
    ) {
      throw new ChainError(
        CHAIN_ERROR_CODES.INVALID_ARGUMENT,
        `poolId ${poolId} is not "<chainId>:<dex>:<poolAddress>"`,
        { poolId },
      );
    }
    if (Number(chainPart) !== this.chainId) {
      throw new ChainError(
        CHAIN_ERROR_CODES.INVALID_ARGUMENT,
        `poolId ${poolId} is for chain ${chainPart}, but this adapter is bound to ${this.chainId}`,
        { poolId },
      );
    }
    if (dexPart !== PANCAKE_DEX) {
      throw new ChainError(
        CHAIN_ERROR_CODES.DEX_NOT_WHITELISTED,
        `poolId ${poolId} is for DEX "${dexPart}", but this adapter serves ${PANCAKE_DEX}`,
        { poolId, dex: dexPart },
      );
    }
    return getAddress(addressPart);
  }

  /**
   * USD notional of the input leg, using the pool price and the whitelisted stablecoin leg as the unit
   * of account (the same assumption `positionPlanner.resolveUsdPrices` makes). When neither leg is a
   * whitelisted stablecoin there is no reference price to divide by, so the value is refused rather
   * than approximated — a fabricated notional would silently pass a USD-denominated limit.
   */
  #usdValueOfInput(input: {
    readonly target: PoolTarget;
    readonly tokenInIsToken0: boolean;
    readonly amountInRaw: bigint;
    readonly decimalsIn: number;
    readonly priceToken1PerToken0: number;
  }): number {
    const { target } = input;
    const stable0 = target.token0.kind === TOKEN_KINDS.STABLECOIN;
    const stable1 = target.token1.kind === TOKEN_KINDS.STABLECOIN;
    const mid = input.priceToken1PerToken0;
    let priceInUsd: number;
    if (stable1 && !stable0) {
      priceInUsd = input.tokenInIsToken0 ? mid : 1;
    } else if (stable0 && !stable1) {
      priceInUsd = input.tokenInIsToken0 ? 1 : 1 / mid;
    } else {
      throw new ChainError(
        CHAIN_ERROR_CODES.INVALID_ARGUMENT,
        `cannot value ${input.amountInRaw.toString()} raw ${target.token0.symbol}/` +
          `${target.token1.symbol} in USD: neither leg is a whitelisted stablecoin and no reference ` +
          'price is available to this adapter',
        { poolId: target.poolId },
      );
    }
    return toFloat(input.amountInRaw, input.decimalsIn) * priceInUsd;
  }

  /** §93: USDT needs `zero-then-max` (approve-from-nonzero reverts); everything else exact. */
  #requiredApprovalType(tokenIn: Address): ApprovalType {
    return ZERO_THEN_MAX_TOKENS[tokenIn.toLowerCase()] === true
      ? APPROVAL_TYPES.ZERO_THEN_MAX
      : APPROVAL_TYPES.EXACT;
  }

  /** The SDK's `IApproveAndCall.ApprovalType` for the router→NPM approval of one leg. */
  #sdkApprovalType(token: Address): number {
    return ZERO_THEN_MAX_TOKENS[token.toLowerCase()] === true
      ? SDK_APPROVAL_ZERO_THEN_MAX
      : SDK_APPROVAL_MAX;
  }

  /** §81: the only write path in the system, always through the injected chain layer. */
  async #send(to: Address, data: Hex, value: bigint, guard: TxGuardChecks): Promise<Hash> {
    return this.#chain.sendTransaction({ to, data, value, guard });
  }
}

/** The revert payload a viem error carries, when there is one. Separated so it logs as a short field. */
function revertDataOf(error: unknown): string {
  const carrier = error as { readonly data?: unknown; readonly cause?: { readonly data?: unknown } };
  const data = carrier.data ?? carrier.cause?.data;
  return typeof data === 'string' ? data : 'none';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** §82 factory: build the Pancake adapter from runtime options. */
export function createPancakeV3Adapter(options: DexAdapterFactoryOptions): PancakeV3Adapter {
  return new PancakeV3Adapter(options);
}
