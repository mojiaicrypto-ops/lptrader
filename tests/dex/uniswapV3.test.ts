/**
 * §82 Uniswap V3 adapter: read paths, quoting, the two-transaction write shapes and every refusal.
 *
 * The mock node is the same in-memory JSON-RPC node the chain tests use; nothing here touches a
 * network, and the write tests assert on the **calldata that was broadcast** (`eth_sendTransaction`)
 * rather than on a receipt. The `slot0` fixture is the real QQQB/USDC Uniswap V3 pool on BSC, so a
 * decode or orientation regression shows up as a wrong number rather than as a green test.
 */
import { describe, expect, it } from 'vitest';
import { decodeFunctionData, type Abi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { BscChainAdapter } from '../../src/chain/adapter.ts';
import { CLMM_POOL_ABI, ERC20_ABI, POSITION_MANAGER_ABI } from '../../src/chain/abis.ts';
import { CHAIN_ERROR_CODES, TxGuardError } from '../../src/chain/errors.ts';
import { handlerTransport } from '../../src/chain/rpc.ts';
import { buildTxGuard, emptyTxGuard, selectorOf } from '../../src/chain/txState.ts';
import { BSC_ADDRESSES, BSC_DEX_CONTRACTS } from '../../src/config/builtins.ts';
import { createWhitelist, defaultDexWhitelist } from '../../src/config/index.ts';
import { createBuiltinRegistry } from '../../src/config/registry.ts';
import { tickSpacingFor } from '../../src/dex/index.ts';
import {
  DEFAULT_SLIPPAGE_TOLERANCE,
  MAX_UINT128,
  UNISWAP_V3_POSITION_MANAGER_ABI,
  UNISWAP_V3_QUOTER_V2_ABI,
  UNISWAP_V3_ROUTER_MULTICALL_BLOCKHASH_ABI,
  UNISWAP_V3_ROUTER_MULTICALL_DEADLINE_ABI,
  UNISWAP_V3_SWAP_ROUTER_ABI,
  UniswapV3Adapter,
  createUniswapV3Adapter,
} from '../../src/dex/uniswapV3.ts';
import { applyFloorRatio } from '../../src/util/decimal.ts';
import { TX_STATES, type DeadlineSpec, type SwapQuote, type TxGuardChecks } from '../../src/types/adapters.ts';
import { DEX_IDS } from '../../src/types/primitives.ts';
import { callEntry, createMockNode, entry, type MockNodeOptions } from '../chain/mockNode.ts';

const QQQB = '0x205812cdbed920aff76c6580abd681a46d11efc7' as const;
const USDC = BSC_ADDRESSES.USDC;
const WBNB = BSC_ADDRESSES.WBNB;
/** QQQB/USDC 0.3% — the live Uniswap V3 pool on BSC (research §4.1). */
const POOL = '0xfc4e77248b76fefc27c4cac7151a2ee5b5cc590e' as const;
const POOL_ID = `56:${DEX_IDS.UNISWAP_V3}:${POOL}`;
const FEE = 3000;
const SPACING = 60;
const LIQUIDITY = 1_647_325_147_708_000_085_584_945n;
/** Real `slot0()` for that pool: (sqrtPriceX96, tick, obs, card, cardNext, feeProtocol, unlocked). */
const SLOT0 = [
  2_151_882_938_487_960_613_408_551_848_026n,
  66_038,
  0,
  1,
  1,
  102,
  true,
] as const;
/**
 * The pool's own token order: `token0()` is the numerically smaller address, so QQQB (0x2058…)
 * sorts before USDC (0x8ac7…). A caller that assumes "stable first" would derive the reciprocal
 * price and misprice the trade by orders of magnitude, so the fixture keeps the real ordering.
 */
const TOKEN0 = QQQB;
const TOKEN1 = USDC;
/**
 * QuoterV2 answer for 1 QQQB → USDC. The mid is ~737.69 USDC/QQQB, so 736 out for 1 in is a
 * realistic ~0.23% impact — a value the §40 gate can actually be reasoned about, rather than a
 * placeholder that would pass any comparison.
 */
const QUOTED_OUT = 736_000_000_000_000_000_000n;
const SIGNER = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const NOW = new Date('2026-09-29T12:00:00.000Z');

const CONTRACTS = BSC_DEX_CONTRACTS[DEX_IDS.UNISWAP_V3]!;
const ROUTER = CONTRACTS.swapRouter;
const MANAGER = CONTRACTS.positionManager;
const QUOTER = CONTRACTS.quoterV2;
const FACTORY = CONTRACTS.factory;

const ALL_OK = {
  chainIdOk: true,
  toWhitelisted: true,
  tokenInWhitelisted: true,
  tokenOutWhitelisted: true,
  functionSelectorOk: true,
  amountWithinLimit: true,
  slippageWithinLimit: true,
  deadlineOk: true,
  gasLimitSet: true,
  allowanceNotUnlimited: true,
} as const;

const GUARD: TxGuardChecks = buildTxGuard(ALL_OK);
const TIMESTAMP_DEADLINE: DeadlineSpec = { kind: 'timestamp', unixSeconds: 1_800_000_000 };
const BLOCKHASH_DEADLINE: DeadlineSpec = {
  kind: 'previous-blockhash',
  blockhash: `0x${'ab'.repeat(32)}` as Hex,
};

/** Pool contract card: `slot0`, `liquidity`, `fee`, `tickSpacing` and the two token getters. */
function poolCard(): Record<string, Hex | 'revert'> {
  const card: Record<string, Hex | 'revert'> = {};
  entry(card, 'slot0()', SLOT0, CLMM_POOL_ABI);
  entry(card, 'liquidity()', LIQUIDITY, CLMM_POOL_ABI);
  entry(card, 'fee()', FEE, CLMM_POOL_ABI);
  entry(card, 'tickSpacing()', SPACING, CLMM_POOL_ABI);
  entry(card, 'token0()', TOKEN0, CLMM_POOL_ABI);
  entry(card, 'token1()', TOKEN1, CLMM_POOL_ABI);
  return card;
}

/** Factory card answering `getPool` for the live pair and the zero address for a non-existent one. */
function factoryCard(): Record<string, Hex | 'revert'> {
  const card: Record<string, Hex | 'revert'> = {};
  callEntry(card, 'getPool(address,address,uint24)', [TOKEN0, TOKEN1, FEE], POOL, CLMM_FACTORY_ABI_LOCAL);
  callEntry(card, 'getPool(address,address,uint24)', [TOKEN0, WBNB, FEE], '0x0000000000000000000000000000000000000000', CLMM_FACTORY_ABI_LOCAL);
  return card;
}

/** The factory fragment is declared locally so the test cannot silently drift from the adapter. */
const CLMM_FACTORY_ABI_LOCAL = [
  {
    type: 'function',
    name: 'getPool',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenA', type: 'address' },
      { name: 'tokenB', type: 'address' },
      { name: 'fee', type: 'uint24' },
    ],
    outputs: [{ name: 'pool', type: 'address' }],
  },
] as const;

interface HarnessOptions {
  readonly contracts?: NonNullable<MockNodeOptions['contracts']>;
  readonly account?: boolean;
  readonly extra?: MockNodeOptions['extra'];
  readonly now?: () => Date;
}

/**
 * An adapter wired to one mock node. `sent` records every broadcast payload so a test can assert
 * both *what* was sent and that **nothing** was sent on a refusal path.
 */
function harness(options: HarnessOptions = {}) {
  const sent: { to: string; data: Hex; value: string }[] = [];
  const node = createMockNode({
    contracts: options.contracts ?? {},
    extra: {
      eth_getTransactionCount: () => '0x0',
      eth_sendTransaction: (params) => {
        const request = (params as readonly { to?: string; data?: string; value?: string }[])[0]!;
        sent.push({ to: String(request.to), data: (request.data ?? '0x') as Hex, value: String(request.value) });
        return `0x${'11'.repeat(32)}`;
      },
      ...options.extra,
    },
  });
  const whitelist = createWhitelist(createBuiltinRegistry().list(), [56], defaultDexWhitelist([56]));
  const chain = new BscChainAdapter({
    chainId: 56,
    whitelist,
    ...(options.account === false ? {} : { account: SIGNER }),
    rpc: {
      endpoints: [{ label: 'n1', url: 'mock://n1' }],
      transportFactory: () => handlerTransport(node.handle),
      retries: 0,
      crossCheckEndpoints: 1,
    },
  });
  const adapter = new UniswapV3Adapter({
    chainId: 56,
    whitelist,
    chain,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { adapter, node, sent };
}

/**
 * A full contract table for the live pool: factory, pool, **both token reserves** (a full pool read
 * batches `balanceOf` for the two legs, so a missing reserve card is a broken fixture, not an
 * optional one) plus whatever a test adds.
 */
function liveContracts(extra: NonNullable<MockNodeOptions['contracts']> = {}) {
  // Placeholder reserves consistent with the pool's reported ~$1.77M TVL at ~$737.69/QQQB
  // (1200 QQQB + 890k USDC). No test asserts them: they exist so the batched `readPool` completes.
  const qqqbCard: Record<string, Hex | 'revert'> = {};
  callEntry(qqqbCard, 'balanceOf(address)', [POOL], 1_200_000_000_000_000_000_000n, ERC20_ABI);
  const usdcCard: Record<string, Hex | 'revert'> = {};
  callEntry(usdcCard, 'balanceOf(address)', [POOL], 890_000_000_000_000_000_000_000n, ERC20_ABI);
  return {
    [FACTORY]: factoryCard(),
    [POOL]: poolCard(),
    [TOKEN0]: qqqbCard,
    [TOKEN1]: usdcCard,
    ...extra,
  };
}

function quote(overrides: Partial<SwapQuote> = {}): SwapQuote {
  return {
    poolId: POOL_ID,
    tokenIn: QQQB,
    tokenOut: USDC,
    amountInRaw: 1_000_000_000_000_000_000n,
    amountOutRaw: QUOTED_OUT,
    amountInUsd: 736,
    priceImpact: 0.0004,
    slippageTolerance: DEFAULT_SLIPPAGE_TOLERANCE,
    amountOutMinimumRaw: 733_864_000_000_000_000_000n,
    quotedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 30_000).toISOString(),
    route: ['QQQB/USDC 0.3%'],
    ...overrides,
  };
}

describe('capability', () => {
  it('reports itself as a two-transaction venue with the Uniswap id and chain', () => {
    const { adapter } = harness();
    expect(adapter.dex).toBe('uniswap-v3');
    expect(adapter.chainId).toBe(56);
    // §42: the deployed SwapRouter02 + NPM cannot combine a swap with a mint.
    expect(adapter.supportsAtomicBuild).toBe(false);
    expect(() => adapter.assertWhitelisted()).not.toThrow();
  });

  it('refuses to construct when the DEX is not whitelisted for the chain', () => {
    const { adapter } = harness();
    // A whitelist that lists the chain but not this DEX must fail at `assertWhitelisted`, not later.
    const chainOnly = createWhitelist(createBuiltinRegistry().list(), [56], []);
    const stripped = new UniswapV3Adapter({
      chainId: 56,
      whitelist: chainOnly,
      chain: (adapter as unknown as { chain: BscChainAdapter }).chain,
    });
    expect(() => stripped.assertWhitelisted()).toThrowError(/uniswap-v3/);
  });

  it('refuses a chain adapter bound to a different chain', () => {
    const node = createMockNode({});
    const whitelist = createWhitelist(createBuiltinRegistry().list(), [56], defaultDexWhitelist([56]));
    const otherChain = new BscChainAdapter({
      chainId: 97,
      whitelist: createWhitelist(createBuiltinRegistry().list(), [97], []),
      rpc: {
        endpoints: [{ label: 'n1', url: 'mock://n1' }],
        transportFactory: () => handlerTransport(node.handle),
        retries: 0,
      },
    });
    expect(
      () => new UniswapV3Adapter({ chainId: 56, whitelist, chain: otherChain }),
    ).toThrowError(/mismatched pair/);
  });

  it('exposes a factory that builds the same adapter', () => {
    const { adapter } = harness();
    const chain = (adapter as unknown as { chain: BscChainAdapter }).chain;
    const whitelist = createWhitelist(createBuiltinRegistry().list(), [56], defaultDexWhitelist([56]));
    const built = createUniswapV3Adapter({ chainId: 56, whitelist, chain });
    expect(built.dex).toBe(adapter.dex);
    expect(built.supportsAtomicBuild).toBe(false);
  });
});

describe('read paths', () => {
  it('resolves the pool through this DEX’s factory and reports the pool’s own grid', async () => {
    const { adapter } = harness({ contracts: liveContracts() });
    const pool = await adapter.getPool(TOKEN0, TOKEN1, FEE);
    expect(pool).not.toBeNull();
    expect(pool!.poolAddress.toLowerCase()).toBe(POOL);
    expect(pool!.poolId).toBe(POOL_ID);
    expect(pool!.dex).toBe(DEX_IDS.UNISWAP_V3);
    expect(pool!.chainId).toBe(56);
    expect(pool!.feeTier).toBe(FEE);
    // The grid comes from the pool's `tickSpacing()`, and it agrees with the DEX fee map.
    expect(pool!.tickSpacing).toBe(tickSpacingFor(DEX_IDS.UNISWAP_V3, FEE));
    expect(pool!.tickSpacing).toBe(SPACING);
    expect(pool!.token0.toLowerCase()).toBe(TOKEN0);
    expect(pool!.token1.toLowerCase()).toBe(TOKEN1);
  });

  it('returns null for a proven-absent pool and refuses a fee tier this DEX does not deploy', async () => {
    const { adapter } = harness({ contracts: liveContracts() });
    // The factory answered the zero address → a proven absence, not an error.
    expect(await adapter.getPool(TOKEN0, WBNB, FEE)).toBeNull();
    // 2500 is Pancake's tier; asking the Uniswap adapter for it must throw, never probe.
    await expect(adapter.getPool(TOKEN0, TOKEN1, 2500)).rejects.toThrowError(/2500/);
    await expect(adapter.getPool(TOKEN0, TOKEN1, 2500)).rejects.toThrowError(/uniswap-v3/);
  });

  it('reads the live QQQB/USDC pool state with the pool’s own token order', async () => {
    const { adapter } = harness({ contracts: liveContracts() });
    const price = await adapter.getPoolPrice(POOL);
    expect(price.poolId).toBe(POOL_ID);
    expect(price.sqrtPriceX96).toBe(SLOT0[0]);
    expect(price.tick).toBe(66_038);
    expect(price.liquidity).toBe(LIQUIDITY);
    expect(price.feeTier).toBe(FEE);
    expect(price.tickSpacing).toBe(SPACING);
    // Both legs are 18 decimals, so USDC per QQQB is the raw price (~$737.7). A decimals or
    // orientation mistake here would move this by orders of magnitude.
    expect(price.priceToken1PerToken0).toBeCloseTo(737.69, 1);
    // No reference price is wired at this layer, so no USD figure may be invented.
    expect(price.priceUsd).toBeUndefined();
  });

  it('exposes active liquidity and the current tick separately', async () => {
    const { adapter } = harness({ contracts: liveContracts() });
    expect(await adapter.getLiquidity(POOL)).toBe(LIQUIDITY);
    expect(await adapter.getTick(POOL)).toBe(66_038);
  });

  it('reads a position from this DEX’s own manager and derives the pool id from the position', async () => {
    const managerCard: Record<string, Hex | 'revert'> = {};
    callEntry(
      managerCard,
      'positions(uint256)',
      [4242n],
      [7n, '0x0000000000000000000000000000000000000000', TOKEN0, TOKEN1, FEE, -60, 60, 123_456n,
        1n, 2n, 1_500_000_000_000_000_000n, 2_250_000_000_000_000_000n],
      POSITION_MANAGER_ABI,
    );
    callEntry(managerCard, 'ownerOf(uint256)', [4242n], SIGNER.address, POSITION_MANAGER_ABI);
    const { adapter } = harness({ contracts: liveContracts({ [MANAGER]: managerCard }) });

    const position = await adapter.getPosition(4242n);
    expect(position).not.toBeNull();
    // §13: the pool id is derived from the position's own (token0, token1, fee) via the factory.
    expect(position!.poolId).toBe(POOL_ID);
    expect(position!.positionTokenId).toBe(4242n);
    expect(position!.owner.toLowerCase()).toBe(SIGNER.address.toLowerCase());
    expect(position!.feeTier).toBe(FEE);
    expect(position!.tickLower).toBe(-60);
    expect(position!.tickUpper).toBe(60);
    expect(position!.liquidity).toBe(123_456n);
    expect(position!.tokensOwed0Raw).toBe(1_500_000_000_000_000_000n);
    expect(position!.tokensOwed1Raw).toBe(2_250_000_000_000_000_000n);
  });

  it('returns null for a tokenId the manager does not know', async () => {
    const managerCard: Record<string, Hex | 'revert'> = {};
    entry(managerCard, 'positions(uint256)', 'revert', POSITION_MANAGER_ABI);
    const { adapter } = harness({ contracts: liveContracts({ [MANAGER]: managerCard }) });
    expect(await adapter.getPosition(999n)).toBeNull();
  });

  it('refuses a position whose pool the factory reports as absent rather than inventing a poolId', async () => {
    const managerCard: Record<string, Hex | 'revert'> = {};
    callEntry(
      managerCard,
      'positions(uint256)',
      [4242n],
      [7n, '0x0000000000000000000000000000000000000000', TOKEN0, WBNB, FEE, -60, 60, 1n, 1n, 1n, 0n, 0n],
      POSITION_MANAGER_ABI,
    );
    const { adapter } = harness({ contracts: liveContracts({ [MANAGER]: managerCard }) });
    await expect(adapter.getPosition(4242n)).rejects.toMatchObject({
      code: CHAIN_ERROR_CODES.DECODE_FAILED,
    });
  });
});

describe('quoteSwap', () => {
  function quoterContracts(value: bigint = QUOTED_OUT, extras: NonNullable<MockNodeOptions['contracts']> = {}) {
    const quoterCard: Record<string, Hex | 'revert'> = {};
    callEntry(
      quoterCard,
      'quoteExactInputSingle((address,address,uint256,uint24,uint160))',
      [{ tokenIn: QQQB, tokenOut: USDC, amountIn: 1_000_000_000_000_000_000n, fee: FEE, sqrtPriceLimitX96: 0n }],
      [value, SLOT0[0], 0, 150_000n],
      UNISWAP_V3_QUOTER_V2_ABI as unknown as Abi,
    );
    return liveContracts({ [QUOTER]: quoterCard, ...extras });
  }

  it('quotes through QuoterV2 and returns the raw amounts unchanged', async () => {
    const { adapter, node } = harness({ contracts: quoterContracts(), now: () => NOW });
    const result = await adapter.quoteSwap({
      poolId: POOL_ID,
      tokenIn: QQQB,
      tokenOut: USDC,
      amountIn: 1_000_000_000_000_000_000n,
      ttlSeconds: 30,
    });

    expect(result.poolId).toBe(POOL_ID);
    expect(result.tokenIn).toBe(QQQB);
    expect(result.tokenOut).toBe(USDC);
    expect(result.amountInRaw).toBe(1_000_000_000_000_000_000n);
    // RAW units in, RAW units out: no UI scaling anywhere in this path.
    expect(result.amountOutRaw).toBe(QUOTED_OUT);
    expect(result.slippageTolerance).toBe(DEFAULT_SLIPPAGE_TOLERANCE);
    // §41 `amountOut * (1 - slippage)`, floored in integer maths.
    expect(result.amountOutMinimumRaw).toBe(applyFloorRatio(QUOTED_OUT, 1 - DEFAULT_SLIPPAGE_TOLERANCE));
    expect(result.route).toEqual(['QQQB/USDC 0.3%']);
    // The quoter is a read (`eth_call`); no transaction may follow from quoting.
    expect(node.countOf('eth_sendTransaction')).toBe(0);
    expect(node.countOf('eth_call')).toBeGreaterThan(0);
  });

  it('computes a price impact from the pool mid price and the executed rate', async () => {
    const { adapter } = harness({ contracts: quoterContracts(), now: () => NOW });
    const result = await adapter.quoteSwap({
      poolId: POOL_ID,
      tokenIn: QQQB,
      tokenOut: USDC,
      amountIn: 1_000_000_000_000_000_000n,
      ttlSeconds: 30,
    });

    // Selling QQQB (the pool's token0) for USDC, so the executed rate is expressed the same way as
    // the mid (`token1` per `token0`, i.e. USDC per QQQB): 736 out per 1 in against the pool's own
    // mid. The expectation is derived from a live pool read rather than a copied literal, so it
    // stays honest if the fixture changes — while an inverted orientation would report ~0.999 here.
    const mid = (await adapter.getPoolPrice(POOL)).priceToken1PerToken0;
    expect(result.priceImpact).toBeCloseTo(Math.abs(736 - mid) / mid, 12);
    expect(result.priceImpact).toBeCloseTo(0.002_300_6, 6);
    expect(result.priceImpact).toBeLessThan(0.005);
  });

  it('refuses when the pool mid price cannot support an impact computation', async () => {
    // An uninitialised pool reads as sqrtPriceX96 = 0; the chain layer already refuses that read, so
    // there is no path on which a zero mid could be divided by.
    const deadPool: Record<string, Hex | 'revert'> = {};
    entry(deadPool, 'slot0()', [0n, 0, 0, 0, 0, 0, true], CLMM_POOL_ABI);
    entry(deadPool, 'liquidity()', 0n, CLMM_POOL_ABI);
    entry(deadPool, 'fee()', FEE, CLMM_POOL_ABI);
    entry(deadPool, 'tickSpacing()', SPACING, CLMM_POOL_ABI);
    entry(deadPool, 'token0()', TOKEN0, CLMM_POOL_ABI);
    entry(deadPool, 'token1()', TOKEN1, CLMM_POOL_ABI);
    const { adapter } = harness({ contracts: liveContracts({ [POOL]: deadPool }), now: () => NOW });
    await expect(
      adapter.quoteSwap({
        poolId: POOL_ID,
        tokenIn: QQQB,
        tokenOut: USDC,
        amountIn: 1_000_000_000_000_000_000n,
        ttlSeconds: 30,
      }),
    ).rejects.toMatchObject({ code: CHAIN_ERROR_CODES.DECODE_FAILED });
  });

  it('sets expiresAt from the injected clock plus the requested ttl', async () => {
    const { adapter } = harness({ contracts: quoterContracts(), now: () => NOW });
    const result = await adapter.quoteSwap({
      poolId: POOL_ID,
      tokenIn: QQQB,
      tokenOut: USDC,
      amountIn: 1_000_000_000_000_000_000n,
      ttlSeconds: 30,
    });
    expect(result.quotedAt).toBe('2026-09-29T12:00:00.000Z');
    expect(result.expiresAt).toBe('2026-09-29T12:00:30.000Z');
    expect(new Date(result.expiresAt).getTime() - new Date(result.quotedAt).getTime()).toBe(30_000);
  });

  it('values the notional in USD from the stablecoin leg, in whole tokens', async () => {
    const { adapter } = harness({ contracts: quoterContracts(), now: () => NOW });
    const result = await adapter.quoteSwap({
      poolId: POOL_ID,
      tokenIn: QQQB,
      tokenOut: USDC,
      amountIn: 1_000_000_000_000_000_000n,
      ttlSeconds: 30,
    });
    // USDC is 18 decimals on BSC (not 6): 736e18 raw is $736, and a 6-decimal assumption would
    // show $7.36e17 here.
    expect(result.amountInUsd).toBe(736);
  });

  it('refuses to fabricate a quote when the quoter answers zero output', async () => {
    const { adapter } = harness({ contracts: quoterContracts(0n), now: () => NOW });
    // A zero output cannot support the §40 impact computation, so there is no honest quote to return.
    await expect(
      adapter.quoteSwap({
        poolId: POOL_ID,
        tokenIn: QQQB,
        tokenOut: USDC,
        amountIn: 1_000_000_000_000_000_000n,
        ttlSeconds: 30,
      }),
    ).rejects.toMatchObject({ code: CHAIN_ERROR_CODES.DECODE_FAILED });
  });

  it('refuses a poolId belonging to another DEX or chain', async () => {
    const { adapter } = harness({ contracts: quoterContracts(), now: () => NOW });
    const request = {
      tokenIn: QQQB,
      tokenOut: USDC,
      amountIn: 1_000_000_000_000_000_000n,
      ttlSeconds: 30,
    };
    await expect(
      adapter.quoteSwap({ ...request, poolId: `56:${DEX_IDS.PANCAKESWAP_V3}:${POOL}` }),
    ).rejects.toThrowError(/belongs to DEX/);
    await expect(
      adapter.quoteSwap({ ...request, poolId: `97:${DEX_IDS.UNISWAP_V3}:${POOL}` }),
    ).rejects.toThrowError(/chain 97/);
  });

  it('refuses a token that is not a leg of the quoted pool', async () => {
    const { adapter } = harness({ contracts: quoterContracts(), now: () => NOW });
    await expect(
      adapter.quoteSwap({
        poolId: POOL_ID,
        tokenIn: WBNB,
        tokenOut: USDC,
        amountIn: 1_000_000_000_000_000_000n,
        ttlSeconds: 30,
      }),
    ).rejects.toThrowError(/neither leg of/);
  });

  it('refuses a non-positive amount, a self-swap and a non-positive ttl', async () => {
    const { adapter } = harness({ contracts: quoterContracts(), now: () => NOW });
    await expect(
      adapter.quoteSwap({ poolId: POOL_ID, tokenIn: QQQB, tokenOut: USDC, amountIn: 0n, ttlSeconds: 30 }),
    ).rejects.toThrowError(/positive RAW amountIn/);
    await expect(
      adapter.quoteSwap({ poolId: POOL_ID, tokenIn: QQQB, tokenOut: QQQB, amountIn: 1n, ttlSeconds: 30 }),
    ).rejects.toThrowError(/same token/);
    await expect(
      adapter.quoteSwap({ poolId: POOL_ID, tokenIn: QQQB, tokenOut: USDC, amountIn: 1n, ttlSeconds: 0 }),
    ).rejects.toThrowError(/ttlSeconds/);
  });
});

describe('§95 guard: no write path may send through a failed guard', () => {
  const BAD_GUARD: TxGuardChecks = { ...GUARD, ok: false, failures: ['tokenInWhitelisted'] };

  /**
   * A refused guard must stop the adapter *before* it touches the chain: the §95 check is the first
   * statement of every write method, so a rejected request costs no `eth_call` (no pool read, no
   * position read) and never reaches the encoder. Counting RPC calls is what distinguishes the
   * adapter's own check from the chain layer's second line of defence inside `sendTransaction`.
   */
  function writeHarness() {
    const managerCard: Record<string, Hex | 'revert'> = {};
    callEntry(
      managerCard,
      'positions(uint256)',
      [4242n],
      [7n, '0x0000000000000000000000000000000000000000', TOKEN0, TOKEN1, FEE, -60, 60, 123_456n, 1n, 1n, 0n, 0n],
      POSITION_MANAGER_ABI,
    );
    callEntry(managerCard, 'ownerOf(uint256)', [4242n], SIGNER.address, POSITION_MANAGER_ABI);
    return harness({ contracts: liveContracts({ [MANAGER]: managerCard }), now: () => NOW });
  }

  it('executeSwap refuses and sends nothing', async () => {
    const { adapter, sent, node } = writeHarness();
    await expect(
      adapter.executeSwap({
        quote: quote(),
        deadline: TIMESTAMP_DEADLINE,
        purpose: 'BUILD_POSITION',
        idempotencyKey: 'k1',
        guard: BAD_GUARD,
      }),
    ).rejects.toBeInstanceOf(TxGuardError);
    expect(sent).toEqual([]);
    expect(node.countOf('eth_call')).toBe(0);
  });

  it('addLiquidity refuses and sends nothing', async () => {
    const { adapter, sent, node } = writeHarness();
    await expect(
      adapter.addLiquidity({
        poolId: POOL_ID,
        tickRange: { lowerTick: -60, upperTick: 60, tickSpacing: SPACING },
        amount0DesiredRaw: 1n,
        amount1DesiredRaw: 1n,
        amount0MinRaw: 0n,
        amount1MinRaw: 0n,
        recipient: SIGNER.address,
        deadline: TIMESTAMP_DEADLINE,
        idempotencyKey: 'k2',
        guard: BAD_GUARD,
      }),
    ).rejects.toBeInstanceOf(TxGuardError);
    expect(sent).toEqual([]);
    expect(node.countOf('eth_call')).toBe(0);
    expect(node.countOf('eth_estimateGas')).toBe(0);
  });

  it('removeLiquidity refuses and sends nothing', async () => {
    const { adapter, sent, node } = writeHarness();
    await expect(
      adapter.removeLiquidity({
        poolId: POOL_ID,
        positionTokenId: 4242n,
        liquidityRaw: null,
        amount0MinRaw: 0n,
        amount1MinRaw: 0n,
        recipient: SIGNER.address,
        deadline: TIMESTAMP_DEADLINE,
        idempotencyKey: 'k3',
        guard: BAD_GUARD,
      }),
    ).rejects.toBeInstanceOf(TxGuardError);
    expect(sent).toEqual([]);
    expect(node.countOf('eth_call')).toBe(0);
    expect(node.countOf('eth_estimateGas')).toBe(0);
  });

  it('collectFees refuses and sends nothing', async () => {
    const { adapter, sent, node } = writeHarness();
    await expect(
      adapter.collectFees({
        poolId: POOL_ID,
        positionTokenId: 4242n,
        recipient: SIGNER.address,
        idempotencyKey: 'k4',
        guard: BAD_GUARD,
      }),
    ).rejects.toBeInstanceOf(TxGuardError);
    expect(sent).toEqual([]);
    expect(node.countOf('eth_call')).toBe(0);
    expect(node.countOf('eth_estimateGas')).toBe(0);
  });

  it('an entirely empty guard never reaches a send', async () => {
    const { adapter, sent, node } = writeHarness();
    await expect(
      adapter.collectFees({
        poolId: POOL_ID,
        positionTokenId: 4242n,
        recipient: SIGNER.address,
        idempotencyKey: 'k5',
        guard: emptyTxGuard(),
      }),
    ).rejects.toBeInstanceOf(TxGuardError);
    expect(sent).toEqual([]);
    expect(node.countOf('eth_call')).toBe(0);
  });
});

describe('§42 addLiquidity', () => {
  function add(overrides: Record<string, unknown> = {}) {
    return {
      poolId: POOL_ID,
      tickRange: { lowerTick: -60, upperTick: 60, tickSpacing: SPACING },
      amount0DesiredRaw: 100_000_000_000_000_000_000n,
      amount1DesiredRaw: 73_000_000_000_000_000_000n,
      amount0MinRaw: 99_000_000_000_000_000_000n,
      amount1MinRaw: 72_000_000_000_000_000_000n,
      recipient: SIGNER.address,
      deadline: TIMESTAMP_DEADLINE,
      idempotencyKey: 'k',
      guard: GUARD,
      ...overrides,
    };
  }

  it('refuses swapForDeficit and sends nothing — the venue cannot be atomic', async () => {
    const { adapter, sent } = harness({ contracts: liveContracts() });
    const error = await adapter
      .addLiquidity(add({ swapForDeficit: { quote: quote(), atomic: true } }) as never)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/swapForDeficit/);
    expect((error as Error).message).toMatch(/multicall|self-delegatecall/);
    expect((error as Error).message).toMatch(/supportsAtomicBuild/);
    // The critical assertion: a refusal, not a silent two-transaction downgrade.
    expect(sent).toEqual([]);
  });

  it('encodes mint with the pool’s own token order, the aligned range and the raw amounts', async () => {
    const { adapter, sent } = harness({ contracts: liveContracts() });
    const result = await adapter.addLiquidity(add() as never);

    expect(result.state).toBe(TX_STATES.SUBMITTED);
    // The mint return values need a receipt, so they are absent rather than assumed.
    expect(result.positionTokenId).toBeUndefined();
    expect(result.liquidity).toBeUndefined();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.to.toLowerCase()).toBe(MANAGER);
    expect(BigInt(sent[0]!.value)).toBe(0n);
    expect(selectorOf(sent[0]!.data)).toBe('0x88316456');

    const decoded = decodeFunctionData({ abi: UNISWAP_V3_POSITION_MANAGER_ABI, data: sent[0]!.data });
    expect(decoded.functionName).toBe('mint');
    const params = (decoded.args as readonly [Record<string, unknown>])[0]!;
    expect((params.token0 as string).toLowerCase()).toBe(TOKEN0);
    expect((params.token1 as string).toLowerCase()).toBe(TOKEN1);
    expect(params.fee).toBe(FEE);
    expect(params.tickLower).toBe(-60);
    expect(params.tickUpper).toBe(60);
    expect(params.amount0Desired).toBe(100_000_000_000_000_000_000n);
    expect(params.amount1Desired).toBe(73_000_000_000_000_000_000n);
    expect(params.amount0Min).toBe(99_000_000_000_000_000_000n);
    expect(params.amount1Min).toBe(72_000_000_000_000_000_000n);
    expect((params.recipient as string).toLowerCase()).toBe(SIGNER.address.toLowerCase());
    expect(params.deadline).toBe(1_800_000_000n);
  });

  it('rejects an unaligned tick range instead of nudging it', async () => {
    const { adapter, sent } = harness({ contracts: liveContracts() });
    // -61 is not a multiple of 60: minting it would revert, and nudging it would mint a range the
    // planner never approved.
    await expect(
      adapter.addLiquidity(add({ tickRange: { lowerTick: -61, upperTick: 60, tickSpacing: SPACING } }) as never),
    ).rejects.toThrowError(/not aligned to tickSpacing 60/);
    expect(sent).toEqual([]);
  });

  it('rejects a range whose declared tickSpacing disagrees with the DEX fee map', async () => {
    const { adapter, sent } = harness({ contracts: liveContracts() });
    await expect(
      adapter.addLiquidity(add({ tickRange: { lowerTick: -60, upperTick: 60, tickSpacing: 10 } }) as never),
    ).rejects.toThrowError(/declares tickSpacing 10/);
    expect(sent).toEqual([]);
  });

  it('rejects inverted, out-of-bounds and fractional tick ranges', async () => {
    const { adapter, sent } = harness({ contracts: liveContracts() });
    await expect(
      adapter.addLiquidity(add({ tickRange: { lowerTick: 60, upperTick: 60, tickSpacing: SPACING } }) as never),
    ).rejects.toThrowError(/lowerTick < upperTick/);
    await expect(
      adapter.addLiquidity(add({ tickRange: { lowerTick: -60, upperTick: 900_000, tickSpacing: SPACING } }) as never),
    ).rejects.toThrowError(/representable range/);
    await expect(
      adapter.addLiquidity(add({ tickRange: { lowerTick: -60.5, upperTick: 60, tickSpacing: SPACING } }) as never),
    ).rejects.toThrowError(/must be integers/);
    expect(sent).toEqual([]);
  });

  it('refuses a previousBlockhash deadline: the deployed NPM has no bytes32 multicall', async () => {
    const { adapter, sent } = harness({ contracts: liveContracts() });
    const error = await adapter
      .addLiquidity(add({ deadline: BLOCKHASH_DEADLINE }) as never)
      .catch((thrown: unknown) => thrown);
    expect((error as Error).message).toMatch(/previousBlockhash/);
    expect((error as Error).message).toMatch(/multicall\(bytes32,bytes\[\]\)/);
    expect(sent).toEqual([]);
  });

  it('refuses a build with zero desired amounts instead of minting nothing', async () => {
    const { adapter, sent } = harness({ contracts: liveContracts() });
    await expect(
      adapter.addLiquidity(add({ amount0DesiredRaw: 0n, amount1DesiredRaw: 0n }) as never),
    ).rejects.toThrowError(/ZERO_LIQUIDITY/);
    expect(sent).toEqual([]);
  });
});

describe('executeSwap calldata', () => {
  it('wraps exactInputSingle in the router deadline multicall, addressed to the signer', async () => {
    const { adapter, sent } = harness({ contracts: liveContracts(), now: () => NOW });
    const result = await adapter.executeSwap({
      quote: quote(),
      deadline: TIMESTAMP_DEADLINE,
      purpose: 'BUILD_POSITION',
      idempotencyKey: 'k',
      guard: GUARD,
    });

    expect(result.state).toBe(TX_STATES.SUBMITTED);
    expect(result.txHash).toBe(`0x${'11'.repeat(32)}`);
    expect(result.amountInRaw).toBe(1_000_000_000_000_000_000n);
    expect(result.amountOutRaw).toBe(QUOTED_OUT);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.to.toLowerCase()).toBe(ROUTER);
    // Token legs only: no call may carry native value (WBNB is swapped as an ERC-20).
    expect(BigInt(sent[0]!.value)).toBe(0n);
    // The selector is the deadline `multicall`, not the bare swap.
    expect(selectorOf(sent[0]!.data)).toBe('0x5ae401dc');

    const outer = decodeFunctionData({
      abi: UNISWAP_V3_ROUTER_MULTICALL_DEADLINE_ABI,
      data: sent[0]!.data,
    });
    expect(outer.functionName).toBe('multicall');
    const [deadlineUnix, inner] = outer.args as readonly [bigint, readonly Hex[]];
    expect(deadlineUnix).toBe(1_800_000_000n);
    expect(inner).toHaveLength(1);

    const swap = decodeFunctionData({ abi: UNISWAP_V3_SWAP_ROUTER_ABI, data: inner[0]! });
    const params = (swap.args as readonly [Record<string, unknown>])[0]!;
    // `decodeFunctionData` returns checksummed addresses; identity is case-insensitive by contract.
    expect((params.tokenIn as string).toLowerCase()).toBe(QQQB);
    expect((params.tokenOut as string).toLowerCase()).toBe(USDC);
    expect(params.fee).toBe(FEE);
    expect((params.recipient as string).toLowerCase()).toBe(SIGNER.address.toLowerCase());
    expect(params.amountIn).toBe(1_000_000_000_000_000_000n);
    // The signed floor is the quote's own; the adapter never widens it.
    expect(params.amountOutMinimum).toBe(733_864_000_000_000_000_000n);
    expect(params.sqrtPriceLimitX96).toBe(0n);
  });

  it('uses the previousBlockhash multicall variant when asked', async () => {
    const { adapter, sent } = harness({ contracts: liveContracts(), now: () => NOW });
    await adapter.executeSwap({
      quote: quote(),
      deadline: BLOCKHASH_DEADLINE,
      purpose: 'EXIT_POSITION',
      idempotencyKey: 'k',
      guard: GUARD,
    });

    // 0x1f0464d1 is `multicall(bytes32,bytes[])` — the robot-preferred, clock-drift-immune form,
    // and it is present on the deployed SwapRouter02 (verified against its bytecode).
    expect(selectorOf(sent[0]!.data)).toBe('0x1f0464d1');
    const outer = decodeFunctionData({
      abi: UNISWAP_V3_ROUTER_MULTICALL_BLOCKHASH_ABI,
      data: sent[0]!.data,
    });
    expect((outer.args as readonly [Hex, readonly Hex[]])[0]).toBe(BLOCKHASH_DEADLINE.blockhash);
  });

  it('refuses when no signer is attached rather than naming another recipient', async () => {
    const { adapter, sent } = harness({ contracts: liveContracts(), account: false, now: () => NOW });
    await expect(
      adapter.executeSwap({
        quote: quote(),
        deadline: TIMESTAMP_DEADLINE,
        purpose: 'BUILD_POSITION',
        idempotencyKey: 'k',
        guard: GUARD,
      }),
    ).rejects.toThrowError(/needs an attached signer/);
    expect(sent).toEqual([]);
  });

  it('refuses a quote whose tokens are not the pool’s pair', async () => {
    const { adapter, sent } = harness({ contracts: liveContracts(), now: () => NOW });
    await expect(
      adapter.executeSwap({
        quote: quote({ tokenIn: WBNB }),
        deadline: TIMESTAMP_DEADLINE,
        purpose: 'BUILD_POSITION',
        idempotencyKey: 'k',
        guard: GUARD,
      }),
    ).rejects.toThrowError(/neither leg of/);
    expect(sent).toEqual([]);
  });

  it('refuses a quote on a fee tier this DEX does not deploy', async () => {
    const poolCardWithoutFee: Record<string, Hex | 'revert'> = {};
    entry(poolCardWithoutFee, 'slot0()', SLOT0, CLMM_POOL_ABI);
    entry(poolCardWithoutFee, 'liquidity()', LIQUIDITY, CLMM_POOL_ABI);
    // A pool that reports Pancake's 2500: reaching it through this adapter must be refused.
    entry(poolCardWithoutFee, 'fee()', 2500, CLMM_POOL_ABI);
    entry(poolCardWithoutFee, 'tickSpacing()', 50, CLMM_POOL_ABI);
    entry(poolCardWithoutFee, 'token0()', TOKEN0, CLMM_POOL_ABI);
    entry(poolCardWithoutFee, 'token1()', TOKEN1, CLMM_POOL_ABI);
    const { adapter, sent } = harness({
      contracts: liveContracts({ [POOL]: poolCardWithoutFee }),
      now: () => NOW,
    });
    await expect(
      adapter.executeSwap({
        quote: quote(),
        deadline: TIMESTAMP_DEADLINE,
        purpose: 'BUILD_POSITION',
        idempotencyKey: 'k',
        guard: GUARD,
      }),
    ).rejects.toThrowError(/2500/);
    expect(sent).toEqual([]);
  });
});

describe('removeLiquidity and collectFees', () => {
  function positionHarness(liquidity = 123_456n) {
    const managerCard: Record<string, Hex | 'revert'> = {};
    callEntry(
      managerCard,
      'positions(uint256)',
      [4242n],
      [7n, '0x0000000000000000000000000000000000000000', TOKEN0, TOKEN1, FEE, -60, 60, liquidity, 1n, 1n, 0n, 0n],
      POSITION_MANAGER_ABI,
    );
    return harness({ contracts: liveContracts({ [MANAGER]: managerCard }) });
  }

  it('bundles decreaseLiquidity and collect in one manager multicall', async () => {
    const { adapter, sent } = positionHarness();
    const result = await adapter.removeLiquidity({
      poolId: POOL_ID,
      positionTokenId: 4242n,
      liquidityRaw: null,
      amount0MinRaw: 10n,
      amount1MinRaw: 20n,
      recipient: SIGNER.address,
      deadline: TIMESTAMP_DEADLINE,
      idempotencyKey: 'k',
      guard: GUARD,
    });

    expect(result.state).toBe(TX_STATES.SUBMITTED);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to.toLowerCase()).toBe(MANAGER);
    expect(BigInt(sent[0]!.value)).toBe(0n);
    expect(selectorOf(sent[0]!.data)).toBe('0xac9650d8');

    const outer = decodeFunctionData({ abi: UNISWAP_V3_POSITION_MANAGER_ABI, data: sent[0]!.data });
    expect(outer.functionName).toBe('multicall');
    const [inner] = outer.args as readonly [readonly Hex[]];
    // Both calls in one transaction: a bare decrease would leave the principal inside the manager.
    expect(inner).toHaveLength(2);

    const decrease = decodeFunctionData({ abi: UNISWAP_V3_POSITION_MANAGER_ABI, data: inner[0]! });
    expect(decrease.functionName).toBe('decreaseLiquidity');
    const decreaseParams = (decrease.args as readonly [Record<string, unknown>])[0]!;
    expect(decreaseParams.tokenId).toBe(4242n);
    // `null` means "everything", resolved from the position's live liquidity.
    expect(decreaseParams.liquidity).toBe(123_456n);
    expect(decreaseParams.amount0Min).toBe(10n);
    expect(decreaseParams.amount1Min).toBe(20n);
    expect(decreaseParams.deadline).toBe(1_800_000_000n);

    const collect = decodeFunctionData({ abi: UNISWAP_V3_POSITION_MANAGER_ABI, data: inner[1]! });
    expect(collect.functionName).toBe('collect');
    const collectParams = (collect.args as readonly [Record<string, unknown>])[0]!;
    expect(collectParams.tokenId).toBe(4242n);
    expect((collectParams.recipient as string).toLowerCase()).toBe(SIGNER.address.toLowerCase());
    expect(collectParams.amount0Max).toBe(MAX_UINT128);
    expect(collectParams.amount1Max).toBe(MAX_UINT128);
  });

  it('burns exactly the requested liquidity when one is given', async () => {
    const { adapter, sent } = positionHarness(500_000n);
    await adapter.removeLiquidity({
      poolId: POOL_ID,
      positionTokenId: 4242n,
      liquidityRaw: 200_000n,
      amount0MinRaw: 0n,
      amount1MinRaw: 0n,
      recipient: SIGNER.address,
      deadline: TIMESTAMP_DEADLINE,
      idempotencyKey: 'k',
      guard: GUARD,
    });
    const outer = decodeFunctionData({ abi: UNISWAP_V3_POSITION_MANAGER_ABI, data: sent[0]!.data });
    const [inner] = outer.args as readonly [readonly Hex[]];
    const decrease = decodeFunctionData({ abi: UNISWAP_V3_POSITION_MANAGER_ABI, data: inner[0]! });
    expect((decrease.args as readonly [Record<string, unknown>])[0]!.liquidity).toBe(200_000n);
  });

  it('refuses to remove more liquidity than the position holds, or from a position that has none', async () => {
    const { adapter, sent } = positionHarness(100n);
    const base = {
      poolId: POOL_ID,
      positionTokenId: 4242n,
      amount0MinRaw: 0n,
      amount1MinRaw: 0n,
      recipient: SIGNER.address,
      deadline: TIMESTAMP_DEADLINE,
      idempotencyKey: 'k',
      guard: GUARD,
    };
    // decreaseLiquidity would revert; the adapter says so up front.
    await expect(adapter.removeLiquidity({ ...base, liquidityRaw: 101n })).rejects.toThrowError(
      /holds 100 liquidity but 101 was requested/,
    );

    const empty = positionHarness(0n);
    await expect(empty.adapter.removeLiquidity({ ...base, liquidityRaw: null })).rejects.toThrowError(
      /no liquidity to burn/,
    );
    expect(sent).toEqual([]);
    expect(empty.sent).toEqual([]);
  });

  it('refuses a poolId that does not name the position’s own pool', async () => {
    const { adapter, sent } = positionHarness();
    await expect(
      adapter.removeLiquidity({
        // A syntactically valid §13 id for a pool this position does not belong to.
        poolId: `56:${DEX_IDS.UNISWAP_V3}:${POOL}`.replace(POOL, WBNB),
        positionTokenId: 4242n,
        liquidityRaw: null,
        amount0MinRaw: 0n,
        amount1MinRaw: 0n,
        recipient: SIGNER.address,
        deadline: TIMESTAMP_DEADLINE,
        idempotencyKey: 'k',
        guard: GUARD,
      }),
    ).rejects.toThrowError(/does not belong to/);
    expect(sent).toEqual([]);
  });

  it('refuses to collect fees into the zero address rather than burning them', async () => {
    const { adapter, sent } = positionHarness();
    await expect(
      adapter.collectFees({
        poolId: POOL_ID,
        positionTokenId: 4242n,
        recipient: '0x0000000000000000000000000000000000000000',
        idempotencyKey: 'k',
        guard: GUARD,
      }),
    ).rejects.toThrowError(/zero address/);
    expect(sent).toEqual([]);
  });

  it('refuses to remove from a position the manager does not know', async () => {
    const managerCard: Record<string, Hex | 'revert'> = {};
    entry(managerCard, 'positions(uint256)', 'revert', POSITION_MANAGER_ABI);
    const { adapter, sent } = harness({ contracts: liveContracts({ [MANAGER]: managerCard }) });
    await expect(
      adapter.removeLiquidity({
        poolId: POOL_ID,
        positionTokenId: 999n,
        liquidityRaw: null,
        amount0MinRaw: 0n,
        amount1MinRaw: 0n,
        recipient: SIGNER.address,
        deadline: TIMESTAMP_DEADLINE,
        idempotencyKey: 'k',
        guard: GUARD,
      }),
    ).rejects.toThrowError(/does not exist/);
    expect(sent).toEqual([]);
  });

  it('collects fees with max maxima to the requested recipient', async () => {
    const { adapter, sent } = positionHarness();
    const result = await adapter.collectFees({
      poolId: POOL_ID,
      positionTokenId: 4242n,
      recipient: SIGNER.address,
      idempotencyKey: 'k',
      guard: GUARD,
    });

    expect(result.state).toBe(TX_STATES.SUBMITTED);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to.toLowerCase()).toBe(MANAGER);
    expect(selectorOf(sent[0]!.data)).toBe('0xfc6f7865');
    const decoded = decodeFunctionData({ abi: UNISWAP_V3_POSITION_MANAGER_ABI, data: sent[0]!.data });
    const params = (decoded.args as readonly [Record<string, unknown>])[0]!;
    expect(params.tokenId).toBe(4242n);
    expect(params.amount0Max).toBe(MAX_UINT128);
    expect(params.amount1Max).toBe(MAX_UINT128);
  });
});

describe('fee→tickSpacing isolation between the two DEXes', () => {
  it('3000 maps to 60 on Uniswap and is an error on Pancake', () => {
    expect(tickSpacingFor(DEX_IDS.UNISWAP_V3, 3000)).toBe(60);
    expect(() => tickSpacingFor(DEX_IDS.PANCAKESWAP_V3, 3000)).toThrow();
  });

  it('2500 maps to 50 on Pancake and is an error on Uniswap', () => {
    expect(tickSpacingFor(DEX_IDS.PANCAKESWAP_V3, 2500)).toBe(50);
    expect(() => tickSpacingFor(DEX_IDS.UNISWAP_V3, 2500)).toThrow();
  });

  it('the shared tiers agree while the exclusive tiers stay exclusive', () => {
    for (const fee of [100, 500, 10_000]) {
      expect(tickSpacingFor(DEX_IDS.UNISWAP_V3, fee)).toBe(tickSpacingFor(DEX_IDS.PANCAKESWAP_V3, fee));
    }
    // The two exclusive tiers map to different grids, which is exactly why a bare fee tier cannot
    // name a pool (§13) and why the mapping has to be per-DEX.
    expect(tickSpacingFor(DEX_IDS.UNISWAP_V3, 3000)).not.toBe(tickSpacingFor(DEX_IDS.PANCAKESWAP_V3, 2500));
  });
});
