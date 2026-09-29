import type {
  Address,
  ChainId,
  Hex,
  TokenId,
  TokenKind,
  TokenRiskTier,
} from './primitives.ts';

/**
 * How to convert raw ERC-20 amounts into the amount an integrator may treat as money.
 *
 * `plain`          : UI amount === raw amount (ordinary ERC-20 / WBNB).
 * `bep677-scaled`  : UI amount === raw * uiMultiplier / 1e18, where uiMultiplier is read at
 *                    runtime (`uiMultiplier()`); dividends/splits change the multiplier only.
 *                    Round-trips are NOT lossless (fromUIAmount(toUIAmount(x)) <= x).
 *                    Never hardcode the multiplier (research §2, scope-corrections C4).
 */
export const UI_AMOUNT_MODES = {
  PLAIN: 'plain',
  BEP677_SCALED: 'bep677-scaled',
} as const;
export type UiAmountMode = (typeof UI_AMOUNT_MODES)[keyof typeof UI_AMOUNT_MODES];

export interface UiAmountPolicy {
  readonly mode: UiAmountMode;
  /** Decimals of the multiplier itself; 18 for BEP-677. 0 when `mode === 'plain'`. */
  readonly multiplierDecimals: number;
  /** ERC-165 interface ids to probe when the adapter validates the contract (research §2.5). */
  readonly erc165Interfaces?: {
    readonly core?: Hex;
    readonly newUiMultiplier?: Hex;
    readonly conversion?: Hex;
    readonly balances?: Hex;
    readonly scheduled?: Hex;
  };
}

/**
 * A whitelisted token, as loaded from `config/tokens.yaml` + `config/stablecoins.yaml`
 * (baseline §86/§87).
 *
 * IDENTITY RULE (baseline §8): the primary key is always (chainId, lowercased address).
 * `symbol` is a display alias only — it must never be used to resolve, compare or authorise
 * a token (research §1 shows same-symbol impostors and inconsistent on-chain casing).
 */
export interface TokenMeta {
  /** Canonical key: `${chainId}:${lowercased address}`. */
  readonly id: TokenId;
  readonly chainId: ChainId;
  /** Canonical (lowercased) contract address. Compare only lowercased. */
  readonly address: Address;
  readonly kind: TokenKind;
  /** ERC-20 `decimals()` as reported on chain. BSC USDC/USDT are 18 (research §1). */
  readonly decimals: number;
  /** DISPLAY ONLY. Never an identity, never an authorisation input. */
  readonly symbol: string;
  /** DISPLAY ONLY. */
  readonly name?: string;
  /** §9 risk tier. Only `CORE` is auto-traded in V1. */
  readonly riskTier: TokenRiskTier;
  /** Whether the strategy may currently trade this token (§9: HIGH_VOL defaults to false). */
  readonly autoTrade: boolean;
  /** True for tokenised-stock legs (§9-§15 stock token side). */
  readonly isStockToken: boolean;
  readonly uiAmount: UiAmountPolicy;
  /** §87 stablecoin priority; lower = preferred (USDC=1 < USDT=2). Stablecoins only. */
  readonly stablecoinPriority?: number;
  /** Free-text provenance note (e.g. "Binance-Peg, not Circle-native"). */
  readonly notes?: string;
}

/**
 * A token amount, carrying BOTH representations so they can never be confused.
 *
 * - `raw` is the ERC-20 base unit (what `balanceOf`/`totalSupply` return, what goes into
 *   calldata / an approval / a transfer). Amounts that will be SIGNED must be built from `raw`.
 * - `ui` is the amount an integrator may treat as money (`raw * uiMultiplier / 1e18`), used for
 *   USD valuation, NAV, ratios and threshold comparisons. For `plain` tokens `ui === raw`.
 * - `uiMultiplier` records the exact multiplier used (1e18 for plain tokens) so any computed
 *   figure can be re-derived and audited (BEP-677 splits/dividends change only the multiplier).
 *
 * Never build one from the other implicitly outside `tokenReader`; never assume 1e18.
 */
export interface TokenAmount {
  readonly tokenId: TokenId;
  readonly address: Address;
  readonly decimals: number;
  readonly raw: bigint;
  readonly ui: bigint;
  readonly uiMultiplier: bigint;
}
