/**
 * Token balance + BEP-677 "Scaled UI Amount" conversion (T5).
 *
 * ## Why this file exists
 *
 * bStocks do not change their raw balances on a dividend or a split — only `uiMultiplier()` moves.
 * So `balanceOf()` is *not* the amount of money a holder owns. Every economic figure (NAV, reserve
 * ratio, USD valuation, swap sizing) must use the UI amount, while everything that gets **signed**
 * (calldata, approvals, transfers) must use the raw amount. Keeping both in `TokenAmount` and
 * computing them in exactly one place is what makes that distinction impossible to get wrong.
 *
 * ## The three rules encoded here
 *
 * 1. **Never hardcode `1e18`.** The multiplier is read at runtime and travels with the amount.
 * 2. **Never assume the policy in config is the contract's behaviour.** The registry says what a
 *    token is *expected* to be; the contract is probed, and a disagreement is a hard failure. A
 *    contract that silently starts scaling while config says `plain` would otherwise be valued at
 *    `raw` — a 0.07%-and-growing error today, unbounded after a split.
 * 3. **Never substitute a value.** `balanceOfUI` is used when the contract exposes it, and its
 *    answer must agree with the locally computed `raw * multiplier / 1e18`; a disagreement throws
 *    instead of picking a winner.
 */
import type { BscChainAdapter } from './adapter.ts';
import { BEP677_ABI, ERC20_ABI, ERC165_ABI, MULTICALL3_AGGREGATE3_ABI } from './abis.ts';
import { ChainError, CHAIN_ERROR_CODES } from './errors.ts';
import { MULTICALL3_ADDRESS, type RpcProvenance } from './rpc.ts';
import type { Address, ChainId, Hex } from '../types/primitives.ts';
import type { TokenAmount, TokenMeta } from '../types/token.ts';
import { UI_AMOUNT_MODES, type UiAmountMode } from '../types/token.ts';
import type { TokenRegistry } from '../types/registry.ts';
import { encodeFunctionData } from 'viem';

/** The scaling denominator. BEP-677 fixes it at 1e18; the *value* of the multiplier is what varies. */
export const UI_MULTIPLIER_SCALE = 10n ** 18n;

/**
 * ERC-165 interface ids of the BEP-677 surface (research §2.5 item 5).
 *
 * Note the coincidence that matters for detection: the **core** interface id `0xa60bf13d` is also
 * the function selector of `uiMultiplier()`. It is decoded as a `bytes4` here and used only as an
 * ERC-165 probe id; the deployment's ABI binding declares the selector explicitly.
 */
export const BEP677_INTERFACE_IDS = {
  core: '0xa60bf13d',
  newUiMultiplier: '0x4bd27648',
  conversion: '0x57854fc3',
  balances: '0xd890fd71',
  scheduled: '0xeb0093dd',
  /** EIP-165's mandatory "does not exist" id: a correct implementation always answers `false`. */
  invalid: '0xffffffff',
} as const;

/** How the scaled-UI-amount verdict was reached, kept for audit. */
export interface Bep677Probe {
  readonly address: Address;
  /**
   * `true` = the direct `uiMultiplier()` probe returned a value (conclusive).
   * `false` = it reverted, i.e. the contract has no multiplier getter.
   */
  readonly supportsUiMultiplier: boolean;
  /** Result of `supportsInterface(0xa60bf13d)`: `true`/`false`, or `null` when the call reverted. */
  readonly erc165Core: boolean | null;
  readonly erc165Balances: boolean | null;
  /** The multiplier read from chain; `1e18` for `plain` tokens (identity scaling). */
  readonly uiMultiplier: bigint;
  readonly mode: UiAmountMode;
  readonly asOfBlock: bigint;
  readonly provenance: RpcProvenance;
}

export interface TokenReaderOptions {
  /**
   * How long a probed `uiMultiplier`/mode may be reused. A corporate action changes the multiplier
   * at a known effective time, but the bot cannot rely on being told, so the value is refreshed
   * periodically rather than cached forever.
   */
  readonly cacheTtlMs?: number;
  readonly now?: () => number;
}

interface CachedProbe {
  readonly probe: Bep677Probe;
  readonly expiresAtMs: number;
}

/**
 * Reads token state and converts between raw and UI amounts.
 *
 * One instance per process is fine: the probe cache is keyed by address and bounded by TTL.
 */
export class TokenReader {
  private readonly adapter: BscChainAdapter;
  private readonly registry: TokenRegistry;
  private readonly chainId: ChainId;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private readonly probeCache: Record<string, CachedProbe> = {};

  constructor(
    adapter: BscChainAdapter,
    registry: TokenRegistry,
    chainId: ChainId,
    options: TokenReaderOptions = {},
  ) {
    this.adapter = adapter;
    this.registry = registry;
    this.chainId = chainId;
    this.cacheTtlMs = options.cacheTtlMs ?? 300_000;
    this.now = options.now ?? (() => Date.now());
  }

  /** §8 identity: an unwhitelisted address is never read, and its `TokenMeta` is the only source of decimals. */
  tokenMeta(tokenAddress: Address): TokenMeta {
    return this.registry.requireTokenByAddress(this.chainId, tokenAddress);
  }

  /**
   * Probe a token for the BEP-677 scaled-UI-amount surface and read its current multiplier.
   *
   * The verdict comes from two independent signals and a disagreement between them is fatal, because
   * a contract that implements only half the interface is a contract whose balance semantics this
   * project does not understand:
   *
   * - `supportsInterface(0xa60bf13d)` — the declared core interface.
   * - `uiMultiplier()` — the actual getter. A returned value is conclusive: the contract scales.
   *
   * A revert on either call is `null`/`false`, not an error: a plain ERC-20 has neither.
   */
  async probeUiAmount(tokenAddress: Address): Promise<Bep677Probe> {
    const meta = this.tokenMeta(tokenAddress);
    const cached = this.probeCache[meta.address];
    if (cached !== undefined && cached.expiresAtMs > this.now()) {
      return cached.probe;
    }

    const [coreResult, balancesResult, multiplierResult, blockNumber] = await Promise.all([
      this.adapter.tryReadContract<boolean>({
        address: meta.address,
        abi: ERC165_ABI,
        functionName: 'supportsInterface',
        args: [BEP677_INTERFACE_IDS.core as Hex],
      }),
      this.adapter.tryReadContract<boolean>({
        address: meta.address,
        abi: ERC165_ABI,
        functionName: 'supportsInterface',
        args: [BEP677_INTERFACE_IDS.balances as Hex],
      }),
      this.adapter.tryReadContract<bigint>({
        address: meta.address,
        abi: BEP677_ABI,
        functionName: 'uiMultiplier',
      }),
      this.adapter.getBlockNumber(),
    ]);

    const erc165Core = coreResult.value;
    const erc165Balances = balancesResult.value;
    const onChainMultiplier = multiplierResult.value;
    const supportsUiMultiplier = onChainMultiplier !== null;

    // Divergence 1: the contract declares the core interface but the getter reverts. We would have to
    // guess the multiplier; refuse instead.
    if (erc165Core === true && !supportsUiMultiplier) {
      throw new ChainError(
        CHAIN_ERROR_CODES.DECODE_FAILED,
        `${meta.symbol} declares ERC-165 ${BEP677_INTERFACE_IDS.core} but uiMultiplier() reverts; ` +
          'the scaled-UI-amount surface is inconsistent — refusing to value this token',
        { address: meta.address, symbol: meta.symbol },
      );
    }
    // Divergence 2: the getter works but the contract explicitly denies the interface.
    if (erc165Core === false && supportsUiMultiplier) {
      throw new ChainError(
        CHAIN_ERROR_CODES.DECODE_FAILED,
        `${meta.symbol} returns a uiMultiplier() but denies ERC-165 ${BEP677_INTERFACE_IDS.core}; ` +
          'refusing to value this token',
        { address: meta.address, symbol: meta.symbol },
      );
    }

    const declaredMode = meta.uiAmount.mode;
    const observedMode = supportsUiMultiplier ? UI_AMOUNT_MODES.BEP677_SCALED : UI_AMOUNT_MODES.PLAIN;

    // Config and contract must agree. Neither direction is benign: a `plain` config on a scaled
    // contract under-values every balance, and a `scaled` config on a plain contract makes
    // `toUIAmount` a no-op that looks like a silent 0% multiplier.
    if (declaredMode !== observedMode) {
      throw new ChainError(
        CHAIN_ERROR_CODES.DECODE_FAILED,
        `${meta.symbol} is configured as ui_amount.mode=${declaredMode} but the contract behaves as ` +
          `${observedMode} (uiMultiplier() ${supportsUiMultiplier ? 'returned a value' : 'reverted'}); ` +
          'fix the token whitelist entry — refusing to value this token',
        { address: meta.address, declaredMode, observedMode },
      );
    }

    const uiMultiplier = supportsUiMultiplier ? (onChainMultiplier as bigint) : UI_MULTIPLIER_SCALE;
    if (uiMultiplier <= 0n) {
      throw new ChainError(
        CHAIN_ERROR_CODES.DECODE_FAILED,
        `${meta.symbol} reports uiMultiplier()=${uiMultiplier}; a zero/negative multiplier would zero out every amount`,
        { address: meta.address, multiplier: uiMultiplier.toString() },
      );
    }

    const probe: Bep677Probe = {
      address: meta.address,
      supportsUiMultiplier,
      erc165Core,
      erc165Balances,
      uiMultiplier,
      mode: observedMode,
      asOfBlock: blockNumber,
      provenance: multiplierResult.provenance,
    };
    this.probeCache[meta.address] = { probe, expiresAtMs: this.now() + this.cacheTtlMs };
    return probe;
  }

  /**
   * `ui = raw * multiplier / 1e18`, floored — the same integer semantics as the contract's
   * `toUIAmount()`, so the local result is comparable with the on-chain one.
   */
  toUiAmount(raw: bigint, uiMultiplier: bigint): bigint {
    if (uiMultiplier <= 0n) {
      throw new ChainError(
        CHAIN_ERROR_CODES.INVALID_ARGUMENT,
        `toUiAmount received uiMultiplier=${uiMultiplier}; refusing to compute an amount with it`,
      );
    }
    return (raw * uiMultiplier) / UI_MULTIPLIER_SCALE;
  }

  /**
   * Inverse of `toUiAmount`: `raw = ui * 1e18 / multiplier`.
   *
   * Round-trips are **not** lossless in the direction the contract documents:
   * `fromUiAmount(toUiAmount(x)) <= x`, because both steps floor. That is safe for the only use this
   * project has — turning a UI-denominated *minimum* back into a raw bound — and is never used to
   * reconstruct a balance.
   */
  fromUiAmount(ui: bigint, uiMultiplier: bigint): bigint {
    if (uiMultiplier <= 0n) {
      throw new ChainError(
        CHAIN_ERROR_CODES.INVALID_ARGUMENT,
        `fromUiAmount received uiMultiplier=${uiMultiplier}; refusing to compute an amount with it`,
      );
    }
    return (ui * UI_MULTIPLIER_SCALE) / uiMultiplier;
  }

  /**
   * Read a holder's balance as a `TokenAmount` (raw + ui + the multiplier used).
   *
   * When the contract exposes `balanceOfUI()`, both it and `balanceOf()` are read and the on-chain UI
   * value must match the locally derived one. Reading only `balanceOfUI()` would leave the raw value
   * — the value that gets signed — unknown; reading only `balanceOf()` would trust our own
   * arithmetic over the issuer's.
   */
  async getBalance(tokenAddress: Address, holder: Address): Promise<TokenAmount> {
    const meta = this.tokenMeta(tokenAddress);
    const probe = await this.probeUiAmount(meta.address);

    const [rawResult, uiResult] = await Promise.all([
      this.adapter.readContract<bigint>({
        address: meta.address,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [holder],
      }),
      probe.supportsUiMultiplier
        ? this.adapter.readContract<bigint>({
            address: meta.address,
            abi: BEP677_ABI,
            functionName: 'balanceOfUI',
            args: [holder],
          })
        : Promise.resolve(null),
    ]);

    const raw = rawResult.value;
    const locallyDerived = this.toUiAmount(raw, probe.uiMultiplier);

    if (uiResult !== null && uiResult.value !== locallyDerived) {
      throw new ChainError(
        CHAIN_ERROR_CODES.DECODE_FAILED,
        `${meta.symbol} balanceOfUI(${holder}) returned ${uiResult.value} but ` +
          `balanceOf=${raw} × uiMultiplier=${probe.uiMultiplier} / 1e18 = ${locallyDerived}; ` +
          'the contract and this project disagree on the UI amount — refusing to report a balance',
        {
          address: meta.address,
          holder,
          onChainUi: uiResult.value.toString(),
          localUi: locallyDerived.toString(),
        },
      );
    }

    return {
      tokenId: meta.id,
      address: meta.address,
      decimals: meta.decimals,
      raw,
      ui: uiResult === null ? locallyDerived : uiResult.value,
      uiMultiplier: probe.uiMultiplier,
    };
  }

  /**
   * Batched form of `getBalance` for the portfolio monitor: one multicall for every `balanceOf`,
   * plus one multicall for the `balanceOfUI` legs (only the scaled tokens need one).
   */
  async getBalances(
    tokenAddresses: readonly Address[],
    holder: Address,
  ): Promise<readonly TokenAmount[]> {
    if (tokenAddresses.length === 0) return [];
    const metas = tokenAddresses.map((address) => this.tokenMeta(address));
    const probes = await Promise.all(metas.map((meta) => this.probeUiAmount(meta.address)));

    const rawBalances = await this.multicall(
      metas.map((meta) => ({
        target: meta.address,
        callData: encodeFunctionData({
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [holder],
        }),
      })),
    );

    const scaledIndexes = probes
      .map((probe, index) => (probe.supportsUiMultiplier ? index : -1))
      .filter((index) => index >= 0);
    const uiBalances =
      scaledIndexes.length === 0
        ? []
        : await this.multicall(
            scaledIndexes.map((index) => ({
              target: metas[index]!.address,
              callData: encodeFunctionData({
                abi: BEP677_ABI,
                functionName: 'balanceOfUI',
                args: [holder],
              }),
            })),
          );

    const uiByIndex: Record<number, bigint> = {};
    scaledIndexes.forEach((index, position) => {
      uiByIndex[index] = uiBalances[position]!.value;
    });

    return metas.map((meta, index) => {
      const probe = probes[index]!;
      const raw = rawBalances[index]!.value;
      const locallyDerived = this.toUiAmount(raw, probe.uiMultiplier);
      const onChainUi = uiByIndex[index];
      if (onChainUi !== undefined && onChainUi !== locallyDerived) {
        throw new ChainError(
          CHAIN_ERROR_CODES.DECODE_FAILED,
          `${meta.symbol} balanceOfUI(${holder}) returned ${onChainUi} but balanceOf=${raw} × ` +
            `uiMultiplier=${probe.uiMultiplier} / 1e18 = ${locallyDerived}; refusing to report a balance`,
          { address: meta.address, holder, onChainUi: onChainUi.toString(), localUi: locallyDerived.toString() },
        );
      }
      return {
        tokenId: meta.id,
        address: meta.address,
        decimals: meta.decimals,
        raw,
        ui: onChainUi ?? locallyDerived,
        uiMultiplier: probe.uiMultiplier,
      };
    });
  }

  /**
   * Cross-check this project's conversion against the contract's own `toUIAmount()`/`fromUIAmount()`.
   *
   * This is the strongest available evidence that the local integer arithmetic is right: for a
   * non-1e18 multiplier the two must agree exactly. Used by the smoke script (KI-3 closure) and by
   * tests; not called per balance read, because it doubles the read cost for no per-tick benefit.
   */
  async verifyConversionOnChain(
    tokenAddress: Address,
    rawSamples: readonly bigint[],
  ): Promise<
    readonly {
      readonly raw: bigint;
      readonly onChainUi: bigint;
      readonly localUi: bigint;
      readonly onChainBackToRaw: bigint;
      readonly localBackToRaw: bigint;
    }[]
  > {
    const meta = this.tokenMeta(tokenAddress);
    const probe = await this.probeUiAmount(meta.address);
    if (!probe.supportsUiMultiplier) {
      return rawSamples.map((raw) => ({
        raw,
        onChainUi: raw,
        localUi: raw,
        onChainBackToRaw: raw,
        localBackToRaw: raw,
      }));
    }

    return Promise.all(
      rawSamples.map(async (raw) => {
        const [toUi, fromUi] = await Promise.all([
          this.adapter.readContract<bigint>({
            address: meta.address,
            abi: BEP677_ABI,
            functionName: 'toUIAmount',
            args: [raw],
          }),
          this.adapter.readContract<bigint>({
            address: meta.address,
            abi: BEP677_ABI,
            functionName: 'fromUIAmount',
            args: [this.toUiAmount(raw, probe.uiMultiplier)],
          }),
        ]);
        return {
          raw,
          onChainUi: toUi.value,
          localUi: this.toUiAmount(raw, probe.uiMultiplier),
          onChainBackToRaw: fromUi.value,
          localBackToRaw: this.fromUiAmount(
            this.toUiAmount(raw, probe.uiMultiplier),
            probe.uiMultiplier,
          ),
        };
      }),
    );
  }

  /** Multicall3 batch through the adapter's RPC pool (cross-checked when more than one endpoint). */
  private async multicall(
    calls: readonly { readonly target: Address; readonly callData: Hex }[],
  ): Promise<readonly { readonly success: boolean; readonly value: bigint }[]> {
    const responses = await this.adapter.readContract<readonly { success: boolean; returnData: Hex }[]>({
      address: MULTICALL3_ADDRESS,
      abi: MULTICALL3_AGGREGATE3_ABI,
      functionName: 'aggregate3',
      args: [calls.map((call) => ({ target: call.target, allowFailure: false, callData: call.callData }))],
    });
    return responses.value.map((response) => ({
      success: response.success,
      value: BigInt(response.returnData),
    }));
  }
}
