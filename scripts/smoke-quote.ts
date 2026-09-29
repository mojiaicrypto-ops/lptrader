/**
 * Real-chain, **read-only** `quoteSwap` smoke test for the PancakeSwap V3 adapter.
 *
 * It exercises the exact path the §40 gate depends on, against live BSC state:
 *   - the pool's `slot0` tick / active liquidity (so the numbers behind the impact figure are visible);
 *   - a real QuoterV2 `eth_call` for selling 1000 USDT for QQQB on the QQQB/USDT 0.01% pool;
 *   - the locally computed `priceImpact`, the derived `amountOutMinimumRaw` and the quote window.
 *
 * No private key, no signer, no transaction: the adapter is constructed without an account, so
 * `sendTransaction` cannot run at all. Exit code is non-zero when a read fails — a smoke script that
 * reports success on a failed quote is worse than no script.
 *
 * Usage:
 *   node --experimental-strip-types --env-file-if-exists=.env scripts/smoke-quote.ts
 *   BSC_RPC_URL=https://... node --experimental-strip-types scripts/smoke-quote.ts
 */
import { BscChainAdapter } from '../src/chain/adapter.ts';
import { loadConfig } from '../src/config/index.ts';
import { BSC_ADDRESSES } from '../src/config/builtins.ts';
import { createPancakeV3Adapter } from '../src/dex/pancakeV3.ts';
import { evaluateSwapQuote } from '../src/strategy/swapPlanner.ts';
import { DEX_IDS, type Address, type PoolId } from '../src/types/primitives.ts';
import { toFloat } from '../src/util/decimal.ts';

/** QQQB/USDT 0.01% @ PancakeSwap V3 (research §4.1). */
const POOL_ADDRESS = '0xe531fcb1f5a195de7608b9f4f9518544c2cdb693' as Address;
const POOL_ID: PoolId = `56:${DEX_IDS.PANCAKESWAP_V3}:${POOL_ADDRESS}`;
const USDT = BSC_ADDRESSES.USDT;
const QQQB = '0x205812cdbed920aff76c6580abd681a46d11efc7' as Address;
/** 1000 USDT in RAW units — both legs are 18 decimals on BSC (research §1). */
const AMOUNT_IN_RAW = 1_000n * 10n ** 18n;
const TTL_SECONDS = 30;

function formatUnits(value: bigint, decimals: number, fractionDigits = 6): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = (magnitude / base).toString();
  const fraction = (magnitude % base).toString().padStart(decimals, '0').slice(0, fractionDigits);
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

function line(label: string, value: string): void {
  process.stdout.write(`  ${label.padEnd(30, ' ')} ${value}\n`);
}

async function main(): Promise<void> {
  const config = await loadConfig();
  const chainId = config.whitelist.chains[0];
  if (chainId === undefined) {
    throw new Error('no whitelisted chain in the loaded config (§11)');
  }

  process.stdout.write('lptrader — PancakeSwap V3 quoteSwap smoke test (read-only)\n');
  process.stdout.write('=========================================================\n');
  line('chain id', String(chainId));
  line('pool', POOL_ADDRESS);
  line('poolId', POOL_ID);
  line('sell', `${formatUnits(AMOUNT_IN_RAW, 18)} USDT (${AMOUNT_IN_RAW.toString()} raw)`);
  line('buy', 'QQQB');
  line('RPC', process.env['BSC_RPC_URL'] ?? '(default) https://bsc-dataseed.bnbchain.org');
  line('signer attached', 'no (read-only; sendTransaction is unreachable)');

  const chain = new BscChainAdapter({
    chainId,
    whitelist: config.whitelist,
    // No `account`/`walletClient`: this process physically cannot sign or broadcast (§94).
    rpc: { crossCheckEndpoints: 2, timeoutMs: 20_000 },
  });

  const dex = createPancakeV3Adapter({
    chainId,
    whitelist: config.whitelist,
    chain,
    slippageTolerance: config.swap.maxSlippage,
  });
  dex.assertWhitelisted();

  const [poolPrice, tick, liquidity] = await Promise.all([
    dex.getPoolPrice(POOL_ADDRESS),
    dex.getTick(POOL_ADDRESS),
    dex.getLiquidity(POOL_ADDRESS),
  ]);

  process.stdout.write('\npool state\n----------\n');
  line('tick', String(tick));
  line('sqrtPriceX96', poolPrice.sqrtPriceX96.toString());
  line('active liquidity (L)', liquidity.toString());
  line('fee tier', String(poolPrice.feeTier));
  line('tick spacing', String(poolPrice.tickSpacing));
  line('price USDT per QQQB', poolPrice.priceToken1PerToken0.toFixed(6));
  line('asOf', poolPrice.asOf);

  const quote = await dex.quoteSwap({
    poolId: POOL_ID,
    tokenIn: USDT,
    tokenOut: QQQB,
    amountIn: AMOUNT_IN_RAW,
    ttlSeconds: TTL_SECONDS,
  });

  process.stdout.write('\nquoteSwap\n---------\n');
  line('route', quote.route.join(', '));
  line('amountInRaw', quote.amountInRaw.toString());
  line('amountOutRaw', quote.amountOutRaw.toString());
  line(
    'amountOut (QQQB)',
    `${formatUnits(quote.amountOutRaw, 18)}  (${(toFloat(quote.amountOutRaw, 18)).toFixed(6)})`,
  );
  line('amountInUsd', `$${quote.amountInUsd.toFixed(4)}`);
  line('effective price', `${(toFloat(quote.amountOutRaw, 18)).toFixed(6)} QQQB per USDT`);
  line('priceImpact', `${(quote.priceImpact * 100).toFixed(6)}%`);
  line('slippageTolerance', `${(quote.slippageTolerance * 100).toFixed(4)}%`);
  line('amountOutMinimumRaw', quote.amountOutMinimumRaw.toString());
  line('quotedAt', quote.quotedAt);
  line('expiresAt', quote.expiresAt);

  const gate = evaluateSwapQuote(
    quote,
    {
      maxSlippage: config.swap.maxSlippage,
      maxPriceImpact: config.swap.maxPriceImpact,
      quoteTtlSeconds: config.swap.quoteTtlSeconds,
      // Mirrors the §40 second tier without reaching into config internals for a smoke report.
      liquidityRiskPriceImpact: config.swap.maxPriceImpact * 2,
    },
    new Date().toISOString(),
  );
  process.stdout.write('\n§40 gate (evaluated immediately)\n--------------------------------\n');
  line('ok', String(gate.ok));
  line('reasons', gate.reasons.length === 0 ? '(none)' : gate.reasons.join('; '));
  line('poolLiquidityRisk', String(gate.poolLiquidityRisk));
  process.stdout.write('\n');
}

main().catch((error: unknown) => {
  process.stderr.write(
    `\nsmoke-quote FAILED: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n` +
      'This is a quote-read failure: nothing was sent and no result is being reported.\n',
  );
  process.exitCode = 1;
});
