/**
 * CLMM pool reads: `slot0` decoding, liquidity, fee, tick spacing, token order and reserves.
 *
 * The `slot0` fixture is the **real** tuple observed on BSC for QQQB/USDT @ PancakeSwap V3
 * (`0xe531fcb1f5a195de7608b9f4f9518544c2cdb693`) and QQQB/USDC @ Uniswap V3
 * (`0xfc4e77248b76fefc27c4cac7151a2ee5b5cc590e`), so a decode regression shows up as a wrong price
 * rather than as a passing test.
 */
import { describe, expect, it } from 'vitest';
import { BscChainAdapter } from '../../src/chain/adapter.ts';
import { CLMM_POOL_ABI, ERC20_ABI } from '../../src/chain/abis.ts';
import { CHAIN_ERROR_CODES } from '../../src/chain/errors.ts';
import {
  PoolReader,
  Q96,
  sqrtPriceX96ToPrice,
  sqrtPriceX96ToRawPrice,
} from '../../src/chain/poolReader.ts';
import { handlerTransport } from '../../src/chain/rpc.ts';
import { BSC_ADDRESSES, BSC_DEX_CONTRACTS } from '../../src/config/builtins.ts';
import { createWhitelist, defaultDexWhitelist } from '../../src/config/index.ts';
import { createBuiltinRegistry } from '../../src/config/registry.ts';
import { DEX_IDS } from '../../src/types/primitives.ts';
import * as primitives from '../../src/types/primitives.ts';
import { callEntry, createMockNode, entry, type MockNodeOptions } from './mockNode.ts';

const QQQB = '0x205812cdbed920aff76c6580abd681a46d11efc7' as const;
const USDT = BSC_ADDRESSES.USDT;
const USDC = BSC_ADDRESSES.USDC;
/** QQQB/USDT 0.01% @ PancakeSwap V3. */
const PANCAKE_POOL = '0xe531fcb1f5a195de7608b9f4f9518544c2cdb693' as const;
/** QQQB/USDC 0.3% @ Uniswap V3 on BSC. */
const UNISWAP_POOL = '0xfc4e77248b76fefc27c4cac7151a2ee5b5cc590e' as const;

/**
 * `slot0()` as decoded from BSC (sqrtPriceX96, tick, obsIndex, cardinality, cardinalityNext,
 * feeProtocol, unlocked). Both pools quote QQQB near $740, which is the sanity value these fixtures
 * are chosen for: a decimal or ABI-width mistake moves the derived price by orders of magnitude.
 */
const PANCAKE_SLOT0 = [
  2_154_684_918_573_583_757_950_873_039_641n,
  66_064,
  3_003,
  5_000,
  5_000,
  216_272_100,
  true,
] as const;
const UNISWAP_SLOT0 = [
  2_151_882_938_487_960_613_408_551_848_026n,
  66_038,
  0,
  1,
  1,
  102,
  true,
] as const;

/** Real reserve balances: they sum to the pools' reported TVL (~$0.62M / ~$1.78M). */
const PANCAKE_RESERVES = {
  reserve0: 441_375_877_466_074_801_295n,
  reserve1: 296_192_032_576_361_570_143_569n,
} as const;
const UNISWAP_RESERVES = {
  reserve0: 848_791_005_880_923_083_913n,
  reserve1: 1_154_174_373_043_046_329_711_351n,
} as const;

function poolReaderWith(contracts: NonNullable<MockNodeOptions['contracts']>) {
  const node = createMockNode({ contracts });
  const whitelist = createWhitelist(createBuiltinRegistry().list(), [56], defaultDexWhitelist([56]));
  const adapter = new BscChainAdapter({
    chainId: 56,
    whitelist,
    rpc: {
      endpoints: [{ label: 'n1', url: 'mock://n1' }],
      transportFactory: () => handlerTransport(node.handle),
      retries: 0,
      crossCheckEndpoints: 1,
    },
  });
  return { reader: new PoolReader(adapter, whitelist.registry, 56), node };
}

/** Contract table for one pool with the given legs and slot0. */
function poolContracts(input: {
  readonly pool: string;
  readonly token0: string;
  readonly token1: string;
  readonly slot0: readonly unknown[];
  readonly fee: number;
  readonly tickSpacing: number;
  readonly liquidity: bigint;
  readonly reserve0?: bigint;
  readonly reserve1?: bigint;
}): NonNullable<MockNodeOptions['contracts']> {
  const card: Record<string, `0x${string}` | 'revert'> = {};
  entry(card, 'slot0()', input.slot0, CLMM_POOL_ABI);
  entry(card, 'liquidity()', input.liquidity, CLMM_POOL_ABI);
  entry(card, 'fee()', input.fee, CLMM_POOL_ABI);
  entry(card, 'tickSpacing()', input.tickSpacing, CLMM_POOL_ABI);
  entry(card, 'token0()', input.token0, CLMM_POOL_ABI);
  entry(card, 'token1()', input.token1, CLMM_POOL_ABI);

  const token0Card: Record<string, `0x${string}` | 'revert'> = {};
  callEntry(token0Card, 'balanceOf(address)', [input.pool], input.reserve0 ?? 0n, ERC20_ABI);
  const token1Card: Record<string, `0x${string}` | 'revert'> = {};
  callEntry(token1Card, 'balanceOf(address)', [input.pool], input.reserve1 ?? 0n, ERC20_ABI);

  return { [input.pool]: card, [input.token0]: token0Card, [input.token1]: token1Card };
}

describe('sqrtPriceX96 → price', () => {
  it('derives the decimal-adjusted price of the live QQQB/USDT pool', () => {
    const raw = sqrtPriceX96ToRawPrice(PANCAKE_SLOT0[0]);
    // sqrtPriceX96 = Q96 × sqrt(P) ⇒ P = 739.615 USDT per QQQB. Both legs are 18 decimals, so the
    // raw price is already the human price — a 6-decimal USDT assumption would show a factor of 1e12.
    expect(raw).toBeCloseTo(739.615, 2);
    expect(sqrtPriceX96ToPrice(PANCAKE_SLOT0[0], 18, 18)).toBeCloseTo(raw, 12);
    // Cross-checked against the tick: price ≈ 1.0001^tick.
    expect(raw).toBeCloseTo(1.0001 ** PANCAKE_SLOT0[1], 0);
  });

  it('applies the decimals adjustment in the documented direction', () => {
    // 18-decimal token0 against 18-decimal token1: no adjustment.
    expect(sqrtPriceX96ToPrice(PANCAKE_SLOT0[0], 18, 18)).toBe(sqrtPriceX96ToRawPrice(PANCAKE_SLOT0[0]));
    // A 6-decimal token1 makes one whole token1 worth 1e12 raw units, so the whole-token price is
    // the raw price × 1e12. Reversing this factor is the classic BSC USDC/USDT bug (research §1).
    expect(sqrtPriceX96ToPrice(PANCAKE_SLOT0[0], 18, 6)).toBe(
      sqrtPriceX96ToRawPrice(PANCAKE_SLOT0[0]) * 1e12,
    );
    // And the other way round: a 6-decimal token0 divides by 1e12.
    expect(sqrtPriceX96ToPrice(PANCAKE_SLOT0[0], 6, 18)).toBe(
      sqrtPriceX96ToRawPrice(PANCAKE_SLOT0[0]) / 1e12,
    );
    expect(Q96).toBe(79_228_162_514_264_337_593_543_950_336n);
  });
});

describe('pool reads', () => {
  it('reads slot0, liquidity, fee, tickSpacing and reserves for QQQB/USDT @ Pancake', async () => {
    const contracts = poolContracts({
      pool: PANCAKE_POOL,
      token0: QQQB,
      token1: USDT,
      slot0: PANCAKE_SLOT0,
      fee: 100,
      tickSpacing: 1,
      liquidity: 1_556_539_313_050_556_134_018_878n,
      ...PANCAKE_RESERVES,
    });
    const { reader } = poolReaderWith(contracts);
    const target = await reader.resolvePool(PANCAKE_POOL, DEX_IDS.PANCAKESWAP_V3);
    const state = await reader.readPool(target);

    expect(state.poolId).toBe(`56:${DEX_IDS.PANCAKESWAP_V3}:${PANCAKE_POOL}`);
    expect(state.sqrtPriceX96).toBe(PANCAKE_SLOT0[0]);
    expect(state.tick).toBe(66_064);
    expect(state.liquidity).toBe(1_556_539_313_050_556_134_018_878n);
    expect(state.feeTier).toBe(100);
    expect(state.tickSpacing).toBe(1);
    expect(state.token0.toLowerCase()).toBe(QQQB);
    expect(state.token1.toLowerCase()).toBe(USDT);
    expect(state.reserve0Raw).toBe(PANCAKE_RESERVES.reserve0);
    expect(state.reserve1Raw).toBe(PANCAKE_RESERVES.reserve1);
    // Both reserves must be valued by the reader's own legs and add up to the pool's TVL
    // (~$0.622M): 441.38 QQQB x ~$740 + 296_192 USDT.
    const tvlUsd =
      Number(state.reserve0Raw) / 1e18 * state.priceToken1PerToken0 + Number(state.reserve1Raw) / 1e18;
    expect(tvlUsd / 1e6).toBeCloseTo(0.6228, 3);
    expect(state.provenance.observedBy).toEqual(['n1']);
  });

  it('reads the Uniswap V3 QQQB/USDC pool with the pool’s own token order', async () => {
    const contracts = poolContracts({
      pool: UNISWAP_POOL,
      token0: USDC,
      token1: QQQB,
      slot0: UNISWAP_SLOT0,
      fee: 3000,
      tickSpacing: 60,
      liquidity: 1_647_325_147_708_000_085_584_945n,
      ...UNISWAP_RESERVES,
    });
    const { reader } = poolReaderWith(contracts);
    const target = await reader.resolvePool(UNISWAP_POOL, DEX_IDS.UNISWAP_V3);
    expect(target.token0.symbol).toBe('USDC');
    expect(target.token1.symbol).toBe('QQQB');
    expect(target.feeTier).toBe(3000);
    expect(target.tickSpacing).toBe(60);

    const state = await reader.readPool(target);
    expect(state.tick).toBe(66_038);
    expect(state.liquidity).toBe(1_647_325_147_708_000_085_584_945n);
    // Both legs are 18 decimals, so USDC per QQQB is the raw price (~$737.69), within 1% of the
    // Pancake pool's price — a genuine cross-pool sanity check rather than a tautology.
    expect(state.priceToken1PerToken0).toBeCloseTo(737.69, 1);
    const tvlUsd = Number(state.reserve0Raw) / 1e18 * state.priceToken1PerToken0 + Number(state.reserve1Raw) / 1e18;
    expect(tvlUsd / 1e6).toBeCloseTo(1.780, 2);
  });

  it('exposes §108 active liquidity and slot0 individually', async () => {
    const contracts = poolContracts({
      pool: PANCAKE_POOL,
      token0: QQQB,
      token1: USDT,
      slot0: PANCAKE_SLOT0,
      fee: 100,
      tickSpacing: 1,
      liquidity: 42n,
    });
    const { reader } = poolReaderWith(contracts);
    expect((await reader.readActiveLiquidity(PANCAKE_POOL)).value).toBe(42n);
    const slot0 = await reader.readSlot0(PANCAKE_POOL);
    expect(slot0.tick).toBe(66_064);
    expect(slot0.sqrtPriceX96).toBe(PANCAKE_SLOT0[0]);
  });

  it('refuses a pool whose on-chain token0 disagrees with the caller', async () => {
    const contracts = poolContracts({
      pool: PANCAKE_POOL,
      token0: QQQB,
      token1: USDT,
      slot0: PANCAKE_SLOT0,
      fee: 100,
      tickSpacing: 1,
      liquidity: 1n,
    });
    const { reader } = poolReaderWith(contracts);
    const target = await reader.resolvePool(PANCAKE_POOL, DEX_IDS.PANCAKESWAP_V3);
    // Confuse the caller: claim the pool's token0 is USDC (as a WBNB/USDT pool would be ordered).
    const confused = { ...target, token0: target.token1, token1: target.token0 };
    await expect(reader.readPool(confused)).rejects.toMatchObject({
      code: CHAIN_ERROR_CODES.DECODE_FAILED,
    });
  });

  it('refuses a pool that is not initialised', async () => {
    const contracts = poolContracts({
      pool: PANCAKE_POOL,
      token0: QQQB,
      token1: USDT,
      slot0: [0n, 0, 0, 0, 0, 0, true],
      fee: 100,
      tickSpacing: 1,
      liquidity: 0n,
    });
    const { reader } = poolReaderWith(contracts);
    const target = await reader.resolvePool(PANCAKE_POOL, DEX_IDS.PANCAKESWAP_V3);
    await expect(reader.readPool(target)).rejects.toMatchObject({
      code: CHAIN_ERROR_CODES.DECODE_FAILED,
    });
  });

  it('refuses a pool that holds an unwhitelisted token (§8)', async () => {
    const impostor = '0xb904108b7f6d3b27c23128ca2b62738061b8a689' as const;
    const contracts = poolContracts({
      pool: PANCAKE_POOL,
      token0: impostor,
      token1: USDT,
      slot0: PANCAKE_SLOT0,
      fee: 100,
      tickSpacing: 1,
      liquidity: 1n,
    });
    const { reader } = poolReaderWith(contracts);
    await expect(reader.resolvePool(PANCAKE_POOL, DEX_IDS.PANCAKESWAP_V3)).rejects.toThrowError(
      /not whitelisted/i,
    );
  });
});

describe('factory-derived pool addresses', () => {
  it('resolves a pool through the whitelisted factory and rejects the zero address', async () => {
    const contracts: NonNullable<MockNodeOptions['contracts']> = {};
    const factoryCard: Record<string, `0x${string}` | 'revert'> = {};
    callEntry(
      factoryCard,
      'getPool(address,address,uint24)',
      [QQQB, USDT, 100],
      PANCAKE_POOL,
      [{
        type: 'function',
        name: 'getPool',
        stateMutability: 'view',
        inputs: [
          { name: 'tokenA', type: 'address' },
          { name: 'tokenB', type: 'address' },
          { name: 'fee', type: 'uint24' },
        ],
        outputs: [{ name: 'pool', type: 'address' }],
      }],
    );
    callEntry(
      factoryCard,
      'getPool(address,address,uint24)',
      [QQQB, USDC, 500],
      '0x0000000000000000000000000000000000000000',
      [{
        type: 'function',
        name: 'getPool',
        stateMutability: 'view',
        inputs: [
          { name: 'tokenA', type: 'address' },
          { name: 'tokenB', type: 'address' },
          { name: 'fee', type: 'uint24' },
        ],
        outputs: [{ name: 'pool', type: 'address' }],
      }],
    );
    contracts[BSC_DEX_CONTRACTS[DEX_IDS.PANCAKESWAP_V3]!.factory] = factoryCard;

    const node = createMockNode({ contracts });
    const whitelist = createWhitelist(createBuiltinRegistry().list(), [56], defaultDexWhitelist([56]));
    const adapter = new BscChainAdapter({
      chainId: 56,
      whitelist,
      rpc: {
        endpoints: [{ label: 'n1', url: 'mock://n1' }],
        transportFactory: () => handlerTransport(node.handle),
        retries: 0,
        crossCheckEndpoints: 1,
      },
    });

    const found = await adapter.getPoolAddress(DEX_IDS.PANCAKESWAP_V3, QQQB, USDT, 100);
    expect((found as string).toLowerCase()).toBe(PANCAKE_POOL);
    // The zero address means "no such pool", which must be `null` and not a fake address.
    expect(await adapter.getPoolAddress(DEX_IDS.PANCAKESWAP_V3, QQQB, USDC, 500)).toBeNull();
  });
});

describe('type sanity', () => {
  it('keeps the DEX id literals stable for the chain layer', () => {
    expect(primitives.DEX_IDS.PANCAKESWAP_V3).toBe('pancakeswap-v3');
    expect(DEX_IDS.UNISWAP_V3).toBe('uniswap-v3');
  });
});
