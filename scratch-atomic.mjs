import { Token, CurrencyAmount, TradeType, Percent } from '@pancakeswap/sdk';
import { Pool, Position, FeeAmount } from '@pancakeswap/v3-sdk';
import { SwapRouter, RouteType } from '@pancakeswap/smart-router';

const ApprovalTypes = { NOT_REQUIRED: 0, MAX: 1, MAX_MINUS_ONE: 2, ZERO_THEN_MAX: 3, ZERO_THEN_MAX_MINUS_ONE: 4 };

const QQQB = new Token(56, '0x205812CdBed920aFf76C6580abD681a46D11efc7', 18, 'QQQB');
const USDT = new Token(56, '0x55d398326f99059fF775485246999027B3197955', 18, 'USDT');

const pool = new Pool(QQQB, USDT, FeeAmount.LOWEST, BigInt('2154944071477206728621729597984'), BigInt('1556463151563366171503721'), 66067);
console.log('pool token0', pool.token0.symbol, 'token1', pool.token1.symbol, 'spacing', pool.tickSpacing);
const position = Position.fromAmounts({ pool, tickLower: 64000, tickUpper: 68000, amount0: '1349972072495918445', amount1: '1000000000000000000000', useFullPrecision: true });
console.log('liquidity', position.liquidity.toString());

const amountIn = CurrencyAmount.fromRawAmount(USDT, '1000000000000000000000');
const amountOut = CurrencyAmount.fromRawAmount(QQQB, '1349972072495918445');
const route = { type: RouteType.V3, pools: [{ ...pool, type: 1 }], path: [USDT, QQQB], input: USDT, output: QQQB, percent: 100, inputAmount: amountIn, outputAmount: amountOut };
const trade = { tradeType: TradeType.EXACT_INPUT, inputAmount: amountIn, outputAmount: amountOut, routes: [route], gasEstimate: 200000n };

const method = SwapRouter.swapAndAddCallParameters(
  trade,
  { slippageTolerance: new Percent(30, 10000), recipient: '0x1111111111111111111111111111111111111111', deadlineOrPreviousBlockhash: '0x' + 'ab'.repeat(32) },
  position,
  { recipient: '0x1111111111111111111111111111111111111111' },
  ApprovalTypes.NOT_REQUIRED,
  ApprovalTypes.ZERO_THEN_MAX,
);
console.log('value', method.value);
console.log('selector', method.calldata.slice(0, 10), 'len', method.calldata.length);

// timestamp variant
const method2 = SwapRouter.swapAndAddCallParameters(
  trade,
  { slippageTolerance: new Percent(30, 10000), recipient: '0x1111111111111111111111111111111111111111', deadlineOrPreviousBlockhash: 1790000000n },
  position,
  { recipient: '0x1111111111111111111111111111111111111111' },
  ApprovalTypes.NOT_REQUIRED, ApprovalTypes.NOT_REQUIRED,
);
console.log('ts selector', method2.calldata.slice(0, 10));
