/**
 * `PancakeV3Adapter` — offline tests over the repository's mock JSON-RPC node.
 *
 * Everything here is deterministic and offline: the mock node answers `eth_call` from fixed calldata
 * tables and records every outbound transaction, and no test reaches the network. The
 * `slot0`/liquidity/reserve/quoter fixtures are the **real** values read from BSC for QQQB/USDT @
 * PancakeSwap V3 (`0xe531fcb1f5a195de7608b9f4f9518544c2cdb693`) while writing `scripts/smoke-quote.ts`,
 * so a decode or price regression shows up as a wrong number rather than as a green test.
 *
 * The properties that motivated this file:
 * - §39/§40/§41: the quote comes from the real QuoterV2 fixture, `expiresAt` is derived from an
 *   injected clock, and `priceImpact` is computed **locally** (the SmartRouter cannot enforce it, so a
 *   fabricated or SDK-supplied number would pass the gate on invented data);
 * - §42: an atomic build is exactly ONE send, to the SmartRouter. A second send — or a downgrade to
 *   swap-then-add — is the failure this suite exists to catch.
 */
import { describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeFunctionData, parseTransaction } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { nonfungiblePositionManagerABI, quoterV2ABI, swapRouterABI } from '@pancakeswap/v3-sdk';
import { SMART_ROUTER_ADDRESSES, SwapRouter } from '@pancakeswap/smart-router';
import { BscChainAdapter } from '../../src/chain/adapter.ts';
import { CLMM_FACTORY_ABI, POSITION_MANAGER_ABI } from '../../src/chain/abis.ts';
import { CHAIN_ERROR_CODES, TxGuardError } from '../../src/chain/errors.ts';
import { sqrtPriceX96ToPrice } from '../../src/chain/poolReader.ts';
import { handlerTransport } from '../../src/chain/rpc.ts';
import { BSC_ADDRESSES, BSC_DEX_CONTRACTS } from '../../src/config/builtins.ts';
import { createWhitelist, defaultDexWhitelist } from '../../src/config/index.ts';
import { createBuiltinRegistry } from '../../src/config/registry.ts';
import { PancakeV3Adapter, createPancakeV3Adapter } from '../../src/dex/pancakeV3.ts';
import type { DexAdapterFactoryOptions } from '../../src/dex/index.ts';
import { evaluateSwapQuote } from '../../src/strategy/swapPlanner.ts';
import { applyFloorRatio, toFloat } from '../../src/util/decimal.ts';
import {
  APPROVAL_TYPES,
  TX_STATES,
  type SwapQuote,
  type TxGuardChecks,
} from '../../src/types/adapters.ts';
import {
  DEX_IDS,
  type Address,
  type Hex,
  type PoolId,
} from '../../src/types/primitives.ts';
import { WhitelistError } from '../../src/types/registry.ts';
import { callEntry, createMockNode, entry, type MockNodeOptions } from '../chain/mockNode.ts';

const QQQB = '0x205812cdbed920aff76c6580abd681a46d11efc7' as Address;
const USDT = BSC_ADDRESSES.USDT as Address;
/** QQQB/USDT 0.01% @ PancakeSwap V3 (research §4.1). */
const POOL = '0xe531fcb1f5a195de7608b9f4f9518544c2cdb693' as Address;
const POOL_ID: PoolId = `56:${DEX_IDS.PANCAKESWAP_V3}:${POOL}`;
const PANCAKE = BSC_DEX_CONTRACTS[DEX_IDS.PANCAKESWAP_V3]!;
const SMART_ROUTER = SMART_ROUTER_ADDRESSES[56]!;
/** A dedicated strategy wallet; used only as an address, never as real key material. */
const SIGNER = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');

/** Real `slot0()` of the QQQB/USDT pool: sqrtPriceX96, tick, obsIndex, cardinality, next, feeProtocol, unlocked. */
const SLOT0 = [
  2_154_832_704_108_376_564_407_394_197_159n,
  66_066,
  3_003,
  5_000,
  5_000,
  0,
  true,
] as const;
const ACTIVE_LIQUIDITY = 1_557_017_887_507_467_409_007_769n;
const RESERVE0 = 441_375_877_466_074_801_295n;
const RESERVE1 = 296_192_032_576_361_570_143_569n;
/**
 * The pool's `slot0` price, USDT per QQQB (both legs 18 decimals), derived with the same function the
 * adapter uses so the impact assertion below is exact rather than a rounded comparison.
 */
const MID_PRICE = sqrtPriceX96ToPrice(SLOT0[0], 18, 18);

/** 1000 USDT raw — the trade `scripts/smoke-quote.ts` performs. */
const AMOUNT_IN = 1_000n * 10n ** 18n;
const TTL_SECONDS = 30;
/** The real QuoterV2 answer for that trade, read from BSC. */
const AMOUNT_OUT = 1_351_716_649_572_231_657n;

const FIXED_NOW = new Date('2026-09-29T13:22:07.471Z');
const TIMESTAMP_DEADLINE = { kind: 'timestamp', unixSeconds: 1_800_000_000 } as const;
const BLOCKHASH_DEADLINE = {
  kind: 'previous-blockhash',
  blockhash: `0x${'ab'.repeat(32)}` as Hex,
} as const;

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

/** A §95 guard; `overrides` with a `false` produces an `ok: false` guard. */
function guard(overrides: Partial<Record<keyof typeof ALL_OK, boolean>> = {}): TxGuardChecks {
  const merged = { ...ALL_OK, ...overrides };
  const failures = Object.entries(merged)
    .filter(([, value]) => value !== true)
    .map(([key]) => key);
  return { ...merged, ok: failures.length === 0, failures };
}

/** The deployed v3 router/NPM ABIs, used to build fixtures and to decode what the adapter sent. */
const V3_SWAP_ROUTER_ABI = swapRouterABI;
const V3_POSITION_MANAGER_ABI = nonfungiblePositionManagerABI;

/** `positions(tokenId)` tuple as the manager returns it (nonce … tokensOwed). */
const POSITION_TUPLE = [
  7n,
  '0x0000000000000000000000000000000000000000',
  QQQB,
  USDT,
  100,
  63_600,
  67_200,
  9_876_543_210_000n,
  115_792_089_237_316_195_423_570_985_008_687_907_853n,
  340_282_366_920_938_463_463_374_607_431_768_211n,
  1_500_000_000_000_000_000n,
  2_250_000_000_000_000_000n,
] as const;

/** `quoteExactInputSingle` fixture, keyed by full calldata so a wrong argument list cannot pass. */
function quoterCard(input: {
  readonly tokenIn?: Address;
  readonly tokenOut?: Address;
  readonly amountIn?: bigint;
  readonly amountOut: bigint;
}): Record<string, Hex | 'revert'> {
  return callEntry(
    {},
    'quoteExactInputSingle((address,address,uint256,uint24,uint160))',
    [
      {
        tokenIn: input.tokenIn ?? USDT,
        tokenOut: input.tokenOut ?? QQQB,
        amountIn: input.amountIn ?? AMOUNT_IN,
        fee: 100,
        sqrtPriceLimitX96: 0n,
      },
    ],
    [input.amountOut, SLOT0[0], 0, 113_899n],
    quoterV2ABI,
  );
}

/** Contract table for the QQQB/USDT pool, the factory, the quoter and both reserve reads. */
function chainContracts(
  options: {
    readonly amountOut?: bigint;
    readonly quote?: { readonly tokenIn: Address; readonly tokenOut: Address; readonly amountIn: bigint };
    readonly poolForPair?: Address | 'revert';
    readonly fee?: number;
    readonly tickSpacing?: number;
    readonly positionManager?: Address;
    readonly positionReverts?: boolean;
  } = {},
): NonNullable<MockNodeOptions['contracts']> {
  const poolCard: Record<string, Hex | 'revert'> = {};
  entry(poolCard, 'slot0()', SLOT0);
  entry(poolCard, 'liquidity()', ACTIVE_LIQUIDITY);
  entry(poolCard, 'fee()', options.fee ?? 100);
  entry(poolCard, 'tickSpacing()', options.tickSpacing ?? 1);
  entry(poolCard, 'token0()', QQQB);
  entry(poolCard, 'token1()', USDT);

  const factoryCard: Record<string, Hex | 'revert'> = {};
  entry(
    factoryCard,
    'getPool(address,address,uint24)',
    options.poolForPair ?? POOL,
    CLMM_FACTORY_ABI,
  );

  const contracts: NonNullable<MockNodeOptions['contracts']> = {
    [POOL]: poolCard,
    [PANCAKE.factory]: factoryCard,
    [PANCAKE.quoterV2]: quoterCard({
      amountOut: options.amountOut ?? AMOUNT_OUT,
      ...(options.quote ?? {}),
    }),
    [QQQB]: callEntry({}, 'balanceOf(address)', [POOL], RESERVE0),
    [USDT]: callEntry({}, 'balanceOf(address)', [POOL], RESERVE1),
  };

  if (options.positionManager !== undefined) {
    const manager: Record<string, Hex | 'revert'> = {};
    if (options.positionReverts === true) {
      entry(manager, 'positions(uint256)', 'revert', V3_POSITION_MANAGER_ABI);
    } else {
      callEntry(manager, 'positions(uint256)', [7n], POSITION_TUPLE, V3_POSITION_MANAGER_ABI);
    }
    callEntry(manager, 'ownerOf(uint256)', [7n], SIGNER.address, V3_POSITION_MANAGER_ABI);
    contracts[options.positionManager] = manager;
  }
  return contracts;
}

/** One transaction the signer produced. Captured from the mock's send methods. */
interface SentTx {
  readonly to: string;
  readonly data: Hex;
  readonly value: bigint;
}

interface Harness {
  readonly dex: PancakeV3Adapter;
  readonly node: ReturnType<typeof createMockNode>;
  readonly sent: SentTx[];
  readonly options: DexAdapterFactoryOptions;
}

function harness(
  options: {
    readonly contracts?: NonNullable<MockNodeOptions['contracts']>;
    readonly withSigner?: boolean;
    readonly whitelist?: DexAdapterFactoryOptions['whitelist'];
    readonly now?: () => Date;
  } = {},
): Harness {
  const sent: SentTx[] = [];
  const record = (params: readonly unknown[]): Hex => {
    const raw = String(params[0]);
    // viem may sign locally (`eth_sendRawTransaction`) or delegate (`eth_sendTransaction`); record
    // whichever shape arrives so the assertions look at the transaction that would reach the mempool.
    if (raw.startsWith('0x02') || raw.startsWith('0x01') || raw.length > 200) {
      const parsed = parseTransaction(raw as Hex);
      sent.push({
        to: String(parsed.to ?? '').toLowerCase(),
        data: (parsed.data ?? '0x') as Hex,
        value: parsed.value ?? 0n,
      });
      return `0x${'11'.repeat(32)}`;
    }
    const tx = params[0] as { to: string; data: Hex; value?: Hex };
    sent.push({ to: String(tx.to).toLowerCase(), data: tx.data, value: BigInt(tx.value ?? '0x0') });
    return `0x${'22'.repeat(32)}`;
  };

  const node = createMockNode({
    contracts: options.contracts ?? chainContracts(),
    extra: {
      // viem's wallet client needs a nonce before it can broadcast.
      eth_getTransactionCount: () => '0x0',
      eth_sendRawTransaction: record,
      eth_sendTransaction: record,
    },
  });
  const whitelist =
    options.whitelist ??
    createWhitelist(createBuiltinRegistry().list(), [56], defaultDexWhitelist([56]));
  const chain = new BscChainAdapter({
    chainId: 56,
    whitelist,
    ...(options.withSigner === false ? {} : { account: SIGNER }),
    rpc: {
      endpoints: [{ label: 'n1', url: 'mock://n1' }],
      transportFactory: () => handlerTransport(node.handle),
      retries: 0,
      crossCheckEndpoints: 1,
    },
  });
  const factoryOptions: DexAdapterFactoryOptions = {
    chainId: 56,
    whitelist,
    chain,
    slippageTolerance: 0.003,
    now: options.now ?? (() => FIXED_NOW),
  };
  return { dex: createPancakeV3Adapter(factoryOptions), node, sent, options: factoryOptions };
}

function quoteFor(
  dex: PancakeV3Adapter,
  overrides: Partial<{ amountIn: bigint; tokenIn: Address; tokenOut: Address }> = {},
): Promise<SwapQuote> {
  return dex.quoteSwap({
    poolId: POOL_ID,
    tokenIn: overrides.tokenIn ?? USDT,
    tokenOut: overrides.tokenOut ?? QQQB,
    amountIn: overrides.amountIn ?? AMOUNT_IN,
    ttlSeconds: TTL_SECONDS,
  });
}

const ADD_LIQUIDITY_BASE = {
  poolId: POOL_ID,
  tickRange: { lowerTick: 65_600, upperTick: 66_400, tickSpacing: 1 },
  amount0DesiredRaw: 1_351_716_649_572_231_657n,
  amount1DesiredRaw: 1_000_000_000_000_000_000_000n,
  amount0MinRaw: 1_340_000_000_000_000_000n,
  amount1MinRaw: 990_000_000_000_000_000_000n,
  recipient: SIGNER.address,
  deadline: TIMESTAMP_DEADLINE,
  idempotencyKey: 'build#1#add',
} as const;


describe('§82 identity and §12 whitelist', () => {
  it('advertises PancakeSwap V3 and the §42 atomic capability', () => {
    const { dex } = harness();
    expect(dex.dex).toBe(DEX_IDS.PANCAKESWAP_V3);
    expect(dex.chainId).toBe(56);
    // The whole reason two adapters exist: this one CAN combine swap+mint, the Uniswap one cannot.
    expect(dex.supportsAtomicBuild).toBe(true);
  });

  it('throws at construction when the DEX is not whitelisted for the chain', () => {
    const whitelist = createWhitelist(createBuiltinRegistry().list(), [56], []);
    expect(() => harness({ whitelist })).toThrowError(WhitelistError);
  });

  it('assertWhitelisted() re-checks at call time, not only at construction', () => {
    // A whitelist that starts complete and then revokes the DEX: the adapter is already constructed, so
    // only the method's own check can catch it. `createWhitelist` closes over its inputs, hence the
    // wrapper — which also proves the adapter consults the injected object rather than a copy.
    const { dex, options } = harness();
    let revoked = false;
    const revocable: DexAdapterFactoryOptions['whitelist'] = {
      ...options.whitelist,
      assertWhitelistedDex(chainId, dexId) {
        if (revoked) throw new WhitelistError(`DEX ${dexId} is no longer whitelisted`, { chainId, dex: dexId });
        options.whitelist.assertWhitelistedDex(chainId, dexId);
      },
    };
    const adapter = new PancakeV3Adapter({ ...options, whitelist: revocable });
    expect(() => adapter.assertWhitelisted()).not.toThrow();
    revoked = true;
    expect(() => adapter.assertWhitelisted()).toThrowError(WhitelistError);
    expect(dex.dex).toBe(DEX_IDS.PANCAKESWAP_V3);
  });

  it('refuses a chain layer bound to a different chain than the options', () => {
    const { options } = harness();
    expect(() => new PancakeV3Adapter({ ...options, chainId: 97 })).toThrowError(
      /chain layer bound to 56|refusing to construct/u,
    );
  });
});

describe('§82 read-only surface', () => {
  it('resolves a pool through factory.getPool in the pool’s canonical token order', async () => {
    const { dex } = harness();
    const pool = await dex.getPool(QQQB, USDT, 100);
    expect(pool).not.toBeNull();
    // `poolAddress` is returned EIP-55 checksummed (canonical display form); identities in this repo
    // are compared case-insensitively, which is why the §13 `poolId` below is lowercase.
    expect(pool!.poolAddress.toLowerCase()).toBe(POOL);
    expect(pool!.poolId).toBe(POOL_ID);
    // Returned checksummed; compare case-insensitively (identity in this repo is the address).
    expect(pool!.token0.toLowerCase()).toBe(QQQB);
    expect(pool!.token1.toLowerCase()).toBe(USDT);
    expect(pool!.feeTier).toBe(100);
    expect(pool!.tickSpacing).toBe(1);
  });

  it('reports a zero-address factory answer as a proven absence (null), never as an error', async () => {
    const { dex } = harness({
      contracts: chainContracts({ poolForPair: '0x0000000000000000000000000000000000000000' }),
    });
    expect(await dex.getPool(QQQB, USDT, 100)).toBeNull();
  });

  it('does not report a reverting factory probe as an absent pool', async () => {
    const { dex } = harness({ contracts: chainContracts({ poolForPair: 'revert' }) });
    await expect(dex.getPool(QQQB, USDT, 100)).rejects.toMatchObject({
      code: CHAIN_ERROR_CODES.RPC_NODE_ERROR,
    });
  });

  it('reads price, tick and liquidity from the live pool state', async () => {
    const { dex } = harness();
    const price = await dex.getPoolPrice(POOL);
    expect(price.tick).toBe(SLOT0[1]);
    expect(price.sqrtPriceX96).toBe(SLOT0[0]);
    expect(price.liquidity).toBe(ACTIVE_LIQUIDITY);
    expect(price.feeTier).toBe(100);
    expect(price.tickSpacing).toBe(1);
    expect(price.priceToken1PerToken0).toBeCloseTo(739.721002, 6);
    expect(await dex.getLiquidity(POOL)).toBe(ACTIVE_LIQUIDITY);
    expect(await dex.getTick(POOL)).toBe(SLOT0[1]);
  });
});

describe('§39/§40/§41 quoteSwap', () => {
  it('derives the whole §41 window from the injected clock', async () => {
    const { dex } = harness();
    const quote = await quoteFor(dex);

    expect(quote.amountOutRaw).toBe(AMOUNT_OUT);
    expect(quote.amountInRaw).toBe(AMOUNT_IN);
    expect(quote.quotedAt).toBe(FIXED_NOW.toISOString());
    expect(quote.expiresAt).toBe(new Date(FIXED_NOW.getTime() + TTL_SECONDS * 1000).toISOString());
    expect(Date.parse(quote.expiresAt) - Date.parse(quote.quotedAt)).toBe(TTL_SECONDS * 1000);
    expect(quote.slippageTolerance).toBe(0.003);
    expect(quote.amountOutMinimumRaw).toBe(applyFloorRatio(AMOUNT_OUT, 1 - 0.003));
    // Floor, never a rounded-up minimum: one wei too high is a revert.
    expect(quote.amountOutMinimumRaw).toBeLessThan(AMOUNT_OUT);
    expect(quote.route).toEqual(['USDT/QQQB 0.01%']);
    // USDT is the input leg and is a whitelisted stablecoin, so the notional is exact.
    expect(quote.amountInUsd).toBeCloseTo(1000, 6);
  });

  it('floors the minimum by the tolerance rather than scaling by a float', async () => {
    const { dex } = harness();
    const quote = await quoteFor(dex);
    // Integer identity: the minimum is exactly floor(out * (1 - tolerance)) at 1e-9 resolution.
    expect(quote.amountOutMinimumRaw).toBe((AMOUNT_OUT * 997_000_000n) / 1_000_000_000n);
  });

  it('computes priceImpact locally from the pool mid price, not from the SDK', async () => {
    const { dex } = harness();
    const quote = await quoteFor(dex);
    // `computePriceImpact` expresses the executed rate in the pool's own orientation (token1 per
    // token0), so the trade's rate is `amountIn/amountOut` here — the same direction as the mid price.
    const executed = toFloat(AMOUNT_IN, 18) / toFloat(AMOUNT_OUT, 18);
    expect(quote.priceImpact).toBeCloseTo(Math.abs(executed - MID_PRICE) / MID_PRICE, 12);
    expect(quote.priceImpact).toBeGreaterThan(0);
  });

  it('raises the computed impact when the execution price worsens (the monotonicity §40 relies on)', async () => {
    const quote = await quoteFor(harness().dex);
    const { dex } = harness({ contracts: chainContracts({ amountOut: AMOUNT_OUT / 2n }) });
    const worse = await quoteFor(dex);
    expect(worse.priceImpact).toBeGreaterThan(quote.priceImpact);
  });

  it('lets evaluateSwapQuote reject a >0.5% impact quote the SDK itself would have allowed', async () => {
    // A 1.5% worse execution price than the mid: well inside any sane slippage bound, outside §40's cap.
    const { dex } = harness({
      contracts: chainContracts({ amountOut: (AMOUNT_OUT * 985n) / 1000n }),
    });
    const quote = await quoteFor(dex);
    expect(quote.priceImpact).toBeGreaterThan(0.005);

    const verdict = evaluateSwapQuote(
      quote,
      {
        maxSlippage: 0.003,
        maxPriceImpact: 0.005,
        quoteTtlSeconds: 30,
        liquidityRiskPriceImpact: 0.01,
      },
      quote.quotedAt,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.some((reason) => reason.startsWith('price_impact_exceeded'))).toBe(true);
  });

  it('rejects a quote for a token pair the pool does not hold', async () => {
    const { dex } = harness();
    await expect(
      dex.quoteSwap({
        poolId: POOL_ID,
        tokenIn: BSC_ADDRESSES.USDC,
        tokenOut: QQQB,
        amountIn: AMOUNT_IN,
        ttlSeconds: TTL_SECONDS,
      }),
    ).rejects.toMatchObject({ code: CHAIN_ERROR_CODES.INVALID_ARGUMENT });
  });

  it('rejects a poolId for another DEX or chain instead of guessing the pool', async () => {
    const { dex } = harness();
    await expect(
      dex.quoteSwap({
        poolId: `56:${DEX_IDS.UNISWAP_V3}:${POOL}`,
        tokenIn: USDT,
        tokenOut: QQQB,
        amountIn: AMOUNT_IN,
        ttlSeconds: TTL_SECONDS,
      }),
    ).rejects.toMatchObject({ code: CHAIN_ERROR_CODES.DEX_NOT_WHITELISTED });
  });
});

describe('§95 the guard is the first thing every write checks', () => {
  const closed = guard({ toWhitelisted: false });

  it('refuses executeSwap with zero encoding and zero sends', async () => {
    const { dex, node, sent } = harness();
    const quote = await quoteFor(dex);
    const before = node.calls.length;
    await expect(
      dex.executeSwap({
        quote,
        deadline: TIMESTAMP_DEADLINE,
        purpose: 'BUILD_POSITION',
        idempotencyKey: 'swap#1',
        guard: closed,
      }),
    ).rejects.toBeInstanceOf(TxGuardError);
    expect(node.calls.length).toBe(before);
    expect(sent).toHaveLength(0);
  });

  it('refuses addLiquidity with zero encoding and zero sends', async () => {
    const { dex, node, sent } = harness();
    const before = node.calls.length;
    await expect(
      dex.addLiquidity({ ...ADD_LIQUIDITY_BASE, guard: closed }),
    ).rejects.toBeInstanceOf(TxGuardError);
    expect(node.calls.length).toBe(before);
    expect(sent).toHaveLength(0);
  });

  it('refuses an atomic addLiquidity with zero encoding and zero sends', async () => {
    const { dex, node, sent } = harness();
    const quote = await quoteFor(dex);
    const before = node.calls.length;
    await expect(
      dex.addLiquidity({
        ...ADD_LIQUIDITY_BASE,
        deadline: BLOCKHASH_DEADLINE,
        guard: closed,
        swapForDeficit: { quote, atomic: true },
      }),
    ).rejects.toBeInstanceOf(TxGuardError);
    expect(node.calls.length).toBe(before);
    expect(sent).toHaveLength(0);
  });

  it('refuses removeLiquidity with zero encoding and zero sends', async () => {
    const { dex, node, sent } = harness();
    const before = node.calls.length;
    await expect(
      dex.removeLiquidity({
        poolId: POOL_ID,
        positionTokenId: 7n,
        liquidityRaw: 123n,
        amount0MinRaw: 0n,
        amount1MinRaw: 0n,
        recipient: SIGNER.address,
        deadline: TIMESTAMP_DEADLINE,
        idempotencyKey: 'remove#1',
        guard: closed,
      }),
    ).rejects.toBeInstanceOf(TxGuardError);
    expect(node.calls.length).toBe(before);
    expect(sent).toHaveLength(0);
  });

  it('refuses collectFees with zero encoding and zero sends', async () => {
    const { dex, node, sent } = harness();
    const before = node.calls.length;
    await expect(
      dex.collectFees({
        poolId: POOL_ID,
        positionTokenId: 7n,
        recipient: SIGNER.address,
        idempotencyKey: 'collect#1',
        guard: closed,
      }),
    ).rejects.toBeInstanceOf(TxGuardError);
    expect(node.calls.length).toBe(before);
    expect(sent).toHaveLength(0);
  });

  it('refuses to write at all when no signer is attached (§94)', async () => {
    const { dex, node, sent } = harness({ withSigner: false });
    const before = node.calls.length;
    await expect(
      dex.addLiquidity({ ...ADD_LIQUIDITY_BASE, guard: guard() }),
    ).rejects.toMatchObject({ code: CHAIN_ERROR_CODES.INVALID_ARGUMENT });
    expect(node.calls.length).toBe(before);
    expect(sent).toHaveLength(0);
  });
});

describe('§42 the atomic build is exactly one send', () => {
  it('combines swap + addLiquidity into ONE SmartRouter transaction', async () => {
    const { dex, sent } = harness();
    const quote = await quoteFor(dex);

    const result = await dex.addLiquidity({
      ...ADD_LIQUIDITY_BASE,
      deadline: BLOCKHASH_DEADLINE,
      guard: guard(),
      swapForDeficit: { quote, atomic: true },
    });

    expect(result.state).toBe(TX_STATES.SUBMITTED);
    expect(result.liquidity).toBeGreaterThan(0n);
    // The §42 guarantee: one transaction. A second send would mean the build was split.
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(SMART_ROUTER.toLowerCase());
    expect(sent[0]!.value).toBe(0n);
  });

  it('encodes the atomic call as multicall(bytes32 previousBlockhash, bytes[]) with the expected legs', async () => {
    const { dex, sent } = harness();
    const quote = await quoteFor(dex);
    await dex.addLiquidity({
      ...ADD_LIQUIDITY_BASE,
      deadline: BLOCKHASH_DEADLINE,
      guard: guard(),
      swapForDeficit: { quote, atomic: true },
    });

    const data = sent[0]!.data;
    // `multicall(bytes32,bytes[])` — the drift-immune overload, present in the deployed SmartRouter.
    expect(data.slice(0, 10)).toBe('0x1f0464d1');

    const decoded = decodeFunctionData({ abi: SwapRouter.ABI, data });
    expect(decoded.functionName).toBe('multicall');
    const inner = (decoded.args as readonly (readonly Hex[])[])[1]!;
    expect(inner.map((call) => call.slice(0, 10))).toEqual([
      '0x04e45aaf', // exactInputSingle, router-must-custody variant
      '0xf2d5d56b', // pull(address,uint256) — top the position up
      '0x639d71a9', // approveZeroThenMax(address) — USDT
      '0x571ac8b0', // approveMax(address) — QQQB
      '0x11ed56c9', // IApproveAndCall.mint
      '0xe90a182f', // sweepToken(address,uint256)
      '0xe90a182f',
    ]);
    // The swap leg carries the on-chain slippage bound; that is the one §40 constraint the SDK can
    // express, and the impact bound must have been applied separately before encoding.
    expect(inner[0]!.length).toBeGreaterThan(200);
  });

  it('targets the SmartRouter address the SDK itself reports for chain 56 (no invented address)', () => {
    expect(SMART_ROUTER.toLowerCase()).toBe('0x13f4ea83d0bd40e75c8222255bc855a974568dd4');
  });

  it('refuses an atomic build whose deficit swap is quoted on a different pool', async () => {
    const { dex, sent } = harness();
    const quote = await quoteFor(dex);
    await expect(
      dex.addLiquidity({
        ...ADD_LIQUIDITY_BASE,
        deadline: BLOCKHASH_DEADLINE,
        guard: guard(),
        swapForDeficit: {
          quote: {
            ...quote,
            poolId: `56:${DEX_IDS.PANCAKESWAP_V3}:0x47bc06722295ac316a569eef87ac32faa455f441`,
          },
          atomic: true,
        },
      }),
    ).rejects.toMatchObject({ code: CHAIN_ERROR_CODES.INVALID_ARGUMENT });
    expect(sent).toHaveLength(0);
  });

  it('refuses an atomic build with a non-positive swap amount instead of encoding it', async () => {
    const { dex, sent } = harness();
    const quote = await quoteFor(dex);
    await expect(
      dex.addLiquidity({
        ...ADD_LIQUIDITY_BASE,
        deadline: BLOCKHASH_DEADLINE,
        guard: guard(),
        swapForDeficit: { quote: { ...quote, amountInRaw: 0n }, atomic: true },
      }),
    ).rejects.toMatchObject({ code: CHAIN_ERROR_CODES.INVALID_ARGUMENT });
    expect(sent).toHaveLength(0);
  });

  it('refuses an atomic build whose desired amounts yield zero liquidity', async () => {
    const { dex, sent } = harness();
    const quote = await quoteFor(dex);
    await expect(
      dex.addLiquidity({
        ...ADD_LIQUIDITY_BASE,
        deadline: BLOCKHASH_DEADLINE,
        // The range sits entirely below the current tick (66_066), so the position is all token1 and one
        // wei of each leg cannot fund a single unit of liquidity: `L` is zero and the mint would revert
        // with ZERO_LIQUIDITY.
        tickRange: { lowerTick: 100, upperTick: 50_000, tickSpacing: 1 },
        amount0DesiredRaw: 1n,
        amount1DesiredRaw: 1n,
        guard: guard(),
        swapForDeficit: { quote, atomic: true },
      }),
    ).rejects.toMatchObject({ code: CHAIN_ERROR_CODES.INVALID_ARGUMENT });
    expect(sent).toHaveLength(0);
  });

  it('refuses a blockhash deadline that is not 32 bytes', async () => {
    const { dex, sent } = harness();
    const quote = await quoteFor(dex);
    await expect(
      dex.addLiquidity({
        ...ADD_LIQUIDITY_BASE,
        deadline: { kind: 'previous-blockhash', blockhash: '0xdead' as Hex },
        guard: guard(),
        swapForDeficit: { quote, atomic: true },
      }),
    ).rejects.toMatchObject({ code: CHAIN_ERROR_CODES.INVALID_ARGUMENT });
    expect(sent).toHaveLength(0);
  });
});

describe('§33-§38 plain add liquidity', () => {
  it('mints on the NPM with the request’s own minimums, in one send', async () => {
    const { dex, sent } = harness();
    const result = await dex.addLiquidity({ ...ADD_LIQUIDITY_BASE, guard: guard() });
    expect(result.state).toBe(TX_STATES.SUBMITTED);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(PANCAKE.positionManager.toLowerCase());

    const decoded = decodeFunctionData({ abi: V3_POSITION_MANAGER_ABI, data: sent[0]!.data });
    expect(decoded.functionName).toBe('mint');
    const params = (decoded.args as readonly Record<string, unknown>[])[0]!;
    expect(params['amount0Min']).toBe(ADD_LIQUIDITY_BASE.amount0MinRaw);
    expect(params['amount1Min']).toBe(ADD_LIQUIDITY_BASE.amount1MinRaw);
    expect(params['amount0Desired']).toBe(ADD_LIQUIDITY_BASE.amount0DesiredRaw);
    expect(params['recipient']).toBe(SIGNER.address);
    expect(params['tickLower']).toBe(65_600);
    expect(params['tickUpper']).toBe(66_400);
  });

  it('rejects a range whose ticks are not aligned to the pool’s tick spacing', async () => {
    const { dex, sent } = harness({ contracts: chainContracts({ fee: 500, tickSpacing: 10 }) });
    await expect(
      dex.addLiquidity({
        ...ADD_LIQUIDITY_BASE,
        tickRange: { lowerTick: 63_601, upperTick: 67_200, tickSpacing: 10 },
        guard: guard(),
      }),
    ).rejects.toMatchObject({ code: CHAIN_ERROR_CODES.INVALID_ARGUMENT });
    expect(sent).toHaveLength(0);
  });

  it('rejects a range planned against a different DEX’s grid', async () => {
    const { dex, sent } = harness({ contracts: chainContracts({ fee: 500, tickSpacing: 10 }) });
    await expect(
      dex.addLiquidity({
        ...ADD_LIQUIDITY_BASE,
        tickRange: { lowerTick: 63_600, upperTick: 67_200, tickSpacing: 60 },
        guard: guard(),
      }),
    ).rejects.toMatchObject({ code: CHAIN_ERROR_CODES.INVALID_ARGUMENT });
    expect(sent).toHaveLength(0);
  });

  it('refuses a range whose requested spacing disagrees with the fee tier table', async () => {
    const { dex, sent } = harness({ contracts: chainContracts({ fee: 500, tickSpacing: 1 }) });
    await expect(
      dex.addLiquidity({
        ...ADD_LIQUIDITY_BASE,
        tickRange: { lowerTick: 63_600, upperTick: 67_200, tickSpacing: 1 },
        guard: guard(),
      }),
    ).rejects.toMatchObject({ code: CHAIN_ERROR_CODES.DECODE_FAILED });
    expect(sent).toHaveLength(0);
  });

  it('refuses a previous-blockhash deadline that the NPM cannot encode', async () => {
    const { dex, sent } = harness();
    await expect(
      dex.addLiquidity({ ...ADD_LIQUIDITY_BASE, deadline: BLOCKHASH_DEADLINE, guard: guard() }),
    ).rejects.toMatchObject({ code: CHAIN_ERROR_CODES.INVALID_ARGUMENT });
    expect(sent).toHaveLength(0);
  });

  it('refuses an inverted or empty range', async () => {
    const { dex, sent } = harness();
    await expect(
      dex.addLiquidity({
        ...ADD_LIQUIDITY_BASE,
        tickRange: { lowerTick: 66_400, upperTick: 65_600, tickSpacing: 1 },
        guard: guard(),
      }),
    ).rejects.toMatchObject({ code: CHAIN_ERROR_CODES.INVALID_ARGUMENT });
    expect(sent).toHaveLength(0);
  });
});

describe('§93 approval semantics and the non-atomic swap', () => {
  it('marks a USDT input as zero-then-max and targets the v3 SwapRouter', async () => {
    const { dex, sent } = harness();
    const quote = await quoteFor(dex);
    const result = await dex.executeSwap({
      quote,
      deadline: TIMESTAMP_DEADLINE,
      purpose: 'BUILD_POSITION',
      idempotencyKey: 'swap#usdt',
      guard: guard(),
    });
    expect(result.approvalType).toBe(APPROVAL_TYPES.ZERO_THEN_MAX);
    expect(result.state).toBe(TX_STATES.SUBMITTED);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(PANCAKE.swapRouter.toLowerCase());

    const decoded = decodeFunctionData({ abi: V3_SWAP_ROUTER_ABI, data: sent[0]!.data });
    expect(decoded.functionName).toBe('exactInputSingle');
    const params = (decoded.args as readonly Record<string, unknown>[])[0]!;
    expect(params['amountIn']).toBe(AMOUNT_IN);
    expect(params['amountOutMinimum']).toBe(quote.amountOutMinimumRaw);
    expect(params['recipient']).toBe(SIGNER.address);
    expect(params['deadline']).toBe(BigInt(TIMESTAMP_DEADLINE.unixSeconds));
  });

  it('uses the exact approval for a non-USDT input', async () => {
    const amountIn = 2n * 10n ** 18n;
    const { dex, sent } = harness({
      contracts: chainContracts({
        amountOut: 1_000n * 10n ** 18n,
        quote: { tokenIn: QQQB, tokenOut: USDT, amountIn },
      }),
    });
    const quote = await dex.quoteSwap({
      poolId: POOL_ID,
      tokenIn: QQQB,
      tokenOut: USDT,
      amountIn,
      ttlSeconds: TTL_SECONDS,
    });
    const result = await dex.executeSwap({
      quote,
      deadline: TIMESTAMP_DEADLINE,
      purpose: 'EXIT_POSITION',
      idempotencyKey: 'swap#qqqb',
      guard: guard(),
    });
    expect(result.approvalType).toBe(APPROVAL_TYPES.EXACT);
    expect(sent).toHaveLength(1);
  });
});

describe('position reads and liquidity removal', () => {
  const withManager = (): NonNullable<MockNodeOptions['contracts']> =>
    chainContracts({ positionManager: PANCAKE.positionManager });

  it('reads a position and rebuilds its §13 poolId from the pool it actually points at', async () => {
    const { dex } = harness({ contracts: withManager() });
    const position = await dex.getPosition(7n);
    expect(position).not.toBeNull();
    expect(position!.poolId).toBe(POOL_ID);
    expect(position!.owner).toBe(SIGNER.address);
    expect(position!.liquidity).toBe(9_876_543_210_000n);
    expect(position!.tokensOwed0Raw).toBe(1_500_000_000_000_000_000n);
    expect(position!.tickLower).toBe(63_600);
    expect(position!.tickUpper).toBe(67_200);
  });

  it('reports null for a tokenId that does not exist (a revert, not an absent node)', async () => {
    const { dex } = harness({
      contracts: chainContracts({ positionManager: PANCAKE.positionManager, positionReverts: true }),
    });
    expect(await dex.getPosition(999n)).toBeNull();
  });

  it('removes liquidity with decreaseLiquidity + collect in one NPM multicall', async () => {
    const { dex, sent } = harness({ contracts: withManager() });
    const result = await dex.removeLiquidity({
      poolId: POOL_ID,
      positionTokenId: 7n,
      liquidityRaw: 5_000n,
      amount0MinRaw: 1n,
      amount1MinRaw: 1n,
      recipient: SIGNER.address,
      deadline: TIMESTAMP_DEADLINE,
      idempotencyKey: 'remove#partial',
      guard: guard(),
    });
    expect(result.liquidity).toBe(5_000n);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(PANCAKE.positionManager.toLowerCase());

    const decoded = decodeFunctionData({ abi: V3_POSITION_MANAGER_ABI, data: sent[0]!.data });
    expect(decoded.functionName).toBe('multicall');
    const inner = (decoded.args as readonly (readonly Hex[])[])[0]!;
    expect(inner.map((call) => call.slice(0, 10))).toEqual([
      '0x0c49ccbe', // decreaseLiquidity
      '0xfc6f7865', // collect
    ]);
    // A partial exit must not burn the NFT.
    expect(inner.some((call) => call.slice(0, 10) === '0x42966c68')).toBe(false);
  });

  it('burns the NFT on a full exit, reading the full L from the chain', async () => {
    const { dex, sent } = harness({ contracts: withManager() });
    await dex.removeLiquidity({
      poolId: POOL_ID,
      positionTokenId: 7n,
      liquidityRaw: null,
      amount0MinRaw: 1n,
      amount1MinRaw: 1n,
      recipient: SIGNER.address,
      deadline: TIMESTAMP_DEADLINE,
      idempotencyKey: 'remove#full',
      guard: guard(),
    });
    expect(sent).toHaveLength(1);
    const decoded = decodeFunctionData({ abi: V3_POSITION_MANAGER_ABI, data: sent[0]!.data });
    const inner = (decoded.args as readonly (readonly Hex[])[])[0]!;
    expect(inner.map((call) => call.slice(0, 10))).toEqual([
      '0x0c49ccbe',
      '0xfc6f7865',
      '0x42966c68', // burn
    ]);
  });

  it('refuses a full exit whose position cannot be read, rather than burning an unknown amount', async () => {
    const { dex, sent } = harness({
      contracts: chainContracts({ positionManager: PANCAKE.positionManager, positionReverts: true }),
    });
    await expect(
      dex.removeLiquidity({
        poolId: POOL_ID,
        positionTokenId: 999n,
        liquidityRaw: null,
        amount0MinRaw: 1n,
        amount1MinRaw: 1n,
        recipient: SIGNER.address,
        deadline: TIMESTAMP_DEADLINE,
        idempotencyKey: 'remove#missing',
        guard: guard(),
      }),
    ).rejects.toMatchObject({ code: CHAIN_ERROR_CODES.DECODE_FAILED });
    expect(sent).toHaveLength(0);
  });

  it('refuses an exit that names a different pool than the position belongs to', async () => {
    const { dex, sent } = harness({ contracts: withManager() });
    await expect(
      dex.removeLiquidity({
        poolId: `56:${DEX_IDS.PANCAKESWAP_V3}:0x47bc06722295ac316a569eef87ac32faa455f441`,
        positionTokenId: 7n,
        liquidityRaw: null,
        amount0MinRaw: 1n,
        amount1MinRaw: 1n,
        recipient: SIGNER.address,
        deadline: TIMESTAMP_DEADLINE,
        idempotencyKey: 'remove#wrongpool',
        guard: guard(),
      }),
    ).rejects.toMatchObject({ code: CHAIN_ERROR_CODES.INVALID_ARGUMENT });
    expect(sent).toHaveLength(0);
  });

  it('refuses to burn more liquidity than the position holds', async () => {
    const { dex, sent } = harness({ contracts: withManager() });
    await expect(
      dex.removeLiquidity({
        poolId: POOL_ID,
        positionTokenId: 7n,
        liquidityRaw: 9_876_543_210_001n,
        amount0MinRaw: 1n,
        amount1MinRaw: 1n,
        recipient: SIGNER.address,
        deadline: TIMESTAMP_DEADLINE,
        idempotencyKey: 'remove#toomuch',
        guard: guard(),
      }),
    ).rejects.toMatchObject({ code: CHAIN_ERROR_CODES.INVALID_ARGUMENT });
    expect(sent).toHaveLength(0);
  });

  it('collects fees with an uncapped per-leg amount', async () => {
    const { dex, sent } = harness({ contracts: withManager() });
    const result = await dex.collectFees({
      poolId: POOL_ID,
      positionTokenId: 7n,
      recipient: SIGNER.address,
      idempotencyKey: 'collect#1',
      guard: guard(),
    });
    expect(result.positionTokenId).toBe(7n);
    expect(sent).toHaveLength(1);
    const decoded = decodeFunctionData({ abi: V3_POSITION_MANAGER_ABI, data: sent[0]!.data });
    expect(decoded.functionName).toBe('collect');
    const params = (decoded.args as readonly Record<string, unknown>[])[0]!;
    expect(params['amount0Max']).toBe(2n ** 128n - 1n);
    expect(params['amount1Max']).toBe(2n ** 128n - 1n);
  });
});

describe('the v3 router’s own limits (documented invariant)', () => {
  it('the v3 SwapRouter ABI has no mint/increaseLiquidity, so its multicall can never add liquidity', () => {
    const names = new Set(
      swapRouterABI.map((fragment) => (fragment as { name?: string }).name).filter(Boolean),
    );
    expect(names.has('multicall')).toBe(true);
    expect(names.has('exactInputSingle')).toBe(true);
    // No position-manager surface at all: this router physically cannot complete a §42 build.
    expect(names.has('mint')).toBe(false);
    expect(names.has('increaseLiquidity')).toBe(false);
  });

  it('the chain layer reads positions through the same selector the SDK writes with', () => {
    // The adapter reads `positions`/`ownerOf` through the chain layer's own ABI and writes through the
    // SDK's. If the two ever disagreed on a selector, a read would silently decode a different field.
    const readAbi = POSITION_MANAGER_ABI.filter((fragment) => {
      const name = (fragment as { name?: string }).name;
      return name === 'positions' || name === 'ownerOf';
    }) as readonly {
      readonly name?: string;
      readonly inputs: readonly { readonly type: string }[];
      readonly outputs?: readonly { readonly type: string }[];
    }[];
    expect(readAbi.map((fragment) => fragment.name).sort()).toEqual(['ownerOf', 'positions']);
    const sdkPositions = V3_POSITION_MANAGER_ABI.filter(
      (fragment) => (fragment as { name?: string }).name === 'positions',
    ) as readonly { readonly outputs?: readonly { readonly type: string }[] }[];
    const readPositions = readAbi.find((fragment) => fragment.name === 'positions')!;
    expect(readPositions.outputs?.map((output) => output.type)).toEqual(
      sdkPositions[0]!.outputs?.map((output) => output.type),
    );
  });

  it('the NPM’s multicall is bytes[]-only, which is why the atomic path must go to the SmartRouter', () => {
    const multicall = V3_POSITION_MANAGER_ABI.filter((fragment) => {
      return (fragment as { name?: string }).name === 'multicall';
    }) as readonly { readonly inputs: readonly { readonly type: string }[] }[];
    expect(multicall).toHaveLength(1);
    expect(multicall[0]!.inputs.map((input) => input.type)).toEqual(['bytes[]']);
    // A single call is returned unwrapped by the SDK, so verify both shapes the adapter can emit.
    const one = encodeFunctionData({
      abi: V3_POSITION_MANAGER_ABI,
      functionName: 'decreaseLiquidity',
      args: [
        { tokenId: 1n, liquidity: 1n, amount0Min: 0n, amount1Min: 0n, deadline: 1n },
      ],
    });
    expect(one.slice(0, 10)).toBe('0x0c49ccbe');
  });
});
