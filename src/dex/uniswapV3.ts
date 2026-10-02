/**
 * §82/§42 Uniswap V3 adapter for BNB Chain — viem calldata only, no Uniswap SDK.
 *
 * ## Why there is no `@uniswap/v3-sdk` here (research §5)
 * The other whitelisted venue uses `@pancakeswap/v3-sdk`, which pins `viem` and ships a `FeeAmount`
 * enum that overlaps Uniswap's numerically but not semantically (Pancake deploys 2500/50-spacing,
 * Uniswap deploys 3000/60-spacing). Passing one venue's fee into the other's lookup silently selects
 * the *wrong pool* for the right token pair. So the two adapters deliberately share **no** module:
 * this file builds every call with `viem.encodeFunctionData` against the official BSC addresses in
 * `config/builtins.ts` and takes the fee→tickSpacing grid from `src/dex/index.ts` (`tickSpacingFor`),
 * which is keyed by DEX id and throws for a tier this DEX does not deploy.
 *
 * ## What this adapter can and cannot do
 * - **Cannot** combine a swap with a mint (§42). `SwapRouter02` has no add-liquidity entry point,
 *   and `NonfungiblePositionManager.multicall` is a **self**-delegatecall into that contract's own
 *   selectors (`address(this).delegatecall`, v3-periphery `base/Multicall.sol`) — it can neither swap
 *   nor reach the router. Only a router that custodies the swap output and then calls the position
 *   manager (PancakeSwap's SmartRouter) can do it in one transaction. Hence
 *   `supportsAtomicBuild === false`, and `addLiquidity` **throws** when `swapForDeficit` is passed
 *   rather than quietly returning to a two-transaction build that the caller never approved.
 * - **Cannot** express the `previousBlockhash` deadline variant on position-manager calls: the
 *   deployed NPM exposes only `multicall(bytes[])`, not `MulticallExtended`'s
 *   `multicall(bytes32,bytes[])`. `SwapRouter02` *does* expose both (verified against the deployed
 *   bytecode: `0x1f0464d1`/`0x5ae401dc` on the router, absent on the NPM). A `previousBlockhash`
 *   deadline is therefore refused on `addLiquidity`/`removeLiquidity` — substituting a local-clock
 *   timestamp would defeat the whole point of the variant.
 * - **Sends nothing else.** The only write path is `BscChainAdapter.sendTransaction`; every write
 *   method re-runs the §95 guard as its first step and never broadcasts `value` (the interface
 *   carries token addresses only — WBNB is swapped as an ERC-20, native BNB legs are not expressible).
 *
 * ## Units (UNITAGREEMENT)
 * Every amount crossing `DexAdapter` is RAW base units. No UI scaling happens here: BEP-677
 * `uiMultiplier` conversion lives in `src/chain/tokenReader.ts`, so this file cannot sign a UI amount.
 */
import { encodeFunctionData, getAddress } from 'viem';
import { BscChainAdapter } from '../chain/adapter.ts';
import { ERC20_ABI, POSITION_MANAGER_ABI } from '../chain/abis.ts';
import { ChainError, CHAIN_ERROR_CODES } from '../chain/errors.ts';
import { MAX_TICK, MIN_TICK, PoolReader } from '../chain/poolReader.ts';
import { PositionReader } from '../chain/positionReader.ts';
import { assertTxGuard } from '../chain/txState.ts';
import { BSC_ADDRESSES, BSC_DEX_CONTRACTS, type DexContracts } from '../config/builtins.ts';
import { tickSpacingFor } from './index.ts';
import { applyFloorRatio, toFloat } from '../util/decimal.ts';
import { computePriceImpact } from '../strategy/swapPlanner.ts';
import type {
  AddLiquidityRequest,
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
} from '../types/adapters.ts';
import { TX_STATES, type TxGuardChecks } from '../types/adapters.ts';
import { DEX_IDS, TOKEN_KINDS, type Address, type ChainId, type FeeTier, type Hash, type Hex, type PoolId, type Ratio, type Tick } from '../types/primitives.ts';
import type { Whitelist } from '../types/registry.ts';
import type { TokenMeta } from '../types/token.ts';

/** The DEX id this adapter speaks for; a literal so it can never be parameterised by mistake. */
const UNISWAP_V3 = DEX_IDS.UNISWAP_V3;

/**
 * QuoterV2 `quoteExactInputSingle`. `nonpayable` on chain and quoted via `eth_call` only — the
 * QuoterV2 is *not* a view function (it reverts its own state to return the amount), so this is a
 * read at the RPC level and never a transaction.
 *
 * Declared here rather than imported from `src/chain/abis.ts` (which is the read layer's ABI home and
 * only declares `view` fragments) so the adapter stays self-contained: the sibling Pancake adapter
 * must not share a module with this one (research §5).
 */
export const UNISWAP_V3_QUOTER_V2_ABI = [
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

/** `SwapRouter02.exactInputSingle`. Carries no deadline; see the two `multicall` fragments below. */
export const UNISWAP_V3_SWAP_ROUTER_ABI = [
  {
    type: 'function',
    name: 'exactInputSingle',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'recipient', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
] as const;

/**
 * The two deadline forms, as **separate** ABI fragments.
 *
 * They are deliberately not one array: `multicall` is overloaded, and a single fragment list would
 * rely on viem's overload resolution to pick between `multicall(uint256,bytes[])` and
 * `multicall(bytes32,bytes[])` — which is exactly the kind of silent selection this codebase avoids.
 * One fragment per form makes the intent explicit and the selector provable
 * (`0x5ae401dc` / `0x1f0464d1`, both present on the deployed BSC router).
 */
export const UNISWAP_V3_ROUTER_MULTICALL_DEADLINE_ABI = [
  {
    type: 'function',
    name: 'multicall',
    stateMutability: 'payable',
    inputs: [
      { name: 'deadline', type: 'uint256' },
      { name: 'data', type: 'bytes[]' },
    ],
    outputs: [{ type: 'bytes[]' }],
  },
] as const;

/** `previousBlockhash` variant — robot-preferred because it is immune to local clock drift (§42). */
export const UNISWAP_V3_ROUTER_MULTICALL_BLOCKHASH_ABI = [
  {
    type: 'function',
    name: 'multicall',
    stateMutability: 'payable',
    inputs: [
      { name: 'previousBlockhash', type: 'bytes32' },
      { name: 'data', type: 'bytes[]' },
    ],
    outputs: [{ type: 'bytes[]' }],
  },
] as const;

/**
 * `NonfungiblePositionManager` write surface.
 *
 * `mint`/`decreaseLiquidity`/`collect` are the reachable calls. `increaseLiquidity` is deliberately
 * absent: `AddLiquidityRequest` carries no `positionTokenId`, so there is no way to name the position
 * to top up, and declaring a fragment that nothing can reach would be dead surface.
 */
export const UNISWAP_V3_POSITION_MANAGER_ABI = [
  {
    type: 'function',
    name: 'mint',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'token0', type: 'address' },
          { name: 'token1', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'tickLower', type: 'int24' },
          { name: 'tickUpper', type: 'int24' },
          { name: 'amount0Desired', type: 'uint256' },
          { name: 'amount1Desired', type: 'uint256' },
          { name: 'amount0Min', type: 'uint256' },
          { name: 'amount1Min', type: 'uint256' },
          { name: 'recipient', type: 'address' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
    ],
    outputs: [
      { name: 'tokenId', type: 'uint256' },
      { name: 'liquidity', type: 'uint128' },
      { name: 'amount0', type: 'uint256' },
      { name: 'amount1', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'decreaseLiquidity',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenId', type: 'uint256' },
          { name: 'liquidity', type: 'uint128' },
          { name: 'amount0Min', type: 'uint256' },
          { name: 'amount1Min', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
    ],
    outputs: [
      { name: 'amount0', type: 'uint256' },
      { name: 'amount1', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'collect',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenId', type: 'uint256' },
          { name: 'recipient', type: 'address' },
          { name: 'amount0Max', type: 'uint128' },
          { name: 'amount1Max', type: 'uint128' },
        ],
      },
    ],
    outputs: [
      { name: 'amount0', type: 'uint256' },
      { name: 'amount1', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'burn',
    stateMutability: 'payable',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'multicall',
    stateMutability: 'payable',
    inputs: [{ name: 'data', type: 'bytes[]' }],
    outputs: [{ name: 'results', type: 'bytes[]' }],
  },
] as const;

/**
 * §40 `max_slippage` from `config/strategy.yaml` (schema default `0.003`).
 *
 * `SwapQuoteRequest` carries no tolerance, but `SwapQuote.slippageTolerance` is required, so the
 * adapter owns a default rather than leaving the field to a caller who might not set one. It is the
 * baseline §40 value, which `evaluateSwapQuote` accepts (`> maxSlippage` fails, `==` passes), so
 * quoting can never be *more* permissive than the configured gate. Overridable per adapter.
 */
export const DEFAULT_SLIPPAGE_TOLERANCE = 0.003;

/** BSC USDT refuses a non-zero → non-zero `approve`; such tokens must be cleared first (§93). */
const ZERO_THEN_MAX_TOKENS: Readonly<Record<string, true>> = {
  [BSC_ADDRESSES.USDT.toLowerCase()]: true,
};

const MAX_UINT256 = 2n ** 256n - 1n;

/** `keccak256("IncreaseLiquidity(uint256,uint128,uint256,uint256)")` — the NPM mint's own event. */
const INCREASE_LIQUIDITY_EVENT_TOPIC =
  '0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f' as const;

/** `type(uint128).max` — "collect everything the position is owed" for `collect`. */
export const MAX_UINT128 = (1n << 128n) - 1n;

/**
 * §13 pool identity → pool address, with the identity **checked** against this adapter.
 *
 * A `PoolId` is `chainId:dex:poolAddress`. Refusing a mismatched chain or DEX here is what stops a
 * Pancake `poolId` from being routed through the Uniswap adapter (or vice versa) and signing a swap
 * against the wrong pool's fee tier — the §13 failure mode, where both keys look plausible.
 */
export function addressFromPoolId(poolId: PoolId, chainId: ChainId, dex: string): Address {
  const parts = poolId.split(':');
  const [chainRaw, dexRaw, addressRaw] = parts;
  if (parts.length !== 3 || chainRaw === undefined || dexRaw === undefined || addressRaw === undefined) {
    throw new ChainError(
      CHAIN_ERROR_CODES.INVALID_ARGUMENT,
      `pool id is not "chainId:dex:poolAddress": ${poolId}`,
      { poolId },
    );
  }
  if (Number(chainRaw) !== chainId) {
    throw new ChainError(
      CHAIN_ERROR_CODES.INVALID_ARGUMENT,
      `pool id ${poolId} is for chain ${chainRaw}, but this adapter is bound to chain ${chainId}`,
      { poolId, chainId },
    );
  }
  if (dexRaw !== dex) {
    throw new ChainError(
      CHAIN_ERROR_CODES.INVALID_ARGUMENT,
      `pool id ${poolId} belongs to DEX "${dexRaw}"; refusing to route it through the "${dex}" ` +
        'adapter (§13: a pool id names one pool on one DEX)',
      { poolId, dex },
    );
  }
  try {
    return getAddress(addressRaw);
  } catch {
    throw new ChainError(
      CHAIN_ERROR_CODES.INVALID_ARGUMENT,
      `pool id ${poolId} does not contain a valid address: ${addressRaw}`,
      { poolId },
    );
  }
}

export interface UniswapV3AdapterOptions {
  readonly chainId: ChainId;
  readonly whitelist: Whitelist;
  /** The chain layer; the only component allowed to touch an RPC (`src/chain/**`). */
  readonly chain: BscChainAdapter;
  /** §40 slippage used to derive `amountOutMinimumRaw`; defaults to the baseline 0.003. */
  readonly slippageTolerance?: Ratio;
  /** Injected clock so quote lifetimes are reproducible in tests (§77). */
  readonly now?: () => Date;
}

/**
 * §82 Uniswap V3 adapter. Construct through `createDexAdapter` (which runs the whitelist gate) or the
 * `createUniswapV3Adapter` factory below.
 */
export class UniswapV3Adapter implements DexAdapter {
  readonly dex = UNISWAP_V3;
  readonly chainId: ChainId;

  /**
   * §42 capability of the **deployed** contracts. Static, not a runtime query: the deployed
   * `SwapRouter02` cannot swap and mint in one transaction (see the file header), so a build on this
   * venue is necessarily swap-then-add across two transactions.
   */
  readonly supportsAtomicBuild = false;

  private readonly whitelist: Whitelist;
  private readonly chain: BscChainAdapter;
  private readonly contracts: DexContracts;
  private readonly poolReader: PoolReader;
  private readonly positionReader: PositionReader;
  private readonly slippageTolerance: Ratio;
  private readonly now: () => Date;

  constructor(options: UniswapV3AdapterOptions) {
    // §11: a mismatched chain binding would let a quote or a send name the wrong network.
    options.whitelist.assertWhitelistedChain(options.chainId);
    if (options.chain.chainId !== options.chainId) {
      throw new ChainError(
        CHAIN_ERROR_CODES.INVALID_ARGUMENT,
        `chain adapter is bound to chain ${options.chain.chainId} but this DEX adapter is bound to ` +
          `${options.chainId}; refusing to construct a mismatched pair`,
        { adapterChainId: options.chainId, chainChainId: options.chain.chainId },
      );
    }
    const contracts = BSC_DEX_CONTRACTS[UNISWAP_V3];
    if (contracts === undefined) {
      throw new ChainError(
        CHAIN_ERROR_CODES.DEX_NOT_WHITELISTED,
        `no contract set for DEX ${UNISWAP_V3} on chain ${options.chainId}`,
        { dex: UNISWAP_V3, chainId: options.chainId },
      );
    }
    const slippage = options.slippageTolerance ?? DEFAULT_SLIPPAGE_TOLERANCE;
    if (!Number.isFinite(slippage) || slippage < 0 || slippage >= 1) {
      throw new ChainError(
        CHAIN_ERROR_CODES.INVALID_ARGUMENT,
        `unusable slippage tolerance: ${String(slippage)} (expected 0 <= t < 1)`,
        { slippageTolerance: String(slippage) },
      );
    }

    this.chainId = options.chainId;
    this.whitelist = options.whitelist;
    this.chain = options.chain;
    this.contracts = contracts;
    this.poolReader = new PoolReader(options.chain, options.whitelist.registry, options.chainId);
    this.positionReader = new PositionReader(options.chain, options.chainId);
    this.slippageTolerance = slippage;
    this.now = options.now ?? (() => new Date());
  }

  /** §12 DEX whitelist check. `createDexAdapter` calls this before handing the adapter out. */
  assertWhitelisted(): void {
    this.whitelist.assertWhitelistedChain(this.chainId);
    this.whitelist.assertWhitelistedDex(this.chainId, UNISWAP_V3);
  }

  // -----------------------------------------------------------------------------------------------
  // Read paths — all of them delegate to `src/chain/**`, which is DEX-agnostic (no SDK dependency).
  // -----------------------------------------------------------------------------------------------

  /**
   * `factory.getPool(tokenA, tokenB, fee)` → a pool reference, or `null` for a **proven** absence
   * (the zero address). A thrown factory call is not an absence and propagates.
   *
   * The fee tier is validated against this DEX's own table *before* the probe, so a Pancake-only tier
   * (2500) can never be probed as if it were a Uniswap pool. The returned grid is the pool's own
   * `tickSpacing()`, cross-checked against the DEX table: a disagreement means one of the two layers
   * has the wrong (DEX, fee) pairing, which is exactly the silent wrong-pool failure mode (§34).
   */
  async getPool(token0: Address, token1: Address, feeTier: FeeTier): Promise<PoolRefView | null> {
    const expectedSpacing = tickSpacingFor(UNISWAP_V3, feeTier);
    const poolAddress = await this.chain.getPoolAddress(UNISWAP_V3, token0, token1, feeTier);
    if (poolAddress === null) return null;

    const target = await this.poolReader.resolvePool(poolAddress, UNISWAP_V3);
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
          `${UNISWAP_V3} maps that fee to ${expectedSpacing}; refusing to plan on the wrong grid`,
        { poolAddress, fee: feeTier, onChainTickSpacing: target.tickSpacing, expectedSpacing },
      );
    }

    return {
      chainId: this.chainId,
      dex: UNISWAP_V3,
      poolAddress: target.poolAddress,
      poolId: target.poolId,
      token0: getAddress(target.token0.address),
      token1: getAddress(target.token1.address),
      feeTier: target.feeTier,
      tickSpacing: target.tickSpacing,
    };
  }

  /**
   * Full pool state (`slot0` + `liquidity` + `fee` + `tickSpacing` + verified token order).
   *
   * `priceUsd` is left absent on purpose: this layer has no reference-price provider, and inventing a
   * USD figure here would silently misprice everything downstream (§96).
   */
  async getPoolPrice(poolAddress: Address): Promise<PoolPriceView> {
    const target = await this.poolReader.resolvePool(poolAddress, UNISWAP_V3);
    // `readPool` already returns a `PoolPriceView` (plus provenance); returning it directly avoids
    // copying the same nine fields into an identical object.
    return this.poolReader.readPool(target);
  }

  /** §108 "Active Liquidity": the in-range `L`, not a USD TVL. */
  async getLiquidity(poolAddress: Address): Promise<bigint> {
    return (await this.poolReader.readActiveLiquidity(poolAddress)).value;
  }

  /** `slot0().tick` — the current tick of the pool. */
  async getTick(poolAddress: Address): Promise<Tick> {
    return (await this.poolReader.readSlot0(poolAddress)).tick;
  }

  /**
   * §108 "read LP Position": `positions(tokenId)` from this DEX's own position manager.
   *
   * `null` means "no such position" (the manager's `positions()` reverted for that id). The `poolId`
   * is derived from the position's own `(token0, token1, fee)` through the factory — never guessed
   * from the caller's arguments — and a position whose pool the factory does not know is an error
   * rather than a fabricated id (§13).
   */
  async getPosition(tokenId: bigint): Promise<LpPositionView | null> {
    const positionManager = this.positionReader.positionManagerFor(UNISWAP_V3);
    const raw = await this.positionReader.readRawPosition(positionManager, tokenId);
    if (raw === null) return null;

    // A fee tier this DEX does not deploy means the tokenId belongs to another venue's manager.
    tickSpacingFor(UNISWAP_V3, raw.fee);

    const poolAddress = await this.chain.getPoolAddress(UNISWAP_V3, raw.token0, raw.token1, raw.fee);
    if (poolAddress === null) {
      throw new ChainError(
        CHAIN_ERROR_CODES.DECODE_FAILED,
        `position ${tokenId} references pool (token0=${raw.token0}, token1=${raw.token1}, ` +
          `fee=${raw.fee}), which the factory reports as absent; refusing to report it with a ` +
          'fabricated poolId (§13)',
        { tokenId: tokenId.toString(), token0: raw.token0, token1: raw.token1, fee: raw.fee },
      );
    }
    const owner = await this.chain.readContract<Address>({
      address: positionManager,
      abi: POSITION_MANAGER_ABI,
      functionName: 'ownerOf',
      args: [tokenId],
    });

    return {
      poolId: `${this.chainId}:${UNISWAP_V3}:${poolAddress.toLowerCase()}`,
      positionTokenId: tokenId,
      owner: getAddress(owner.value),
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

  // -----------------------------------------------------------------------------------------------
  // Quote
  // -----------------------------------------------------------------------------------------------

  /**
   * §39/§40 quote: QuoterV2 `quoteExactInputSingle` + a **locally computed** price impact.
   *
   * The impact is not something the quoter (or any Uniswap SDK call) can bound for us (research §4.2),
   * so it is derived here with the planner's `computePriceImpact` from the pool mid price and the
   * executed rate, in the pool's own token orientation. The gate itself is the executor's job:
   * `evaluateSwapQuote` is not called here because a quote is data, and refusing to *produce* data
   * would hide the reason from the §40 report.
   */
  async quoteSwap(request: SwapQuoteRequest): Promise<SwapQuote> {
    const poolAddress = addressFromPoolId(request.poolId, this.chainId, UNISWAP_V3);
    const target = await this.poolReader.resolvePool(poolAddress, UNISWAP_V3);
    const pool = await this.poolReader.readPool(target);

    // The fee the calldata will carry is the pool's own, and it must be a tier this DEX deploys:
    // a Pancake 2500 pool reached through this adapter would otherwise be quoted as Uniswap.
    const feeTier = pool.feeTier;
    tickSpacingFor(UNISWAP_V3, feeTier);

    const tokenIn = this.legOf(target, request.tokenIn, 'tokenIn');
    const tokenOut = this.legOf(target, request.tokenOut, 'tokenOut');
    if (tokenIn.address.toLowerCase() === tokenOut.address.toLowerCase()) {
      throw new ChainError(
        CHAIN_ERROR_CODES.INVALID_ARGUMENT,
        `tokenIn and tokenOut are the same token (${tokenIn.address}); refusing to quote a self-swap`,
        { poolId: request.poolId, token: tokenIn.address },
      );
    }
    if (request.amountIn <= 0n) {
      throw new ChainError(
        CHAIN_ERROR_CODES.INVALID_ARGUMENT,
        `quoteSwap requires a positive RAW amountIn, got ${request.amountIn.toString()}`,
        { poolId: request.poolId, amountIn: request.amountIn.toString() },
      );
    }
    const ttlSeconds = request.ttlSeconds;
    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
      // §41: a non-positive TTL would produce an `expiresAt` that is already in the past, i.e. a
      // quote `evaluateSwapQuote` must reject. Refuse it here so no unusable quote is ever produced.
      throw new ChainError(
        CHAIN_ERROR_CODES.INVALID_ARGUMENT,
        `ttlSeconds must be a positive integer, got ${String(ttlSeconds)}`,
        { poolId: request.poolId, ttlSeconds: String(ttlSeconds) },
      );
    }

    const amountOutRaw = await this.quoteExactInputSingle({
      tokenIn: tokenIn.address,
      tokenOut: tokenOut.address,
      amountIn: request.amountIn,
      feeTier,
    });
    if (amountOutRaw <= 0n) {
      // A zero-output quote cannot support the mandatory §40 impact computation
      // (`computePriceImpact` refuses non-positive amounts), so there is no honest number to return.
      // Better a hard failure than a quote whose `priceImpact` we cannot compute.
      throw new ChainError(
        CHAIN_ERROR_CODES.DECODE_FAILED,
        `QuoterV2 returned amountOut=0 for ${request.amountIn.toString()} of ${tokenIn.symbol} in ` +
          `${pool.poolId}; no §40 price impact can be computed, refusing to fabricate one`,
        { poolId: pool.poolId, amountIn: request.amountIn.toString() },
      );
    }

    const priceImpact = computePriceImpact({
      pool,
      tokenIn: tokenIn.address,
      tokenOut: tokenOut.address,
      amountInRaw: request.amountIn,
      amountOutRaw,
      tokenInDecimals: tokenIn.decimals,
      tokenOutDecimals: tokenOut.decimals,
      poolToken0: pool.token0,
    });

    const quotedAt = this.now();
    return {
      poolId: pool.poolId,
      tokenIn: tokenIn.address,
      tokenOut: tokenOut.address,
      amountInRaw: request.amountIn,
      amountOutRaw,
      amountInUsd: this.notionalUsd(tokenIn, tokenOut, request.amountIn, amountOutRaw),
      priceImpact,
      slippageTolerance: this.slippageTolerance,
      amountOutMinimumRaw: applyFloorRatio(amountOutRaw, 1 - this.slippageTolerance),
      quotedAt: quotedAt.toISOString(),
      expiresAt: new Date(quotedAt.getTime() + ttlSeconds * 1000).toISOString(),
      route: [`${tokenIn.symbol}/${tokenOut.symbol} ${feePercent(feeTier)}%`],
    };
  }

  /** `QuoterV2.quoteExactInputSingle` over `eth_call`. RAW in, RAW out. */
  private async quoteExactInputSingle(params: {
    readonly tokenIn: Address;
    readonly tokenOut: Address;
    readonly amountIn: bigint;
    readonly feeTier: FeeTier;
  }): Promise<bigint> {
    const result = await this.chain.readContract<readonly [bigint, bigint, number, bigint]>({
      address: this.contracts.quoterV2,
      abi: UNISWAP_V3_QUOTER_V2_ABI as unknown as readonly unknown[],
      functionName: 'quoteExactInputSingle',
      args: [
        {
          tokenIn: params.tokenIn,
          tokenOut: params.tokenOut,
          amountIn: params.amountIn,
          fee: params.feeTier,
          // 0 = "no price limit", the standard sentinel; a limit here would be a §40 decision this
          // layer is not allowed to make.
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    return result.value[0];
  }

  // -----------------------------------------------------------------------------------------------
  // Writes. §95 first: a guard that is not `ok` stops the call before any encoding or send.
  // -----------------------------------------------------------------------------------------------

  /**
   * §39 SwapRouter02 `exactInputSingle`, wrapped in the router's deadline `multicall` (the swap
   * fragment itself carries no deadline).
   *
   * The recipient is the attached signer: `SwapExecutionRequest` has no recipient field, and the only
   * address this adapter can honestly name is the one the chain layer will sign with. With no signer
   * attached the call refuses — it could not be broadcast anyway, and it must not name someone else.
   */
  async getTokenBalance(token: Address, holder: Address): Promise<bigint> {
    return this.chain.getTokenBalanceOf(token, holder);
  }

  /**
   * Ensure `spender` may move at least `required` of `token`, approving exactly that much (§93: exact is
   * the default; a router pulls the precise input, the operator can revoke at will, and re-granting on a
   * later build is one cheap transaction). BSC USDT refuses a non-zero → non-zero change, so such tokens
   * are cleared first.
   *
   * Each approval is waited for (§5.3.5) before the next transaction runs — an allowance still pending is
   * the same `STF` revert as no allowance at all.
   */
  async ensureAllowance(
    token: Address,
    spender: Address,
    required: bigint,
    guard: TxGuardChecks,
  ): Promise<void> {
    const owner = this.requireSigner('approve');
    const current = await this.chain.getAllowance(token, owner, spender);
    if (current >= required) return;

    if (ZERO_THEN_MAX_TOKENS[token.toLowerCase()] === true && current > 0n) {
      const zeroed = await this.chain.sendTransaction({
        to: token,
        data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [spender, 0n] }),
        value: 0n,
        guard,
      });
      await this.awaitMined(zeroed, 'approve(0)');
    }
    const granted = await this.chain.sendTransaction({
      to: token,
      data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [spender, MAX_UINT256] }),
      value: 0n,
      guard,
    });
    await this.awaitMined(granted, 'approve(max)');
  }

  async awaitMined(hash: Hash, what: string): Promise<void> {
    const info = await this.chain.waitForTransaction(hash);
    if (info.state !== TX_STATES.CONFIRMED) {
      throw new ChainError(
        CHAIN_ERROR_CODES.TX_GUARD_FAILED,
        `${what} did not succeed on chain (${info.state}, hash ${hash}); refusing to continue`,
        { hash, state: info.state },
      );
    }
  }

  async executeSwap(request: SwapExecutionRequest): Promise<SwapExecutionResult> {
    assertTxGuard(request.guard, { to: this.contracts.swapRouter });

    const quote = request.quote;
    const recipient = this.requireSigner('executeSwap');
    // An unbounded swap must never be signed. A zero `amountOutMinimum` would accept any output —
    // exactly what the §40 slippage bound exists to prevent — and the §95 guard checks the
    // *tolerance* value, not the bound derived from it, so the encoding is validated here.
    if (quote.amountInRaw <= 0n) {
      throw new ChainError(
        CHAIN_ERROR_CODES.INVALID_ARGUMENT,
        `executeSwap requires a positive quote.amountInRaw, got ${quote.amountInRaw.toString()}`,
        { poolId: quote.poolId },
      );
    }
    if (quote.amountOutMinimumRaw <= 0n) {
      throw new ChainError(
        CHAIN_ERROR_CODES.INVALID_ARGUMENT,
        `executeSwap refuses a quote whose amountOutMinimumRaw is ${quote.amountOutMinimumRaw.toString()}: ` +
          'a non-positive floor accepts any output, which is the unbounded swap §40 slippage exists ' +
          'to prevent',
        { poolId: quote.poolId, amountOutMinimumRaw: quote.amountOutMinimumRaw.toString() },
      );
    }
    if (quote.amountOutMinimumRaw > quote.amountOutRaw) {
      throw new ChainError(
        CHAIN_ERROR_CODES.INVALID_ARGUMENT,
        `executeSwap refuses a quote whose amountOutMinimumRaw (${quote.amountOutMinimumRaw.toString()}) ` +
          `exceeds its amountOutRaw (${quote.amountOutRaw.toString()}): the swap would revert`,
        { poolId: quote.poolId },
      );
    }
    const poolAddress = addressFromPoolId(quote.poolId, this.chainId, UNISWAP_V3);
    const target = await this.poolReader.resolvePool(poolAddress, UNISWAP_V3);
    // Route against the pool the quote names, verified by the pool's own token order.
    this.legOf(target, quote.tokenIn, 'quote.tokenIn');
    this.legOf(target, quote.tokenOut, 'quote.tokenOut');
    tickSpacingFor(UNISWAP_V3, target.feeTier);

    const inner = encodeFunctionData({
      abi: UNISWAP_V3_SWAP_ROUTER_ABI,
      functionName: 'exactInputSingle',
      args: [
        {
          tokenIn: quote.tokenIn,
          tokenOut: quote.tokenOut,
          fee: target.feeTier,
          recipient,
          amountIn: quote.amountInRaw,
          // The bound that will be signed is the quote's own floor, computed by `quoteSwap` from the
          // §40 tolerance; it is never widened here.
          amountOutMinimum: quote.amountOutMinimumRaw,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });

    const data = this.routerMulticall(request.deadline, inner, 'executeSwap');
    // The swap does a `transferFrom` of `amountInRaw` — without an allowance its only outcome is `STF`
    // (measured live, 2026-10-02).
    await this.ensureAllowance(quote.tokenIn, this.contracts.swapRouter, quote.amountInRaw, request.guard);
    const txHash = await this.chain.sendTransaction({
      to: this.contracts.swapRouter,
      data,
      // Token legs only: the interface names tokens, never the native currency, so no call may carry
      // value. WBNB is swapped as an ERC-20.
      value: 0n,
      guard: request.guard,
    });

    // §5.3.5: the swap's outcome must be a settled fact before the caller reads any balance — the
    // executor sizes the mint from exactly this balance.
    const info = await this.chain.waitForTransaction(txHash);
    if (info.state !== TX_STATES.CONFIRMED) {
      throw new ChainError(
        CHAIN_ERROR_CODES.TX_GUARD_FAILED,
        `swap did not succeed on chain (${info.state}, hash ${txHash}); refusing to continue`,
        { poolId: quote.poolId },
      );
    }
    return {
      txHash,
      state: TX_STATES.CONFIRMED,
      amountInRaw: quote.amountInRaw,
      amountOutRaw: quote.amountOutRaw,
    };
  }

  /**
   * §33-§38 `NonfungiblePositionManager.mint`. The amounts are the executor's, read from the wallet
   * after the funding swap landed (§5.3.3/D3.7). The mint is confirmed on chain and the minted
   * `tokenId` is parsed from the receipt's `IncreaseLiquidity` log.
   */
  async addLiquidity(request: AddLiquidityRequest): Promise<LiquidityExecutionResult> {
    // §95 first, before anything is encoded or sent — and before any read, so a failed guard costs
    // no RPC and cannot depend on chain state.
    assertTxGuard(request.guard, { to: this.contracts.positionManager });

    const poolAddress = addressFromPoolId(request.poolId, this.chainId, UNISWAP_V3);
    const target = await this.poolReader.resolvePool(poolAddress, UNISWAP_V3);
    const tickSpacing = tickSpacingFor(UNISWAP_V3, target.feeTier);
    this.assertRangeOnGrid(request.tickRange, tickSpacing);

    if (request.amount0DesiredRaw === 0n && request.amount1DesiredRaw === 0n) {
      throw new ChainError(
        CHAIN_ERROR_CODES.INVALID_ARGUMENT,
        `addLiquidity for ${request.poolId} has zero desired amounts on both legs; that would mint ` +
          'no liquidity and revert (ZERO_LIQUIDITY)',
        { poolId: request.poolId },
      );
    }

    const deadline = this.positionManagerDeadline(request.deadline, 'addLiquidity');
    assertNotZeroAddress(request.recipient, 'addLiquidity', 'recipient');
    const data = encodeFunctionData({
      abi: UNISWAP_V3_POSITION_MANAGER_ABI,
      functionName: 'mint',
      args: [
        {
          token0: getAddress(target.token0.address),
          token1: getAddress(target.token1.address),
          fee: target.feeTier,
          tickLower: request.tickRange.lowerTick,
          tickUpper: request.tickRange.upperTick,
          amount0Desired: request.amount0DesiredRaw,
          amount1Desired: request.amount1DesiredRaw,
          amount0Min: request.amount0MinRaw,
          amount1Min: request.amount1MinRaw,
          recipient: request.recipient,
          deadline,
        },
      ],
    });

    // The mint pulls BOTH legs from the wallet to the position manager.
    await this.ensureAllowance(target.token0.address, this.contracts.positionManager, request.amount0DesiredRaw, request.guard);
    await this.ensureAllowance(target.token1.address, this.contracts.positionManager, request.amount1DesiredRaw, request.guard);

    const txHash = await this.chain.sendTransaction({
      to: this.contracts.positionManager,
      data,
      value: 0n,
      guard: request.guard,
    });

    const info = await this.chain.waitForTransaction(txHash);
    if (info.state !== TX_STATES.CONFIRMED) {
      throw new ChainError(
        CHAIN_ERROR_CODES.TX_GUARD_FAILED,
        `addLiquidity did not succeed on chain (${info.state}, hash ${txHash}); refusing to continue`,
        { poolId: request.poolId },
      );
    }

    // The minted `tokenId` comes from the receipt, not from the mint call's simulation.
    const logs = await this.chain.getReceiptLogs(txHash);
    let positionTokenId: bigint | undefined;
    if (logs !== null) {
      for (const log of logs) {
        const topic0 = log.topics[0];
        const tokenIdTopic = log.topics[1];
        if (topic0 === undefined || tokenIdTopic === undefined) continue;
        // `IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)`
        if (topic0 === INCREASE_LIQUIDITY_EVENT_TOPIC) {
          positionTokenId = BigInt(tokenIdTopic);
          break;
        }
      }
    }
    return { txHash, state: TX_STATES.CONFIRMED, ...(positionTokenId === undefined ? {} : { positionTokenId }) };
  }

  /**
   * §71 Remove liquidity: `multicall([decreaseLiquidity, collect])` on the position manager.
   *
   * `decreaseLiquidity` only credits the position's `tokensOwed`; the tokens reach the recipient only
   * when `collect` runs. Both go in one transaction so a remove can never leave the principal stranded
   * inside the manager (which the caller would read as "the exit did nothing").
   *
   * `liquidityRaw: null` means "everything" and is resolved from the position's **current** on-chain
   * `liquidity`, never from a cached figure or `type(uint128).max`.
   */
  async removeLiquidity(request: RemoveLiquidityRequest): Promise<LiquidityExecutionResult> {
    // §95 is the first statement, before any whitelist lookup, encoding or read.
    assertTxGuard(request.guard, { to: this.contracts.positionManager });
    const positionManager = this.positionReader.positionManagerFor(UNISWAP_V3);

    const raw = await this.positionReader.readRawPosition(positionManager, request.positionTokenId);
    if (raw === null) {
      throw new ChainError(
        CHAIN_ERROR_CODES.DECODE_FAILED,
        `position ${request.positionTokenId} does not exist on ${positionManager}; nothing to remove`,
        { positionTokenId: request.positionTokenId.toString(), positionManager },
      );
    }
    await this.assertPositionMatchesPool(request.poolId, raw);
    assertNotZeroAddress(request.recipient, 'removeLiquidity', 'recipient');

    const burn = request.liquidityRaw ?? raw.liquidity;

    // A zero-liquidity NFT is an emptied shell (a previous run already paid its principal out via
    // decrease+collect): the right action is a plain burn, not a refusal that leaves the shell on
    // `balanceOf` forever.
    if (burn <= 0n) {
      const data = encodeFunctionData({
        abi: UNISWAP_V3_POSITION_MANAGER_ABI,
        functionName: 'multicall',
        args: [[this.collectCalldata(request.positionTokenId, request.recipient),
                encodeFunctionData({
                  abi: UNISWAP_V3_POSITION_MANAGER_ABI,
                  functionName: 'burn',
                  args: [request.positionTokenId],
                })]],
      });
      const txHash = await this.chain.sendTransaction({
        to: positionManager,
        data,
        value: 0n,
        guard: request.guard,
      });
      await this.awaitMined(txHash, 'removeLiquidity(burn shell)');
      return { txHash, state: TX_STATES.CONFIRMED };
    }
    if (burn > raw.liquidity) {
      throw new ChainError(
        CHAIN_ERROR_CODES.INVALID_ARGUMENT,
        `position ${request.positionTokenId} holds ${raw.liquidity.toString()} liquidity but ` +
          `${burn.toString()} was requested; decreaseLiquidity would revert`,
        {
          positionTokenId: request.positionTokenId.toString(),
          requested: burn.toString(),
          onChain: raw.liquidity.toString(),
        },
      );
    }

    const deadline = this.positionManagerDeadline(request.deadline, 'removeLiquidity');
    const decrease = encodeFunctionData({
      abi: UNISWAP_V3_POSITION_MANAGER_ABI,
      functionName: 'decreaseLiquidity',
      args: [
        {
          tokenId: request.positionTokenId,
          liquidity: burn,
          amount0Min: request.amount0MinRaw,
          amount1Min: request.amount1MinRaw,
          deadline,
        },
      ],
    });
    const collect = this.collectCalldata(request.positionTokenId, request.recipient);
    // A full exit (null liquidity = everything) also burns the emptied NFT, mirroring the Pancake
    // path: an unburned shell would surface on `balanceOf` as a position that does not exist.
    const calls =
      request.liquidityRaw === null
        ? [
            decrease,
            collect,
            encodeFunctionData({
              abi: UNISWAP_V3_POSITION_MANAGER_ABI,
              functionName: 'burn',
              args: [request.positionTokenId],
            }),
          ]
        : [decrease, collect];
    const data = encodeFunctionData({
      abi: UNISWAP_V3_POSITION_MANAGER_ABI,
      functionName: 'multicall',
      args: [calls],
    });

    const txHash = await this.chain.sendTransaction({
      to: positionManager,
      data,
      value: 0n,
      guard: request.guard,
    });
    // §5.3.5: the exit's next step re-reads the wallet, so the removal must be a settled fact.
    await this.awaitMined(txHash, 'removeLiquidity');
    return { txHash, state: TX_STATES.CONFIRMED };
  }

  /**
   * §62/§63 Fee collection: `collect` with `type(uint128).max` maxima, i.e. "everything currently
   * owed", to `request.recipient`. The maxima bound a transfer, they do not authorise spending, so
   * the §93 "never unlimited" rule (which is about ERC-20 allowances) does not apply.
   */
  async collectFees(request: CollectFeesRequest): Promise<LiquidityExecutionResult> {
    // §95 is the first statement, before any whitelist lookup, encoding or read.
    assertTxGuard(request.guard, { to: this.contracts.positionManager });
    const positionManager = this.positionReader.positionManagerFor(UNISWAP_V3);
    assertNotZeroAddress(request.recipient, 'collectFees', 'recipient');

    // The position must belong to the pool the caller named, or the audit trail would describe a
    // collection from a position that was never approved.
    const raw = await this.positionReader.readRawPosition(positionManager, request.positionTokenId);
    if (raw === null) {
      throw new ChainError(
        CHAIN_ERROR_CODES.DECODE_FAILED,
        `position ${request.positionTokenId} does not exist on ${positionManager}; nothing to collect`,
        { positionTokenId: request.positionTokenId.toString(), positionManager },
      );
    }
    await this.assertPositionMatchesPool(request.poolId, raw);

    const data = this.collectCalldata(request.positionTokenId, request.recipient);
    const txHash = await this.chain.sendTransaction({
      to: positionManager,
      data,
      value: 0n,
      guard: request.guard,
    });
    await this.awaitMined(txHash, 'collectFees');
    return { txHash, state: TX_STATES.CONFIRMED };
  }

  // -----------------------------------------------------------------------------------------------
  // Encoding helpers
  // -----------------------------------------------------------------------------------------------

  /** `collect(tokenId, recipient, max, max)` — the "sweep everything owed" call. */
  private collectCalldata(tokenId: bigint, recipient: Address): Hex {
    return encodeFunctionData({
      abi: UNISWAP_V3_POSITION_MANAGER_ABI,
      functionName: 'collect',
      args: [
        { tokenId, recipient, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 },
      ],
    });
  }

  /**
   * Wrap a router call in the deadline `multicall` — timestamp or `previousBlockhash`, as given.
   *
   * The `previousBlockhash` form is the robot-preferred one (§42: immune to clock drift) and is
   * available on `SwapRouter02`'s `MulticallExtended`.
   */
  private routerMulticall(deadline: DeadlineSpec, inner: Hex, operation: string): Hex {
    if (deadline.kind === 'previous-blockhash') {
      return encodeFunctionData({
        abi: UNISWAP_V3_ROUTER_MULTICALL_BLOCKHASH_ABI,
        functionName: 'multicall',
        args: [deadline.blockhash, [inner]],
      });
    }
    return encodeFunctionData({
      abi: UNISWAP_V3_ROUTER_MULTICALL_DEADLINE_ABI,
      functionName: 'multicall',
      args: [timestampDeadline(deadline.unixSeconds, operation), [inner]],
    });
  }

  /**
   * The `uint256 deadline` argument of a position-manager call.
   *
   * `previousBlockhash` is refused: the deployed NPM has no `multicall(bytes32,bytes[])` overload
   * (only `multicall(bytes[])`, verified against its bytecode), so the variant is unrepresentable
   * for `mint`/`decreaseLiquidity`. Converting it to a local-clock timestamp would silently discard
   * the drift immunity the caller asked for, which is worse than refusing.
   */
  private positionManagerDeadline(deadline: DeadlineSpec, operation: string): bigint {
    if (deadline.kind === 'previous-blockhash') {
      throw new ChainError(
        CHAIN_ERROR_CODES.INVALID_ARGUMENT,
        `${operation} cannot honour a previousBlockhash deadline on ${UNISWAP_V3}: the deployed ` +
          `position manager (${this.contracts.positionManager}) implements only ` +
          'multicall(bytes[]), not MulticallExtended\'s multicall(bytes32,bytes[]), and ' +
          'mint/decreaseLiquidity take a uint256 deadline. Supply { kind: \'timestamp\' } — refusing ' +
          'to substitute a local-clock timestamp for a drift-immune deadline.',
        { dex: UNISWAP_V3, positionManager: this.contracts.positionManager, operation },
      );
    }
    return timestampDeadline(deadline.unixSeconds, operation);
  }

  /** The pool leg matching `address`, or a refusal naming the mismatch. */
  private legOf(target: { readonly token0: TokenMeta; readonly token1: TokenMeta; readonly poolId: PoolId }, address: Address, label: string): TokenMeta {
    if (target.token0.address.toLowerCase() === address.toLowerCase()) return target.token0;
    if (target.token1.address.toLowerCase() === address.toLowerCase()) return target.token1;
    throw new ChainError(
      CHAIN_ERROR_CODES.INVALID_ARGUMENT,
      `${label} ${address} is neither leg of ${target.poolId} ` +
        `(${target.token0.address}/${target.token1.address}); refusing to act on the wrong pair`,
      { poolId: target.poolId, address, label },
    );
  }

  /**
   * `request.poolId` must name the pool the position actually belongs to.
   *
   * The pair and fee come from the position itself and are resolved through the factory, so a
   * mismatch is a caller mistake (or a stale position id) that must not produce a transaction whose
   * audit record names a different pool than the one touched (§13).
   */
  private async assertPositionMatchesPool(
    poolId: PoolId,
    raw: { readonly token0: Address; readonly token1: Address; readonly fee: number },
  ): Promise<void> {
    const expected = addressFromPoolId(poolId, this.chainId, UNISWAP_V3);
    const actual = await this.chain.getPoolAddress(UNISWAP_V3, raw.token0, raw.token1, raw.fee);
    if (actual === null || getAddress(actual) !== getAddress(expected)) {
      throw new ChainError(
        CHAIN_ERROR_CODES.INVALID_ARGUMENT,
        `position pool (token0=${raw.token0}, token1=${raw.token1}, fee=${raw.fee}) resolves to ` +
          `${actual ?? 'no pool'}, but the request names ${expected} (${poolId}); refusing to act on ` +
          'a pool the position does not belong to',
        { poolId, expected, actual: actual ?? null },
      );
    }
  }

  /**
   * §34 tick alignment. An unaligned range is **rejected**, never nudged: the planner decided the
   * range, and silently moving a tick changes the position the operator approved.
   */
  private assertRangeOnGrid(range: TickRangeRef, tickSpacing: number): void {
    const { lowerTick, upperTick } = range;
    if (!Number.isInteger(lowerTick) || !Number.isInteger(upperTick)) {
      throw new ChainError(
        CHAIN_ERROR_CODES.INVALID_ARGUMENT,
        `tick range must be integers, got ${String(lowerTick)}/${String(upperTick)}`,
        { lowerTick: String(lowerTick), upperTick: String(upperTick) },
      );
    }
    if (lowerTick >= upperTick) {
      throw new ChainError(
        CHAIN_ERROR_CODES.INVALID_ARGUMENT,
        `tick range must satisfy lowerTick < upperTick, got ${lowerTick}/${upperTick}`,
        { lowerTick, upperTick },
      );
    }
    if (lowerTick < MIN_TICK || upperTick > MAX_TICK) {
      throw new ChainError(
        CHAIN_ERROR_CODES.INVALID_ARGUMENT,
        `tick range [${lowerTick}, ${upperTick}] leaves the representable range ` +
          `[${MIN_TICK}, ${MAX_TICK}]`,
        { lowerTick, upperTick },
      );
    }
    if (range.tickSpacing !== tickSpacing) {
      throw new ChainError(
        CHAIN_ERROR_CODES.INVALID_ARGUMENT,
        `tick range declares tickSpacing ${range.tickSpacing} but ${UNISWAP_V3} uses ` +
          `${tickSpacing} for this pool's fee; one of the two layers has the wrong grid map`,
        { declared: range.tickSpacing, expected: tickSpacing },
      );
    }
    if (lowerTick % tickSpacing !== 0 || upperTick % tickSpacing !== 0) {
      throw new ChainError(
        CHAIN_ERROR_CODES.INVALID_ARGUMENT,
        `tick range [${lowerTick}, ${upperTick}] is not aligned to tickSpacing ${tickSpacing} ` +
          '(both bounds must be multiples of the pool grid); refusing to nudge it — that would ' +
          'mint a range other than the planned one',
        { lowerTick, upperTick, tickSpacing },
      );
    }
  }

  /** The signer address, or a refusal: this adapter never names an address it was not given. */
  private requireSigner(operation: string): Address {
    const signer = this.chain.getSignerAddress();
    if (signer === null) {
      throw new ChainError(
        CHAIN_ERROR_CODES.INVALID_ARGUMENT,
        `${operation} needs an attached signer: the swap recipient is the signer and this adapter ` +
          'cannot invent one',
        { operation },
      );
    }
    return signer;
  }

  /**
   * §40/USD notional of the trade, using the same accounting convention as the position planner: a
   * whitelisted **stablecoin** leg is the unit of account (§8 identity, never the symbol), so the
   * notional is the stable side's UI amount. With no stablecoin leg there is no trustworthy USD
   * figure available at this layer, and one is not invented (§96).
   */
  private notionalUsd(tokenIn: TokenMeta, tokenOut: TokenMeta, amountInRaw: bigint, amountOutRaw: bigint): number {
    if (tokenIn.kind === TOKEN_KINDS.STABLECOIN) return toFloat(amountInRaw, tokenIn.decimals);
    if (tokenOut.kind === TOKEN_KINDS.STABLECOIN) return toFloat(amountOutRaw, tokenOut.decimals);
    throw new ChainError(
      CHAIN_ERROR_CODES.INVALID_ARGUMENT,
      `cannot value a ${tokenIn.symbol}/${tokenOut.symbol} swap in USD: neither leg is a ` +
        'whitelisted stablecoin and this layer has no reference-price provider; refusing to invent ' +
        'amountInUsd (§96)',
      { tokenIn: tokenIn.address, tokenOut: tokenOut.address },
    );
  }
}

/** `createDexAdapter` expects a one-argument constructor; this is the registered factory. */
export function createUniswapV3Adapter(options: UniswapV3AdapterOptions): UniswapV3Adapter {
  return new UniswapV3Adapter(options);
}

/** §42 timestamp deadline: a positive integer second count. */
function timestampDeadline(unixSeconds: number, operation: string): bigint {
  if (!Number.isInteger(unixSeconds) || unixSeconds <= 0) {
    throw new ChainError(
      CHAIN_ERROR_CODES.INVALID_ARGUMENT,
      `${operation}: deadline timestamp must be a positive integer, got ${String(unixSeconds)}`,
      { operation, unixSeconds: String(unixSeconds) },
    );
  }
  // Freshness itself (`deadlineOk`) is the §95 guard's check; this function only guarantees the
  // argument is encodable, so the two layers cannot disagree about who owns the policy.
  return BigInt(unixSeconds);
}

/** `3000` → `0.3` (a fee tier rendered as a percentage, for the audit route string). */
function feePercent(feeTier: FeeTier): string {
  return (feeTier / 10_000).toString();
}

/** The zero address as a literal, so the comparison cannot be confused with a checksummed form. */
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * A zero-address recipient is a burn, not a transfer: `collect`/`decreaseLiquidity` would send the
 * proceeds to `0x0` irrecoverably. Refusing is the only safe reading of an unset recipient.
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
