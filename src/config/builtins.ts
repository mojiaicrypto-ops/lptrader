import { DEX_IDS, TOKEN_KINDS, TOKEN_RISK_TIERS } from '../types/primitives.ts';
import { UI_AMOUNT_MODES, type TokenMeta } from '../types/token.ts';
import type { Address, ChainId } from '../types/primitives.ts';

/**
 * Facts that MUST be built into the whitelist (research `onchain-facts-2026-09-29.md` §1).
 *
 * These are defaults, not hardcoded truth that config cannot correct: `config/tokens.yaml` and
 * `config/stablecoins.yaml` may override any attribute of an entry **by address**, and may add
 * extra tokens. Entries defined here can never be removed through config, so a truncated or
 * empty YAML file cannot silently widen or narrow the address whitelist (fail closed).
 */

/** §11 chain whitelist. V1 = BNB Chain only. */
export const SUPPORTED_CHAINS: readonly ChainId[] = [56];

export const BSC_CHAIN_ID = 56;

/** The only DEXes allowed in V1 (§12). */
export const WHITELIST_DEXES = [DEX_IDS.UNISWAP_V3, DEX_IDS.PANCAKESWAP_V3] as const;

/**
 * Known-good contract addresses for BNB Chain (chainId 56), from research §1 and §4.2/§4.3.
 * Used to cross-check config input: a config entry that claims a canonical role (WBNB) with a
 * different address is rejected instead of silently trusted.
 */
export const BSC_ADDRESSES = {
  /** WBNB — the native leg of every swap. Asserted against `WNATIVE[56]` (research §4.2). */
  WBNB: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
  /** Binance-Peg USDC (18 decimals, NOT Circle-native). */
  USDC: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
  /** Binance-Peg USDT (18 decimals). */
  USDT: '0x55d398326f99059ff775485246999027b3197955',
  MULTICALL3: '0xca11bde05977b3631167028862be2a173976ca11',
} as const satisfies Record<string, Address>;

/**
 * bStocks share tokens (Binance/BTECH Holdings), all 18 decimals, all BEP-677 scaled UI amount.
 * Risk tier per §9: CORE = QQQB/MSFTB/AAPLB/AMZNB/METAB, HIGH_VOL = NVDAB/TSLAB/PLTRB.
 * `auto_trade` defaults false for HIGH_VOL (§9: monitor only in V1).
 */
export const BSC_BSTOCKS: readonly TokenMeta[] = [
  {
    id: '56:0x205812cdbed920aff76c6580abd681a46d11efc7',
    chainId: BSC_CHAIN_ID,
    address: '0x205812cdbed920aff76c6580abd681a46d11efc7',
    kind: TOKEN_KINDS.BSTOCKS,
    decimals: 18,
    symbol: 'QQQB',
    name: 'Invesqo QQQ',
    riskTier: TOKEN_RISK_TIERS.CORE,
    autoTrade: true,
    isStockToken: true,
    uiAmount: { mode: UI_AMOUNT_MODES.BEP677_SCALED, multiplierDecimals: 18 },
    notes: 'Binance bStocks; on-chain name is "Invesqo QQQ" (misspelling is expected).',
  },
  {
    id: '56:0x80106cb3ead06659a5ad19df39d9b4733863b9b0',
    chainId: BSC_CHAIN_ID,
    address: '0x80106cb3ead06659a5ad19df39d9b4733863b9b0',
    kind: TOKEN_KINDS.BSTOCKS,
    decimals: 18,
    symbol: 'MSFTB',
    riskTier: TOKEN_RISK_TIERS.CORE,
    autoTrade: true,
    isStockToken: true,
    uiAmount: { mode: UI_AMOUNT_MODES.BEP677_SCALED, multiplierDecimals: 18 },
    notes: 'Binance bStocks; 8-decimal same-symbol impostors exist on BSC — address only.',
  },
  {
    id: '56:0x431a3bee82e2ca41e49895cbece5bb0f76a89b7a',
    chainId: BSC_CHAIN_ID,
    address: '0x431a3bee82e2ca41e49895cbece5bb0f76a89b7a',
    kind: TOKEN_KINDS.BSTOCKS,
    decimals: 18,
    symbol: 'AAPLB',
    riskTier: TOKEN_RISK_TIERS.CORE,
    autoTrade: true,
    isStockToken: true,
    uiAmount: { mode: UI_AMOUNT_MODES.BEP677_SCALED, multiplierDecimals: 18 },
    notes: 'Binance bStocks; no APRO price feed exists (research §3).',
  },
  {
    id: '56:0x1a4b499833a79a09ad7cf1d42d7dacf71e92eb00',
    chainId: BSC_CHAIN_ID,
    address: '0x1a4b499833a79a09ad7cf1d42d7dacf71e92eb00',
    kind: TOKEN_KINDS.BSTOCKS,
    decimals: 18,
    symbol: 'AMZNB',
    riskTier: TOKEN_RISK_TIERS.CORE,
    autoTrade: true,
    isStockToken: true,
    uiAmount: { mode: UI_AMOUNT_MODES.BEP677_SCALED, multiplierDecimals: 18 },
    notes: 'Binance bStocks; no APRO price feed exists (research §3).',
  },
  {
    id: '56:0x7425889fe94f9d693e8daefe88bcced6acfef4c0',
    chainId: BSC_CHAIN_ID,
    address: '0x7425889fe94f9d693e8daefe88bcced6acfef4c0',
    kind: TOKEN_KINDS.BSTOCKS,
    decimals: 18,
    symbol: 'METAB',
    riskTier: TOKEN_RISK_TIERS.CORE,
    autoTrade: true,
    isStockToken: true,
    uiAmount: { mode: UI_AMOUNT_MODES.BEP677_SCALED, multiplierDecimals: 18 },
    notes: 'Binance bStocks; on-chain ticker was observed lowercase (research §1).',
  },
  {
    id: '56:0x02fca66c1d1afb4e2a7884261eb00f63598a7436',
    chainId: BSC_CHAIN_ID,
    address: '0x02fca66c1d1afb4e2a7884261eb00f63598a7436',
    kind: TOKEN_KINDS.BSTOCKS,
    decimals: 18,
    symbol: 'NVDAB',
    riskTier: TOKEN_RISK_TIERS.HIGH_VOL,
    autoTrade: false,
    isStockToken: true,
    uiAmount: { mode: UI_AMOUNT_MODES.BEP677_SCALED, multiplierDecimals: 18 },
    notes: 'HIGH_VOL: monitor only in V1 (§9).',
  },
  {
    id: '56:0x5b1910eaad6450e50f816082aa078c41f10c292f',
    chainId: BSC_CHAIN_ID,
    address: '0x5b1910eaad6450e50f816082aa078c41f10c292f',
    kind: TOKEN_KINDS.BSTOCKS,
    decimals: 18,
    symbol: 'TSLAB',
    riskTier: TOKEN_RISK_TIERS.HIGH_VOL,
    autoTrade: false,
    isStockToken: true,
    uiAmount: { mode: UI_AMOUNT_MODES.BEP677_SCALED, multiplierDecimals: 18 },
    notes: 'HIGH_VOL: monitor only in V1 (§9). 2-4 same-symbol 8-decimal impostors exist.',
  },
  {
    id: '56:0x0ca5d51d0277bd006fd9607d3e560785ebad8222',
    chainId: BSC_CHAIN_ID,
    address: '0x0ca5d51d0277bd006fd9607d3e560785ebad8222',
    kind: TOKEN_KINDS.BSTOCKS,
    decimals: 18,
    symbol: 'PLTRB',
    riskTier: TOKEN_RISK_TIERS.HIGH_VOL,
    autoTrade: false,
    isStockToken: true,
    uiAmount: { mode: UI_AMOUNT_MODES.BEP677_SCALED, multiplierDecimals: 18 },
    notes: 'HIGH_VOL: monitor only in V1 (§9); no Chainlink equity feed exists.',
  },
];

/**
 * Stablecoins (§10) and the wrapped native leg. BSC USDC/USDT are **18 decimals** — hardcoding 6
 * would introduce a $10^12 error (research §1).
 */
export const BSC_STABLECOINS: readonly TokenMeta[] = [
  {
    id: '56:0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
    chainId: BSC_CHAIN_ID,
    address: BSC_ADDRESSES.USDC,
    kind: TOKEN_KINDS.STABLECOIN,
    decimals: 18,
    symbol: 'USDC',
    riskTier: TOKEN_RISK_TIERS.CORE,
    autoTrade: true,
    isStockToken: false,
    uiAmount: { mode: UI_AMOUNT_MODES.PLAIN, multiplierDecimals: 0 },
    stablecoinPriority: 1,
    notes: 'Binance-Peg USDC (not Circle-native); 18 decimals.',
  },
  {
    id: '56:0x55d398326f99059ff775485246999027b3197955',
    chainId: BSC_CHAIN_ID,
    address: BSC_ADDRESSES.USDT,
    kind: TOKEN_KINDS.STABLECOIN,
    decimals: 18,
    symbol: 'USDT',
    riskTier: TOKEN_RISK_TIERS.CORE,
    autoTrade: true,
    isStockToken: false,
    uiAmount: { mode: UI_AMOUNT_MODES.PLAIN, multiplierDecimals: 0 },
    stablecoinPriority: 2,
    notes: 'Binance-Peg USDT; 18 decimals; requires ZERO_THEN_MAX approval (research §4.2).',
  },
];

export const BSC_WRAPPED_NATIVE: readonly TokenMeta[] = [
  {
    id: '56:0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
    chainId: BSC_CHAIN_ID,
    address: BSC_ADDRESSES.WBNB,
    kind: TOKEN_KINDS.WRAPPED_NATIVE,
    decimals: 18,
    symbol: 'WBNB',
    riskTier: TOKEN_RISK_TIERS.CORE,
    autoTrade: false,
    isStockToken: false,
    uiAmount: { mode: UI_AMOUNT_MODES.PLAIN, multiplierDecimals: 0 },
    notes: 'Native leg wrapper; must equal WNATIVE[56] before any native-value swap.',
  },
];

/** Everything the whitelist starts from when config supplies nothing. */
export const BUILTIN_TOKENS: readonly TokenMeta[] = [
  ...BSC_BSTOCKS,
  ...BSC_STABLECOINS,
  ...BSC_WRAPPED_NATIVE,
];

/**
 * DEX contract addresses for BNB Chain (research §4.2 / §4.3).
 * PancakeSwap's Permit2 is NOT the Uniswap canonical address; note the dedicated deployment.
 * `@pancakeswap/chains@0.10.0` has no `contracts` block for chain 56, so these constants are the
 * source used by the adapters — they MUST stay here rather than being read from the SDK.
 */
export interface DexContracts {
  readonly factory: Address;
  readonly positionManager: Address;
  readonly swapRouter: Address;
  readonly quoterV2: Address;
  readonly tickLens: Address;
  readonly permit2: Address;
  readonly universalRouter?: Address;
}

export const BSC_DEX_CONTRACTS: Readonly<Record<string, DexContracts>> = {
  [DEX_IDS.PANCAKESWAP_V3]: {
    factory: '0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865',
    positionManager: '0x46a15b0b27311cedf172ab29e4f4766fbe7f4364',
    swapRouter: '0x1b81d678ffb9c0263b24a97847620c99d213eb14',
    quoterV2: '0xb048bbc1ee6b733fffcfb9e9cef7375518e25997',
    tickLens: '0x9a489505a00ce272eaa5e07dba6491314cae3796',
    // Pancake's own Permit2 deployment — NOT Uniswap's canonical 0x0000...78BA3.
    permit2: '0x31c2f6fcff4f8759b3bd5bf0e1084a055615c768',
    universalRouter: '0x1a0a18ac4becddbd6389559687d1a73d8927e416',
  },
  [DEX_IDS.UNISWAP_V3]: {
    factory: '0xdb1d10011ad0ff90774d0c6bb92e5c5c8b4461f7',
    positionManager: '0x7b8a01b39d58278b5de7e48c8449c9f4f5170613',
    swapRouter: '0xb971ef87ede563556b2ed4b1c0b0019111dd85d2',
    quoterV2: '0x78d78e420da98ad378d7799be8f4af69033eb077',
    tickLens: '0xd9270014d396281579760619ccf4c3af0501a47c',
    permit2: '0x000000000022d473030f116ddee9f6b43ac78ba3',
    universalRouter: '0x1906c1d672b88cd1b9ac7593301ca990f94eae07',
  },
};

/**
 * Known QQQB pools (research §4.1). NOT a whitelist of pools — the Scanner discovers candidates
 * from the address whitelist; this is a factual reference used by smoke tests and by the
 * "no pools found" explanation. There is no PancakeSwap V3 QQQB/USDC pool.
 */
export const KNOWN_BSC_POOLS = [
  {
    poolAddress: '0xfc4e77248b76fefc27c4cac7151a2ee5b5cc590e',
    dex: DEX_IDS.UNISWAP_V3,
    feeTier: 3000,
    tokens: ['QQQB', 'USDC'],
    note: 'QQQB/USDC 0.3% (TVL ~$1.77M as of 2026-09-29)',
  },
  {
    poolAddress: '0xe531fcb1f5a195de7608b9f4f9518544c2cdb693',
    dex: DEX_IDS.PANCAKESWAP_V3,
    feeTier: 100,
    tokens: ['QQQB', 'USDT'],
    note: 'QQQB/USDT 0.01% (TVL ~$0.62M)',
  },
  {
    poolAddress: '0x47bc06722295ac316a569eef87ac32faa455f441',
    dex: DEX_IDS.PANCAKESWAP_V3,
    feeTier: 500,
    tokens: ['QQQB', 'WBNB'],
    note: 'QQQB/WBNB 0.05% (TVL ~$0.82M)',
  },
] as const;
