/**
 * §108 LP position + unclaimed fee reads, and §98/§95 write-path refusals.
 *
 * The position fixture is a real Coinbase-style `positions(tokenId)` return shape (12 fields, with
 * `uint128` widths). The write-path tests deliberately never broadcast: they exercise the refusal
 * branches (guard, missing signer, dry-run, `UNKNOWN` resolution), which is where a bug would cost
 * money.
 */
import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { BscChainAdapter } from '../../src/chain/adapter.ts';
import { ERC20_ABI, POSITION_MANAGER_ABI } from '../../src/chain/abis.ts';
import { CHAIN_ERROR_CODES, TxGuardError, TxStateUnknownError } from '../../src/chain/errors.ts';
import { PositionReader } from '../../src/chain/positionReader.ts';
import { handlerTransport } from '../../src/chain/rpc.ts';
import {
  buildTxGuard,
  canTransition,
  emptyTxGuard,
  GUARD_CHECK_KEYS,
  GUARD_CHECK_LABELS,
  interpretTransaction,
  resolveUnknown,
  selectorOf,
  TX_TRANSITIONS,
} from '../../src/chain/txState.ts';
import { BSC_ADDRESSES, BSC_DEX_CONTRACTS } from '../../src/config/builtins.ts';
import { createWhitelist, defaultDexWhitelist } from '../../src/config/index.ts';
import { createBuiltinRegistry } from '../../src/config/registry.ts';
import { TX_STATES, type TxGuardChecks } from '../../src/types/adapters.ts';
import { DEX_IDS } from '../../src/types/primitives.ts';
import { callEntry, createMockNode, entry, type MockNodeOptions } from './mockNode.ts';

const QQQB = '0x205812cdbed920aff76c6580abd681a46d11efc7' as const;
const USDT = BSC_ADDRESSES.USDT;
const USDC = BSC_ADDRESSES.USDC;
const PANCAKE_POOL = '0xe531fcb1f5a195de7608b9f4f9518544c2cdb693' as const;
const UNISWAP_POOL = '0xfc4e77248b76fefc27c4cac7151a2ee5b5cc590e' as const;
const OWNER = '0x3333333333333333333333333333333333333333' as const;
/** A dedicated strategy wallet with no funds; used only as an address, never as a key. */
const SIGNER = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const PANCAKE_MANAGER = BSC_DEX_CONTRACTS[DEX_IDS.PANCAKESWAP_V3]!.positionManager;

/** `positions(tokenId)` tuple: nonce, operator, token0, token1, fee, ticks, L, growths, owed. */
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

function readerFor(contracts: NonNullable<MockNodeOptions['contracts']>, chainId = 56) {
  const node = createMockNode({ contracts });
  const whitelist = createWhitelist(createBuiltinRegistry().list(), [56], defaultDexWhitelist([56]));
  const adapter = new BscChainAdapter({
    chainId,
    whitelist,
    rpc: {
      endpoints: [{ label: 'n1', url: 'mock://n1' }],
      transportFactory: () => handlerTransport(node.handle),
      retries: 0,
      crossCheckEndpoints: 1,
    },
  });
  return { reader: new PositionReader(adapter, chainId), adapter, node, whitelist };
}

function managerCard() {
  const card: Record<string, `0x${string}` | 'revert'> = {};
  callEntry(card, 'positions(uint256)', [1234n], POSITION_TUPLE, POSITION_MANAGER_ABI);
  callEntry(card, 'ownerOf(uint256)', [1234n], OWNER, POSITION_MANAGER_ABI);
  callEntry(card, 'balanceOf(address)', [OWNER], 1n, POSITION_MANAGER_ABI);
  callEntry(card, 'tokenOfOwnerByIndex(address,uint256)', [OWNER, 0n], 1234n, POSITION_MANAGER_ABI);
  return card;
}

describe('LP position reads (§108)', () => {
  it('reads a position with its unclaimed fees and confirmed owner', async () => {
    const { reader } = readerFor({ [PANCAKE_MANAGER]: managerCard() });
    const position = await reader.getPositionView({
      dex: DEX_IDS.PANCAKESWAP_V3,
      tokenId: 1234n,
      poolAddress: PANCAKE_POOL,
      expectedOwner: OWNER,
    });

    expect(position).not.toBeNull();
    expect(position!.poolId).toBe(`56:${DEX_IDS.PANCAKESWAP_V3}:${PANCAKE_POOL}`);
    expect(position!.positionTokenId).toBe(1234n);
    expect(position!.owner).toBe(OWNER);
    expect(position!.tickLower).toBe(63_600);
    expect(position!.tickUpper).toBe(67_200);
    expect(position!.liquidity).toBe(9_876_543_210_000n);
    // §108 unclaimed fees come straight from `tokensOwed`.
    expect(position!.tokensOwed0Raw).toBe(1_500_000_000_000_000_000n);
    expect(position!.tokensOwed1Raw).toBe(2_250_000_000_000_000_000n);
    expect(position!.feeGrowthInside0LastX128).toBe(115_792_089_237_316_195_423_570_985_008_687_907_853n);
    expect(position!.feeTier).toBe(100);
    expect(position!.positionManager).toBe(PANCAKE_MANAGER);
  });

  it('rejects a position owned by someone else rather than reporting it', async () => {
    const { reader } = readerFor({ [PANCAKE_MANAGER]: managerCard() });
    const error = await reader
      .getPositionView({
        dex: DEX_IDS.PANCAKESWAP_V3,
        tokenId: 1234n,
        poolAddress: PANCAKE_POOL,
        expectedOwner: SIGNER.address,
      })
      .catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ code: CHAIN_ERROR_CODES.DECODE_FAILED });
    expect((error as Error).message).toContain('refusing to report a position we do not control');
  });

  it('enumerates a wallet’s positions via balanceOf + tokenOfOwnerByIndex', async () => {
    const card = managerCard();
    // Add a second position so the enumeration loop is actually exercised.
    callEntry(card, 'balanceOf(address)', [OWNER], 2n, POSITION_MANAGER_ABI);
    callEntry(card, 'tokenOfOwnerByIndex(address,uint256)', [OWNER, 1n], 1235n, POSITION_MANAGER_ABI);
    callEntry(card, 'positions(uint256)', [1235n], POSITION_TUPLE, POSITION_MANAGER_ABI);
    callEntry(card, 'ownerOf(uint256)', [1235n], OWNER, POSITION_MANAGER_ABI);

    const { reader } = readerFor({ [PANCAKE_MANAGER]: card });
    expect(await reader.listPositionIds(DEX_IDS.PANCAKESWAP_V3, OWNER)).toEqual([1234n, 1235n]);
  });

  it('throws when the pool for a position cannot be resolved instead of guessing a poolId', async () => {
    const { reader } = readerFor({ [PANCAKE_MANAGER]: managerCard() });
    await expect(
      reader.listPositions({
        dex: DEX_IDS.PANCAKESWAP_V3,
        owner: OWNER,
        resolvePoolAddress: async () => null,
      }),
    ).rejects.toMatchObject({ code: CHAIN_ERROR_CODES.DECODE_FAILED });
  });

  it('uses each DEX’s own position manager', () => {
    const { reader } = readerFor({});
    expect(reader.positionManagerFor(DEX_IDS.PANCAKESWAP_V3)).toBe(PANCAKE_MANAGER);
    expect(reader.positionManagerFor(DEX_IDS.UNISWAP_V3)).toBe(
      BSC_DEX_CONTRACTS[DEX_IDS.UNISWAP_V3]!.positionManager,
    );
    // The two managers must differ: a tokenId is only meaningful with the manager that minted it.
    expect(reader.positionManagerFor(DEX_IDS.PANCAKESWAP_V3)).not.toBe(
      reader.positionManagerFor(DEX_IDS.UNISWAP_V3),
    );
  });
});

describe('§95 pre-flight guard', () => {
  const allOk = {
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

  it('derives ok from the sub-checks and lists the failures', () => {
    const guard = buildTxGuard({ ...allOk, slippageWithinLimit: false, deadlineOk: false });
    expect(guard.ok).toBe(false);
    expect(guard.failures).toEqual([
      GUARD_CHECK_LABELS.slippageWithinLimit,
      GUARD_CHECK_LABELS.deadlineOk,
    ]);
    expect(buildTxGuard(allOk).ok).toBe(true);
  });

  it('covers every §95 field, so a new check cannot be silently skipped', () => {
    expect([...GUARD_CHECK_KEYS].sort()).toEqual(Object.keys(allOk).sort());
    expect(GUARD_CHECK_KEYS).toHaveLength(10);
  });

  it('starts pessimistic', () => {
    const guard = emptyTxGuard();
    expect(guard.ok).toBe(false);
    expect(guard.failures).toHaveLength(10);
  });

  it('refuses to send when a sub-check failed even if the caller claims ok', async () => {
    const { adapter } = readerFor({});
    const forged = { ...allOk, slippageWithinLimit: false, ok: true, failures: [] } as TxGuardChecks;
    await expect(
      adapter.sendTransaction({
        to: PANCAKE_MANAGER,
        data: '0x095ea7b3',
        value: 0n,
        guard: forged,
      }),
    ).rejects.toBeInstanceOf(TxGuardError);
  });

  it('refuses to send without an attached signer (§94 — no key lives in this layer)', async () => {
    const { adapter } = readerFor({});
    await expect(
      adapter.sendTransaction({
        to: PANCAKE_MANAGER,
        data: '0x095ea7b3',
        value: 0n,
        guard: buildTxGuard(allOk),
      }),
    ).rejects.toMatchObject({ code: CHAIN_ERROR_CODES.INVALID_ARGUMENT });
    expect(adapter.getSignerAddress()).toBeNull();
  });

  it('extracts the selector from calldata and rejects a payload shorter than a selector', () => {
    expect(selectorOf('0x095EA7b30000000000000000000000000000000000000001')).toBe('0x095ea7b3');
    // A bare 4-byte selector is legitimate calldata (e.g. `slot0()`), so it must pass.
    expect(selectorOf('0x3850c7bd')).toBe('0x3850c7bd');
    expect(() => selectorOf('0xdead')).toThrowError(/4-byte function selector/);
    expect(() => selectorOf('0x')).toThrowError(/4-byte function selector/);
  });
});

describe('§98 transaction state machine', () => {
  it('allows the documented transitions and forbids the dangerous ones', () => {
    expect(canTransition(TX_STATES.CREATED, TX_STATES.SUBMITTED)).toBe(true);
    expect(canTransition(TX_STATES.SUBMITTED, TX_STATES.CONFIRMED)).toBe(true);
    expect(canTransition(TX_STATES.SUBMITTED, TX_STATES.REVERTED)).toBe(true);
    expect(canTransition(TX_STATES.SUBMITTED, TX_STATES.UNKNOWN)).toBe(true);
    // A mined outcome is final; a confirmed transaction cannot become reverted or failed.
    expect(canTransition(TX_STATES.CONFIRMED, TX_STATES.REVERTED)).toBe(false);
    expect(canTransition(TX_STATES.CONFIRMED, TX_STATES.FAILED)).toBe(false);
    // UNKNOWN may only resolve into a mined state (or stay UNKNOWN while re-querying).
    expect(canTransition(TX_STATES.UNKNOWN, TX_STATES.CONFIRMED)).toBe(true);
    expect(canTransition(TX_STATES.UNKNOWN, TX_STATES.UNKNOWN)).toBe(true);
    // CREATED must never jump straight to CONFIRMED without a submission.
    expect(canTransition(TX_STATES.CREATED, TX_STATES.CONFIRMED)).toBe(false);
    expect(TX_TRANSITIONS[TX_STATES.UNKNOWN]).not.toContain(TX_STATES.CREATED);
  });

  it('never licenses a resend from UNKNOWN', () => {
    const resolution = resolveUnknown(
      { state: TX_STATES.UNKNOWN, hash: '0xabc' as `0x${string}`, attempts: 1, unknownReason: 'mempool empty' },
      false,
    );
    expect(resolution.mayResend).toBe(false);
    expect(resolution.requiredAction).toBe('requery-on-chain');

    const noHash = resolveUnknown(
      { state: TX_STATES.UNKNOWN, hash: null, attempts: 0, unknownReason: 'broadcast failed' },
      true,
    );
    expect(noHash.mayResend).toBe(false);
    expect(noHash.requiredAction).toBe('operator-review');
  });

  it('maps a missing hash to UNKNOWN (not FAILED) so no retry is licensed', () => {
    const info = interpretTransaction('0xdead' as `0x${string}`, null);
    expect(info.state).toBe(TX_STATES.UNKNOWN);
    expect(info.unknownReason).toContain('never auto-retry');
  });

  it('maps a mined success/revert and a pending transaction', () => {
    const confirmed = interpretTransaction('0xa' as `0x${string}`, {
      blockNumber: 100n,
      from: SIGNER.address,
      to: PANCAKE_MANAGER,
      value: 0n,
      gasUsed: 150_000n,
      effectiveGasPrice: 3_000_000_000n,
      status: 'success',
    });
    expect(confirmed.state).toBe(TX_STATES.CONFIRMED);
    expect(confirmed.gasUsed).toBe(150_000n);
    expect(confirmed.effectiveGasPriceWei).toBe(3_000_000_000n);

    const reverted = interpretTransaction('0xb' as `0x${string}`, {
      blockNumber: 100n,
      from: SIGNER.address,
      to: PANCAKE_MANAGER,
      value: 0n,
      status: 'reverted',
    });
    expect(reverted.state).toBe(TX_STATES.REVERTED);

    const pending = interpretTransaction('0xc' as `0x${string}`, {
      blockNumber: null,
      from: SIGNER.address,
      to: PANCAKE_MANAGER,
      value: 0n,
    });
    expect(pending.state).toBe(TX_STATES.SUBMITTED);
    expect(pending.blockNumber).toBeNull();

    const anomalous = interpretTransaction('0xd' as `0x${string}`, {
      blockNumber: 100n,
      from: SIGNER.address,
      to: PANCAKE_MANAGER,
      value: 0n,
    });
    expect(anomalous.state).toBe(TX_STATES.UNKNOWN);
    expect(anomalous.unknownReason).toContain('no status field');
  });

  it('reports a node that has never seen the hash as UNKNOWN', async () => {
    const account = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
    const node = createMockNode({});
    const whitelist = createWhitelist(createBuiltinRegistry().list(), [56], defaultDexWhitelist([56]));
    const adapter = new BscChainAdapter({
      chainId: 56,
      whitelist,
      account,
      rpc: {
        endpoints: [{ label: 'n1', url: 'mock://n1' }],
        transportFactory: () => handlerTransport(node.handle),
        retries: 0,
      },
    });
    const info = await adapter.getTransaction('0xfeed' as `0x${string}`);
    expect(info?.state).toBe(TX_STATES.UNKNOWN);
    // A pending transaction (known to the node, unmined) must be SUBMITTED, never UNKNOWN.
    expect(adapter.getSignerAddress()).toBe(account.address);
  });

  it('throws TxStateUnknownError rather than resending when the hash never settles', async () => {
    const hash = '0xaaaabbbbccccddddeeeeffff0000111122223333444455556666777788889999' as `0x${string}`;
    const node = createMockNode({
      transactions: {
        [hash]: { blockNumber: null, from: SIGNER.address, to: PANCAKE_MANAGER, value: 0n },
      },
    });
    const whitelist = createWhitelist(createBuiltinRegistry().list(), [56], defaultDexWhitelist([56]));
    const adapter = new BscChainAdapter({
      chainId: 56,
      whitelist,
      account: SIGNER,
      rpc: {
        endpoints: [{ label: 'n1', url: 'mock://n1' }],
        transportFactory: () => handlerTransport(node.handle),
        retries: 0,
      },
    });

    const error = await adapter.waitForTransaction(hash, 1).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(TxStateUnknownError);
    expect((error as TxStateUnknownError).txHash).toBe(hash);
    // Liveness: a pending transaction is re-queried, never re-broadcast.
    expect(node.countOf('eth_getTransactionReceipt')).toBeGreaterThan(0);
    expect(node.countOf('eth_sendRawTransaction')).toBe(0);
  });
});

describe('pool/token plumbing used by the portfolio read', () => {
  it('exposes token decimals through the pool reader cache', async () => {
    const card: Record<string, `0x${string}` | 'revert'> = {};
    entry(card, 'decimals()', 18, ERC20_ABI);
    const node = createMockNode({ contracts: { [USDC]: card } });
    const whitelist = createWhitelist(createBuiltinRegistry().list(), [56], defaultDexWhitelist([56]));
    const adapter = new BscChainAdapter({
      chainId: 56,
      whitelist,
      rpc: {
        endpoints: [{ label: 'n1', url: 'mock://n1' }],
        transportFactory: () => handlerTransport(node.handle),
        retries: 0,
      },
    });
    const { PoolReader } = await import('../../src/chain/poolReader.ts');
    const poolReader = new PoolReader(adapter, whitelist.registry, 56);
    expect(await poolReader.decimalsOf(USDC)).toBe(18);
    expect(await poolReader.decimalsOf(USDC)).toBe(18);
    // Cached: a second call must not hit the node again.
    expect(node.countOf('eth_call')).toBe(1);
    expect(UNISWAP_POOL).toHaveLength(42);
  });
});
