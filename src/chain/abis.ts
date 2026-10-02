/**
 * Minimal, hand-written ABIs for the on-chain read layer.
 *
 * Rules that shaped this file:
 * - Only the fragments this project actually calls are declared. A wider ABI would let callers
 *   drift into un-reviewed surface.
 * - Every output tuple mirrors the deployed contract **exactly**, including the `uint8` vs
 *   `uint16` widths: `slot0()` returns `(uint160,int24,uint16,uint16,uint16,uint8,bool)`.
 *   A mismatched width makes viem throw at decode time, which would be a silent outage.
 * - Function selectors for the non-standard ABI (`uiMultiplier`, `balanceOfUI`, `toUIAmount`, …)
 *   cannot be spelled by name in `parseAbi` portably, so the ERC-20/BEP-677 fragments are declared
 *   from their **selector hex** (`{ type: 'function', name: 'uiMultiplier', selector: '0xa60bf13d' }`).
 *   viem 2.x accepts an explicit `selector` member on ABI items and prefers it over hashing the
 *   signature (which for `supportsInterface(bytes4)` alone would be indistinguishable from
 *   `uiMultiplier()`). Declaring the selector keeps the binding explicit and self-documenting.
 */

/** ERC-165 detection (BEP-677 core multiplier interface id is `0xa60bf13d`). */
export const ERC165_ABI = [
  {
    type: 'function',
    name: 'supportsInterface',
    selector: '0x01ffc9a7',
    stateMutability: 'view',
    inputs: [{ name: 'interfaceId', type: 'bytes4' }],
    outputs: [{ name: 'supported', type: 'bool' }],
  },
] as const;

/**
 * BEP-677 / EIP-8056 "Scaled UI Amount" read surface (research §2).
 *
 * Four distinct pieces of information live behind four separate selectors:
 *   `0xa60bf13d` = ERC-165 core id AND the `uiMultiplier()` selector (research §2.5 item 5).
 *   `0xd890fd71` = ERC-165 id for the *balances* interface; its selector is `balanceOfUI(address)`.
 */
export const BEP677_ABI = [
  {
    type: 'function',
    name: 'uiMultiplier',
    selector: '0xa60bf13d',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: 'multiplier', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'balanceOfUI',
    selector: '0x437a9958',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: 'balanceUI', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'totalSupplyUI',
    selector: '0x9bea6429',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: 'supplyUI', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'toUIAmount',
    selector: '0x3248d4ff',
    stateMutability: 'view',
    inputs: [{ name: 'rawAmount', type: 'uint256' }],
    outputs: [{ name: 'uiAmount', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'fromUIAmount',
    selector: '0x65cd9b3c',
    stateMutability: 'view',
    inputs: [{ name: 'uiAmount', type: 'uint256' }],
    outputs: [{ name: 'rawAmount', type: 'uint256' }],
  },
] as const;

/** Plain ERC-20 surface used for whitelisted stablecoins, WBNB and balance reads. */
export const ERC20_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    selector: '0x70a08231',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'decimals',
    selector: '0x313ce567',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'totalSupply',
    selector: '0x18160ddd',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'allowance',
    selector: '0xdd62ed3e',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    // 0x095ea7b3 — the write that every swap needs and that nothing in this codebase performed.
    selector: '0x095ea7b3',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;

/**
 * Uniswap-V3-family CLMM pool reads. PancakeSwap V3 uses byte-identical selectors and the same
 * `slot0` tuple shape, so one ABI serves both whitelisted DEXes.
 */
export const CLMM_POOL_ABI = [
  {
    type: 'function',
    name: 'slot0',
    selector: '0x3850c7bd',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'tick', type: 'int24' },
      { name: 'observationIndex', type: 'uint16' },
      { name: 'observationCardinality', type: 'uint16' },
      { name: 'observationCardinalityNext', type: 'uint16' },
      /**
       * `uint32`, not the canonical Uniswap `uint8`: PancakeSwap V3 packs the two 16-bit protocol
       * fee shares into this word and the live QQQB/USDT pool reports `216272100` (0x0ce4cc4).
       * Both widths occupy the same 32-byte word, so `uint32` decodes Uniswap pools identically
       * while also accepting every value Pancake actually returns.
       */
      { name: 'feeProtocol', type: 'uint32' },
      { name: 'unlocked', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'liquidity',
    selector: '0x1a686502',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint128' }],
  },
  {
    type: 'function',
    name: 'fee',
    selector: '0xddca3f43',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint24' }],
  },
  {
    type: 'function',
    name: 'tickSpacing',
    selector: '0xd0c93a7c',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'int24' }],
  },
  {
    type: 'function',
    name: 'token0',
    selector: '0x0dfe1681',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'token1',
    selector: '0xd21220a7',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
] as const;

/** `getPool(token0, token1, fee)` — identical selector on both whitelisted factories. */
export const CLMM_FACTORY_ABI = [
  {
    type: 'function',
    name: 'getPool',
    selector: '0x1698ee82',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenA', type: 'address' },
      { name: 'tokenB', type: 'address' },
      { name: 'fee', type: 'uint24' },
    ],
    outputs: [{ name: 'pool', type: 'address' }],
  },
  {
    type: 'function',
    name: 'owner',
    selector: '0x8da5cb5b',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
] as const;

/** v3-periphery `NonfungiblePositionManager` read surface. */
export const POSITION_MANAGER_ABI = [
  {
    type: 'function',
    name: 'positions',
    selector: '0x99fbab88',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [
      { name: 'nonce', type: 'uint96' },
      { name: 'operator', type: 'address' },
      { name: 'token0', type: 'address' },
      { name: 'token1', type: 'address' },
      { name: 'fee', type: 'uint24' },
      { name: 'tickLower', type: 'int24' },
      { name: 'tickUpper', type: 'int24' },
      { name: 'liquidity', type: 'uint128' },
      { name: 'feeGrowthInside0LastX128', type: 'uint256' },
      { name: 'feeGrowthInside1LastX128', type: 'uint256' },
      { name: 'tokensOwed0', type: 'uint128' },
      { name: 'tokensOwed1', type: 'uint128' },
    ],
  },
  {
    type: 'function',
    name: 'ownerOf',
    selector: '0x6352211e',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    selector: '0x70a08231',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'tokenOfOwnerByIndex',
    selector: '0x2f745c59',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'index', type: 'uint256' },
    ],
    outputs: [{ type: 'uint256' }],
  },
] as const;

/** Multicall3 `aggregate3` — batched reads with per-call failure tolerance. */
export const MULTICALL3_AGGREGATE3_ABI = [
  {
    type: 'function',
    name: 'aggregate3',
    selector: '0x82ad56cb',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'target', type: 'address' },
          { name: 'allowFailure', type: 'bool' },
          { name: 'callData', type: 'bytes' },
        ],
      },
    ],
    outputs: [
      {
        name: 'returnData',
        type: 'tuple[]',
        components: [
          { name: 'success', type: 'bool' },
          { name: 'returnData', type: 'bytes' },
        ],
      },
    ],
  },
] as const;
