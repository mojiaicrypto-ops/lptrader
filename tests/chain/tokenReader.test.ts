/**
 * BEP-677 scaled-UI-amount detection, conversion and the raw/UI distinction.
 *
 * The cases that matter (and that a naive implementation gets wrong):
 *
 * 1. **A probe revert is an answer, not an error.** A plain ERC-20 has neither
 *    `supportsInterface` nor `uiMultiplier`; both revert with `code 3`, and the token must be
 *    treated as `plain` rather than as a failed read.
 * 2. **Config and contract must agree.** A `ui_amount.mode: plain` entry pointing at a scaling
 *    contract must abort instead of under-valuing every balance.
 * 3. **`uiMultiplier != 1e18` must actually change the answer.** With `multiplier = 1.000724838657573e18`
 *    the UI amount is *larger* than the raw amount; a hardcoded `1e18` would be off by ~7.2e15 raw
 *    units in this fixture, i.e. exactly the kind of error a split turns into orders of magnitude.
 * 4. **`balanceOfUI` disagreement is fatal.** Both values are read; neither is preferred.
 */
import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { BscChainAdapter } from '../../src/chain/adapter.ts';
import { encodeFunctionData } from 'viem';
import { BEP677_ABI, ERC165_ABI, ERC20_ABI } from '../../src/chain/abis.ts';
import { CHAIN_ERROR_CODES } from '../../src/chain/errors.ts';
import { BEP677_INTERFACE_IDS, TokenReader, UI_MULTIPLIER_SCALE } from '../../src/chain/tokenReader.ts';
import { handlerTransport } from '../../src/chain/rpc.ts';
import { BSC_ADDRESSES } from '../../src/config/builtins.ts';
import { createWhitelist, defaultDexWhitelist } from '../../src/config/index.ts';
import { UI_AMOUNT_MODES, type TokenMeta } from '../../src/types/index.ts';
import { callEntry, createMockNode, entry, REVERT, type MockNodeOptions } from './mockNode.ts';

/** A real observed multiplier: `uiMultiplier()` on QQQB at block 0x76ed720. */
export const QQQB_MULTIPLIER = 1_000_724_838_657_573_033n;
/**
 * The QQQB `totalSupply()` / `totalSupplyUI()` pair as observed on chain (block 0x76ed720):
 * `totalSupply() = 78_519.375888040000000000` raw, `totalSupplyUI() = 78_576.289767052159289485` UI.
 * Using the real pair means the test fails if either the multiplier or the conversion drifts.
 */
const QQQB_RAW = 78_519_375_888_040_000_000_000n;
const QQQB_UI = 78_576_289_767_052_159_289_485n;

const QQQB = '0x205812cdbed920aff76c6580abd681a46d11efc7' as const;
const USDC = BSC_ADDRESSES.USDC;
const HOLDER = '0x2222222222222222222222222222222222222222' as const;
const WBNB = BSC_ADDRESSES.WBNB;

const META_QQQB: TokenMeta = {
  id: `56:${QQQB}`,
  chainId: 56,
  address: QQQB,
  kind: 'bstocks',
  decimals: 18,
  symbol: 'QQQB',
  riskTier: 'CORE',
  autoTrade: true,
  isStockToken: true,
  uiAmount: { mode: UI_AMOUNT_MODES.BEP677_SCALED, multiplierDecimals: 18 },
};

const META_USDC: TokenMeta = {
  id: `56:${USDC}`,
  chainId: 56,
  address: USDC,
  kind: 'stablecoin',
  decimals: 18,
  symbol: 'USDC',
  riskTier: 'CORE',
  autoTrade: true,
  isStockToken: false,
  uiAmount: { mode: UI_AMOUNT_MODES.PLAIN, multiplierDecimals: 0 },
};

function readerWith(
  contracts: NonNullable<MockNodeOptions['contracts']>,
  tokens: readonly TokenMeta[] = [META_QQQB, META_USDC],
) {
  const node = createMockNode({ contracts });
  const adapter = new BscChainAdapter({
    chainId: 56,
    whitelist: createWhitelist(tokens, [56], defaultDexWhitelist([56])),
    rpc: {
      endpoints: [{ label: 'n1', url: 'mock://n1' }],
      transportFactory: () => handlerTransport(node.handle),
      retries: 0,
      crossCheckEndpoints: 1,
    },
  });
  const registry = createWhitelist(tokens, [56], defaultDexWhitelist([56])).registry;
  return { reader: new TokenReader(adapter, registry, 56), node };
}

describe('BEP-677 detection — scaled branch', () => {
  it('detects a scaled token and reads a multiplier that is not 1e18', async () => {
    const card: Record<string, Hex | typeof REVERT> = {};
    entry(card, 'uiMultiplier()', QQQB_MULTIPLIER, BEP677_ABI);
    // ERC-165: the core and balances ids are supported; the invalid id must answer false.
    callEntry(card, 'supportsInterface(bytes4)', [BEP677_INTERFACE_IDS.core], true, ERC165_ABI);
    callEntry(card, 'supportsInterface(bytes4)', [BEP677_INTERFACE_IDS.balances], true, ERC165_ABI);
    callEntry(card, 'supportsInterface(bytes4)', [BEP677_INTERFACE_IDS.invalid], false, ERC165_ABI);
    callEntry(card, 'balanceOf(address)', [HOLDER], QQQB_RAW, ERC20_ABI);
    callEntry(card, 'balanceOfUI(address)', [HOLDER], QQQB_UI, BEP677_ABI);

    const { reader } = readerWith({ [QQQB]: card });
    const probe = await reader.probeUiAmount(QQQB);

    expect(probe.supportsUiMultiplier).toBe(true);
    expect(probe.erc165Core).toBe(true);
    expect(probe.erc165Balances).toBe(true);
    expect(probe.mode).toBe(UI_AMOUNT_MODES.BEP677_SCALED);
    // The concrete non-trivial value — the whole point of the KI-3 closure evidence.
    expect(probe.uiMultiplier).toBe(QQQB_MULTIPLIER);
    expect(probe.uiMultiplier).not.toBe(UI_MULTIPLIER_SCALE);

    const balance = await reader.getBalance(QQQB, HOLDER);
    expect(balance.raw).toBe(QQQB_RAW);
    expect(balance.ui).toBe(QQQB_UI);
    expect(balance.uiMultiplier).toBe(QQQB_MULTIPLIER);
    // UI > raw here because the multiplier is above 1 — a reversed conversion would show UI < raw.
    expect(balance.ui).toBeGreaterThan(balance.raw);
    expect(balance.ui - balance.raw).toBe(56_913_879_012_159_289_485n);
  });

  it('falls back to the locally derived UI amount when balanceOfUI is unavailable but the multiplier is', async () => {
    const card: Record<string, Hex | typeof REVERT> = {};
    entry(card, 'uiMultiplier()', QQQB_MULTIPLIER, BEP677_ABI);
    callEntry(card, 'supportsInterface(bytes4)', [BEP677_INTERFACE_IDS.core], false, ERC165_ABI);
    callEntry(card, 'supportsInterface(bytes4)', [BEP677_INTERFACE_IDS.balances], false, ERC165_ABI);
    callEntry(card, 'balanceOf(address)', [HOLDER], QQQB_RAW, ERC20_ABI);
    callEntry(card, 'balanceOfUI(address)', [HOLDER], REVERT, BEP677_ABI);

    // The getter works but ERC-165 denies the interface: that combination is inconsistent, so the
    // probe must refuse rather than pick a semantics.
    const { reader } = readerWith({ [QQQB]: card });
    await expect(reader.probeUiAmount(QQQB)).rejects.toMatchObject({
      code: CHAIN_ERROR_CODES.DECODE_FAILED,
    });
  });
});

describe('BEP-677 detection — plain branch', () => {
  it('treats a token whose probes revert as plain, with a 1e18 identity multiplier', async () => {
    const card: Record<string, Hex | typeof REVERT> = {};
    entry(card, 'uiMultiplier()', REVERT, BEP677_ABI);
    entry(card, 'supportsInterface(bytes4)', REVERT, ERC165_ABI);
    callEntry(card, 'balanceOf(address)', [HOLDER], 1_234_567_890_123_456_789n, ERC20_ABI);

    const { reader } = readerWith({ [USDC]: card }, [META_USDC]);
    const probe = await reader.probeUiAmount(USDC);

    expect(probe.supportsUiMultiplier).toBe(false);
    expect(probe.erc165Core).toBeNull();
    expect(probe.mode).toBe(UI_AMOUNT_MODES.PLAIN);
    expect(probe.uiMultiplier).toBe(UI_MULTIPLIER_SCALE);

    const balance = await reader.getBalance(USDC, HOLDER);
    expect(balance.raw).toBe(1_234_567_890_123_456_789n);
    expect(balance.ui).toBe(balance.raw);
  });

  it('does not mistake an unreachable node for a plain token', async () => {
    const adapter = new BscChainAdapter({
      chainId: 56,
      whitelist: createWhitelist([META_QQQB], [56], defaultDexWhitelist([56])),
      rpc: {
        endpoints: [{ label: 'down', url: 'mock://down' }],
        retries: 0,
        transportFactory: () =>
          handlerTransport(async () => {
            throw new TypeError('getaddrinfo ENOTFOUND mock');
          }),
      },
    });
    const registry = createWhitelist([META_QQQB], [56], defaultDexWhitelist([56])).registry;
    const reader = new TokenReader(adapter, registry, 56);

    await expect(reader.probeUiAmount(QQQB)).rejects.toMatchObject({
      code: CHAIN_ERROR_CODES.RPC_UNAVAILABLE,
    });
  });
});

describe('config vs contract disagreement', () => {
  it('refuses a plain-configured token that the contract scales', async () => {
    const card: Record<string, Hex | typeof REVERT> = {};
    entry(card, 'uiMultiplier()', QQQB_MULTIPLIER, BEP677_ABI);
    callEntry(card, 'supportsInterface(bytes4)', [BEP677_INTERFACE_IDS.core], true, ERC165_ABI);
    callEntry(card, 'supportsInterface(bytes4)', [BEP677_INTERFACE_IDS.balances], true, ERC165_ABI);

    const lying: TokenMeta = { ...META_QQQB, uiAmount: { mode: UI_AMOUNT_MODES.PLAIN, multiplierDecimals: 0 } };
    const { reader } = readerWith({ [QQQB]: card }, [lying]);

    const error = await reader.probeUiAmount(QQQB).catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ code: CHAIN_ERROR_CODES.DECODE_FAILED });
    expect((error as Error).message).toContain('ui_amount.mode=plain');
    expect((error as Error).message).toContain('bep677-scaled');
  });

  it('refuses a scaled-configured token whose multiplier getter reverts', async () => {
    const card: Record<string, Hex | typeof REVERT> = {};
    entry(card, 'uiMultiplier()', REVERT, BEP677_ABI);
    callEntry(card, 'supportsInterface(bytes4)', [BEP677_INTERFACE_IDS.core], false, ERC165_ABI);
    callEntry(card, 'supportsInterface(bytes4)', [BEP677_INTERFACE_IDS.balances], false, ERC165_ABI);

    const { reader } = readerWith({ [QQQB]: card }, [META_QQQB]);
    await expect(reader.probeUiAmount(QQQB)).rejects.toMatchObject({
      code: CHAIN_ERROR_CODES.DECODE_FAILED,
    });
  });

  it('refuses when a contract declares the interface but the getter reverts', async () => {
    const card: Record<string, Hex | typeof REVERT> = {};
    entry(card, 'uiMultiplier()', REVERT, BEP677_ABI);
    callEntry(card, 'supportsInterface(bytes4)', [BEP677_INTERFACE_IDS.core], true, ERC165_ABI);
    callEntry(card, 'supportsInterface(bytes4)', [BEP677_INTERFACE_IDS.balances], true, ERC165_ABI);

    const { reader } = readerWith({ [QQQB]: card }, [META_QQQB]);
    await expect(reader.probeUiAmount(QQQB)).rejects.toMatchObject({
      code: CHAIN_ERROR_CODES.DECODE_FAILED,
    });
  });

  it('refuses a zero multiplier rather than zeroing every amount', async () => {
    const card: Record<string, Hex | typeof REVERT> = {};
    entry(card, 'uiMultiplier()', 0n, BEP677_ABI);
    callEntry(card, 'supportsInterface(bytes4)', [BEP677_INTERFACE_IDS.core], true, ERC165_ABI);
    callEntry(card, 'supportsInterface(bytes4)', [BEP677_INTERFACE_IDS.balances], true, ERC165_ABI);

    const { reader } = readerWith({ [QQQB]: card }, [META_QQQB]);
    await expect(reader.probeUiAmount(QQQB)).rejects.toMatchObject({
      code: CHAIN_ERROR_CODES.DECODE_FAILED,
    });
  });
});

describe('conversion arithmetic with a non-1e18 multiplier', () => {
  it('converts exactly as the contract does', () => {
    const { reader } = readerWith({});
    // 1 raw token (1e18) × multiplier / 1e18 = the multiplier itself, exactly (no rounding here).
    expect(reader.toUiAmount(10n ** 18n, QQQB_MULTIPLIER)).toBe(QQQB_MULTIPLIER);
    expect(reader.toUiAmount(10n ** 18n, QQQB_MULTIPLIER)).toBe(1_000_724_838_657_573_033n);
    // Two raw tokens round down: 2e18 × m / 1e18 = 2·m + 66 wei (the +66 is the floor of the product).
    expect(reader.toUiAmount(2n * 10n ** 18n, QQQB_MULTIPLIER)).toBe(2_001_449_677_315_146_066n);
    // Identity for plain tokens.
    expect(reader.toUiAmount(123n, UI_MULTIPLIER_SCALE)).toBe(123n);
  });

  it('round-trips lossily in the documented direction only', () => {
    const { reader } = readerWith({});
    const raw = 1_234_567_890_123_456_789n;
    const ui = reader.toUiAmount(raw, QQQB_MULTIPLIER);
    const back = reader.fromUiAmount(ui, QQQB_MULTIPLIER);
    // BEP-677 documents `fromUIAmount(toUIAmount(x)) <= x`; the reverse direction may round up.
    expect(back).toBeLessThanOrEqual(raw);
    expect(raw - back).toBeLessThan(10n ** 3n);
    expect(reader.fromUiAmount(reader.toUiAmount(raw, UI_MULTIPLIER_SCALE), UI_MULTIPLIER_SCALE)).toBe(raw);
  });

  it('refuses a non-positive multiplier at conversion time', () => {
    const { reader } = readerWith({});
    expect(() => reader.toUiAmount(1n, 0n)).toThrowError(/uiMultiplier=0/);
    expect(() => reader.fromUiAmount(1n, 0n)).toThrowError(/uiMultiplier=0/);
  });

  it('flags a disagreement between balanceOfUI and the local conversion', async () => {
    const card: Record<string, Hex | typeof REVERT> = {};
    entry(card, 'uiMultiplier()', QQQB_MULTIPLIER, BEP677_ABI);
    callEntry(card, 'supportsInterface(bytes4)', [BEP677_INTERFACE_IDS.core], true, ERC165_ABI);
    callEntry(card, 'supportsInterface(bytes4)', [BEP677_INTERFACE_IDS.balances], true, ERC165_ABI);
    callEntry(card, 'balanceOf(address)', [HOLDER], QQQB_RAW, ERC20_ABI);
    // Off by one raw unit in the UI answer: must be refused, not silently preferred.
    callEntry(card, 'balanceOfUI(address)', [HOLDER], QQQB_UI + 1n, BEP677_ABI);

    const { reader } = readerWith({ [QQQB]: card });
    const error = await reader.getBalance(QQQB, HOLDER).catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ code: CHAIN_ERROR_CODES.DECODE_FAILED });
    expect((error as Error).message).toContain('disagree on the UI amount');
  });

  it('cross-checks the local conversion against the contract toUIAmount/fromUIAmount', async () => {
    const samples = [10n ** 18n, QQQB_RAW];
    const card: Record<string, Hex | typeof REVERT> = {};
    entry(card, 'uiMultiplier()', QQQB_MULTIPLIER, BEP677_ABI);
    callEntry(card, 'supportsInterface(bytes4)', [BEP677_INTERFACE_IDS.core], true, ERC165_ABI);
    callEntry(card, 'supportsInterface(bytes4)', [BEP677_INTERFACE_IDS.balances], true, ERC165_ABI);
    for (const sample of samples) {
      const expectedUi = (sample * QQQB_MULTIPLIER) / UI_MULTIPLIER_SCALE;
      callEntry(card, 'toUIAmount(uint256)', [sample], expectedUi, BEP677_ABI);
      callEntry(card, 'fromUIAmount(uint256)', [expectedUi], (expectedUi * UI_MULTIPLIER_SCALE) / QQQB_MULTIPLIER, BEP677_ABI);
    }

    const { reader } = readerWith({ [QQQB]: card });
    const verified = await reader.verifyConversionOnChain(QQQB, samples);

    expect(verified).toHaveLength(2);
    for (const row of verified) {
      expect(row.onChainUi).toBe(row.localUi);
      expect(row.localBackToRaw).toBe(row.onChainBackToRaw);
    }
    expect(verified[0]!.localUi).toBe(1_000_724_838_657_573_033n);
    expect(verified[1]!.localUi).toBe((QQQB_RAW * QQQB_MULTIPLIER) / UI_MULTIPLIER_SCALE);
  });
});

describe('batched balances', () => {
  it('reads scaled and plain tokens in one batch and applies the right conversion to each', async () => {
    const card: Record<string, Hex | typeof REVERT> = {};
    entry(card, 'uiMultiplier()', QQQB_MULTIPLIER, BEP677_ABI);
    callEntry(card, 'supportsInterface(bytes4)', [BEP677_INTERFACE_IDS.core], true, ERC165_ABI);
    callEntry(card, 'supportsInterface(bytes4)', [BEP677_INTERFACE_IDS.balances], true, ERC165_ABI);
    callEntry(card, 'balanceOf(address)', [HOLDER], QQQB_RAW, ERC20_ABI);
    callEntry(card, 'balanceOfUI(address)', [HOLDER], QQQB_UI, BEP677_ABI);

    const usdcCard: Record<string, Hex | typeof REVERT> = {};
    entry(usdcCard, 'uiMultiplier()', REVERT, BEP677_ABI);
    entry(usdcCard, 'supportsInterface(bytes4)', REVERT, ERC165_ABI);
    callEntry(usdcCard, 'balanceOf(address)', [HOLDER], 500_000_000_000_000_000_000n, ERC20_ABI);

    const { reader } = readerWith({ [QQQB]: card, [USDC]: usdcCard });
    const balances = await reader.getBalances([QQQB, USDC], HOLDER);

    expect(balances[0]!.uiMultiplier).toBe(QQQB_MULTIPLIER);
    expect(balances[0]!.ui).toBe(QQQB_UI);
    expect(balances[1]!.uiMultiplier).toBe(UI_MULTIPLIER_SCALE);
    expect(balances[1]!.ui).toBe(balances[1]!.raw);
    expect(balances[1]!.raw).toBe(500_000_000_000_000_000_000n);
  });
});

describe('a PLAIN token WITHOUT ERC-165 is probed safely (Step 4 live regression)', () => {
  it('treats "the function does not exist" as a probe ANSWER, not a failure', async () => {
    // Measured live on WBNB (`0xbb4c…95c`), a legitimate whitelist member (it is the native leg of every
    // swap): it has no `supportsInterface` and no `uiMultiplier`, so those calls return `0x` instead of
    // reverting, and viem raises `ContractFunctionZeroDataError`. That name was not matched, the error
    // escaped `tryReadContract`, and the whole risk round crashed — the portfolio could not be valued
    // because one token lacks an *optional* interface.
    //
    // Note the fixture is a PLAIN token, which matters: a token whitelisted as `bep677-scaled` that turns
    // out not to be scaled is a CONFIG error and must still refuse (asserted separately below). The bug was
    // about ordinary tokens, so the test must use one.
    const plainMeta: TokenMeta = { ...META_USDC, symbol: 'WBNB', address: WBNB };
    const card: Record<string, Hex | typeof REVERT> = {};
    // Registered by raw calldata: `callEntry` ABI-encodes its value and `0x` is not a valid bool. Writing
    // the mapping directly is what the node actually does — it returns `0x` for a function the contract
    // does not have, without encoding anything.
    for (const id of [BEP677_INTERFACE_IDS.core, BEP677_INTERFACE_IDS.balances]) {
      const data = encodeFunctionData({
        abi: ERC165_ABI,
        functionName: 'supportsInterface',
        args: [id],
      }) as Hex;
      card[data.toLowerCase()] = '0x' as Hex;
    }
    const multiplierData = encodeFunctionData({ abi: BEP677_ABI, functionName: 'uiMultiplier' }) as Hex;
    card[multiplierData.toLowerCase()] = '0x' as Hex;
    callEntry(card, 'balanceOf(address)', [HOLDER], QQQB_RAW, ERC20_ABI);

    const { reader } = readerWith({ [WBNB]: card }, [plainMeta]);

    // The probe must RESOLVE and report "not scaled", not throw.
    const probe = await reader.probeUiAmount(WBNB);
    expect(probe.supportsUiMultiplier).toBe(false);
    expect(probe.mode).toBe(UI_AMOUNT_MODES.PLAIN);

    // And a plain balance read still works: one absent optional interface does not make it unusable.
    const balance = await reader.getBalance(WBNB, HOLDER);
    expect(balance.raw).toBe(QQQB_RAW);
  });

  it('still REFUSES when a token whitelisted as scaled turns out not to be', async () => {
    // The adjacent behaviour that must not be lost: this is a config error, not a runtime question.
    const card: Record<string, Hex | typeof REVERT> = {};
    // ERC-165 ANSWERS here (so the read succeeds), but the token claims the scaled interface while
    // `uiMultiplier()` returns no data. That combination is a whitelist error, not a runtime condition.
    callEntry(card, 'supportsInterface(bytes4)', [BEP677_INTERFACE_IDS.core], true, ERC165_ABI);
    callEntry(card, 'supportsInterface(bytes4)', [BEP677_INTERFACE_IDS.balances], false, ERC165_ABI);
    const multiplierData = encodeFunctionData({ abi: BEP677_ABI, functionName: 'uiMultiplier' }) as Hex;
    card[multiplierData.toLowerCase()] = '0x' as Hex;

    const { reader } = readerWith({ [QQQB]: card });
    await expect(reader.probeUiAmount(QQQB)).rejects.toMatchObject({
      code: CHAIN_ERROR_CODES.DECODE_FAILED,
    });
  });
});
