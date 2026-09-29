/**
 * Real-chain read-only smoke test (T4/T5 acceptance evidence).
 *
 * Outputs, against live BSC state:
 *   (a) wallet BNB / USDC / USDT balances (raw + UI + decimals);
 *   (b) for both whitelisted QQQB pools: sqrtPriceX96, tick, active liquidity, fee tier, tick
 *       spacing, derived price and pool reserves;
 *   (c) when `STRATEGY_WALLET_ADDRESS` and a position token id are supplied: the LP position, its
 *       range, and its unclaimed fees;
 *   (d) the on-chain `uiMultiplier()` plus a local-vs-contract conversion cross-check (KI-3 evidence).
 *
 * It requires **no private key** and sends **no transaction**: the adapter is constructed without a
 * signer, so `sendTransaction` cannot run at all. Exit code is non-zero when any required read fails,
 * because a smoke script that reports success on a failed read is worse than no script.
 *
 * Usage:
 *   node --experimental-strip-types --env-file-if-exists=.env scripts/smoke-read.ts
 *   npm run smoke:read
 *   # optional position section:
 *   STRATEGY_WALLET_ADDRESS=0x... LP_POSITION_TOKEN_ID=12345 npm run smoke:read
 */
import { loadConfig } from '../src/config/index.ts';
import { BSC_ADDRESSES, BSC_STABLECOINS } from '../src/config/builtins.ts';
import { BscChainAdapter } from '../src/chain/adapter.ts';
import { ChainError, RpcUnavailableError } from '../src/chain/errors.ts';
import { PoolReader } from '../src/chain/poolReader.ts';
import { PositionReader } from '../src/chain/positionReader.ts';
import { TokenReader, UI_MULTIPLIER_SCALE } from '../src/chain/tokenReader.ts';
import { DEX_IDS, type Address, type DexId } from '../src/types/primitives.ts';
import { UI_AMOUNT_MODES } from '../src/types/token.ts';

const WBNB = BSC_ADDRESSES.WBNB;

/** The two QQQB pools that exist on BSC (research §4.1). Pancake has no QQQB/USDC pool. */
const KNOWN_POOLS = [
  {
    label: 'QQQB/USDT @ PancakeSwap V3 (0.01%)',
    address: '0xe531fcb1f5a195de7608b9f4f9518544c2cdb693' as Address,
    dex: DEX_IDS.PANCAKESWAP_V3 as DexId,
  },
  {
    label: 'QQQB/USDC @ Uniswap V3 (0.3%)',
    address: '0xfc4e77248b76fefc27c4cac7151a2ee5b5cc590e' as Address,
    dex: DEX_IDS.UNISWAP_V3 as DexId,
  },
] as const;

const failures: string[] = [];

function section(title: string): void {
  process.stdout.write(`\n${title}\n${'-'.repeat(title.length)}\n`);
}

function report(label: string, value: string): void {
  process.stdout.write(`  ${label.padEnd(34, ' ')} ${value}\n`);
}

/** Format a raw bigint as a fixed 6-decimal string without going through `Number` for the integer part. */
function formatUnits(value: bigint, decimals: number, fractionDigits = 6): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = (magnitude / base).toString();
  const fraction = (magnitude % base).toString().padStart(decimals, '0').slice(0, fractionDigits);
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

async function main(): Promise<void> {
  const config = await loadConfig();
  config.whitelist.assertWhitelistNonEmpty();

  const endpoints = {
    BSC_RPC_URL: process.env['BSC_RPC_URL'] ?? '(default) https://bsc-dataseed.bnbchain.org',
    BSC_RPC_URL_SECONDARY:
      process.env['BSC_RPC_URL_SECONDARY'] ?? '(default) https://bsc-rpc.publicnode.com',
  };

  process.stdout.write('lptrader — on-chain read-only smoke test (T4/T5)\n');
  process.stdout.write('================================================\n');
  report('chain id', '56 (BNB Chain)');
  report('whitelisted DEXes', config.whitelist.dexes.map((entry) => entry.dex).join(', '));
  report('RPC primary (read path)', endpoints.BSC_RPC_URL);
  report('RPC secondary (cross-check)', endpoints.BSC_RPC_URL_SECONDARY);
  report('signer attached', 'no (read-only; sendTransaction is unreachable)');

  const adapter = new BscChainAdapter({
    chainId: 56,
    whitelist: config.whitelist,
    // No `account`/`walletClient`: this process physically cannot sign or broadcast (§94).
    rpc: { crossCheckEndpoints: 2, timeoutMs: 20_000 },
  });

  const registry = config.whitelist.registry;
  const tokenReader = new TokenReader(adapter, registry, 56);
  const poolReader = new PoolReader(adapter, registry, 56);
  const positionReader = new PositionReader(adapter, 56);

  // ---------------------------------------------------------------- chain health + wallet
  const blockNumber = await adapter.getBlockNumber();
  const endpointLabels = adapter.rpcPool.getEndpointLabels();
  section('chain');
  report('endpoints configured', endpointLabels.join(', '));
  report('head block', blockNumber.toString());
  report('gas price', `${formatUnits(await adapter.getGasPrice(), 9, 3)} Gwei`);

  const wallet = (process.env['STRATEGY_WALLET_ADDRESS'] ?? '') as Address | '';
  section('(a) wallet balances');
  if (wallet === '') {
    report('wallet', 'not configured (set STRATEGY_WALLET_ADDRESS to read balances)');
    report('native BNB', 'skipped');
  } else {
    report('wallet', wallet);
    const plainTokens = [WBNB, ...BSC_STABLECOINS.map((token) => token.address)];
    const nativeBalance = await adapter.getNativeBalance(wallet);
    report('BNB (native)', `${formatUnits(nativeBalance, 18)} BNB (${nativeBalance} wei)`);

    for (const address of plainTokens) {
      const meta = registry.requireTokenByAddress(56, address);
      const amount = await tokenReader.getBalance(address, wallet);
      const multiplier =
        amount.uiMultiplier === UI_MULTIPLIER_SCALE
          ? '1e18 (plain)'
          : `${amount.uiMultiplier} (scaled)`;
      report(
        `${meta.symbol} (${meta.decimals}d)`,
        `${formatUnits(amount.raw, meta.decimals)} raw | ui ${formatUnits(amount.ui, meta.decimals)} | mult ${multiplier}`,
      );
    }
  }

  // ---------------------------------------------------------------- pools
  for (const known of KNOWN_POOLS) {
    section(`(b) ${known.label}`);
    try {
      const target = await poolReader.resolvePool(known.address, known.dex);
      const state = await poolReader.readPool(target);
      report('pool address', state.poolAddress);
      report('pool id', state.poolId);
      report('token0 / token1', `${state.token0} / ${state.token1}`);
      report('fee tier', `${state.feeTier} (${state.feeTier / 10_000}%)`);
      report('tick spacing', state.tickSpacing.toString());
      report('sqrtPriceX96', state.sqrtPriceX96.toString());
      report('tick', state.tick.toString());
      report('active liquidity (§108)', state.liquidity.toString());
      report(
        `price (${target.token1.symbol} per ${target.token0.symbol})`,
        state.priceToken1PerToken0.toFixed(8),
      );
      report(
        `reserves (${target.token0.symbol} / ${target.token1.symbol})`,
        `${formatUnits(state.reserve0Raw, target.token0.decimals, 4)} / ${formatUnits(state.reserve1Raw, target.token1.decimals, 4)}`,
      );
      report(
        'reserve-derived TVL',
        `$${(Number(state.reserve0Raw) / 10 ** target.token0.decimals * state.priceToken1PerToken0 + Number(state.reserve1Raw) / 10 ** target.token1.decimals).toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
      );
      report('read at block', state.blockNumber.toString());
      report('cross-checked by', state.provenance.observedBy.join(' + '));

      // The tick and sqrtPriceX96 must describe the same price: this catches a swapped token order.
      const fromTick = 1.0001 ** state.tick;
      const deviation = Math.abs(fromTick - state.priceToken1PerToken0) / state.priceToken1PerToken0;
      report('tick vs price deviation', `${(deviation * 100).toFixed(4)}%`);
      if (deviation > 0.01) {
        failures.push(
          `${known.label}: tick ${state.tick} implies ${fromTick.toFixed(6)} but sqrtPriceX96 implies ` +
            `${state.priceToken1PerToken0.toFixed(6)} (${(deviation * 100).toFixed(4)}% apart)`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report('READ FAILED', message);
      failures.push(`${known.label}: ${message}`);
    }
  }

  // ---------------------------------------------------------------- BEP-677 (KI-3)
  section('(d) BEP-677 scaled UI amount — live uiMultiplier() [KI-3 closure evidence]');
  const bstocks = registry.listStockTokens();
  for (const meta of bstocks) {
    try {
      const probe = await tokenReader.probeUiAmount(meta.address);
      report(
        `${meta.symbol} (${meta.address})`,
        probe.supportsUiMultiplier ? `uiMultiplier = ${probe.uiMultiplier}` : 'no uiMultiplier() (plain)',
      );
      report(
        `  ${meta.symbol} ERC-165`,
        `core(0xa60bf13d)=${String(probe.erc165Core)} balances(0xd890fd71)=${String(probe.erc165Balances)}`,
      );
      report(
        `  ${meta.symbol} ratio to 1e18`,
        probe.supportsUiMultiplier ? (Number(probe.uiMultiplier) / 1e18).toFixed(12) : '1.000000000000',
      );

      if (probe.supportsUiMultiplier) {
        // Prove the local integer conversion equals the contract's own toUIAmount/fromUIAmount.
        const samples = [10n ** 18n, 12_345_678_901_234_567_890_123n];
        const verified = await tokenReader.verifyConversionOnChain(meta.address, samples);
        for (const row of verified) {
          const matches = row.onChainUi === row.localUi && row.onChainBackToRaw === row.localBackToRaw;
          report(
            `  ${meta.symbol} toUIAmount(${row.raw})`,
            `contract ${row.onChainUi} | local ${row.localUi} | ${matches ? 'MATCH' : 'MISMATCH'}`,
          );
          if (!matches) {
            failures.push(
              `${meta.symbol}: local conversion disagrees with the contract for ${row.raw} ` +
                `(contract ${row.onChainUi} vs local ${row.localUi})`,
            );
          }
        }
      }
      // KI-3's requirement is that the multiplier is READ at runtime and never assumed, not that
      // every token has accumulated dividends. A token legitimately at exactly 1e18 (nothing
      // distributed yet) is valid data; the wrong assertion here would train an operator to ignore
      // a real probe failure. Record the value and only fail when it could not be read at all.
      report(
        `  ${meta.symbol} uiMultiplier vs 1e18`,
        probe.uiMultiplier === UI_MULTIPLIER_SCALE
          ? 'exactly 1e18 (no distribution accumulated yet — value is still read, never assumed)'
          : `non-trivial (${probe.uiMultiplier} ; ratio ${Number(probe.uiMultiplier) / 1e18})`,
      );
      if (probe.mode !== UI_AMOUNT_MODES.BEP677_SCALED) {
        failures.push(`${meta.symbol}: whitelist expects bep677-scaled but the probe says ${probe.mode}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report(`${meta.symbol}`, `PROBE FAILED: ${message}`);
      failures.push(`${meta.symbol}: ${message}`);
    }
  }

  // ---------------------------------------------------------------- LP position
  section('(c) LP position + unclaimed fees');
  const tokenIdRaw = process.env['LP_POSITION_TOKEN_ID'] ?? '';
  const positionDex = (process.env['LP_POSITION_DEX'] ?? DEX_IDS.PANCAKESWAP_V3) as DexId;
  if (wallet === '' || tokenIdRaw === '') {
    report('position', 'skipped (set STRATEGY_WALLET_ADDRESS and LP_POSITION_TOKEN_ID)');
  } else {
    try {
      const tokenId = BigInt(tokenIdRaw);
      const manager = positionReader.positionManagerFor(positionDex);
      report('position manager', `${positionDex} → ${manager}`);
      const raw = await positionReader.readRawPosition(manager, tokenId);
      if (raw === null) {
        report('positions(tokenId)', `no position with tokenId ${tokenId} on this manager`);
        failures.push(`position ${tokenId} does not exist on ${positionDex}`);
      } else {
        // Resolve the real pool address from the factory rather than guessing it from the pair.
        const poolAddress = await adapter.getPoolAddress(
          positionDex,
          raw.token0,
          raw.token1,
          raw.fee,
        );
        report('token0 / token1 / fee', `${raw.token0} / ${raw.token1} / ${raw.fee}`);
        report('tick range', `[${raw.tickLower}, ${raw.tickUpper}]`);
        report('liquidity (raw L)', raw.liquidity.toString());
        report('tokensOwed0 (unclaimed)', `${raw.tokensOwed0} raw`);
        report('tokensOwed1 (unclaimed)', `${raw.tokensOwed1} raw`);
        report('feeGrowthInside0Last', raw.feeGrowthInside0LastX128.toString());
        report('feeGrowthInside1Last', raw.feeGrowthInside1LastX128.toString());

        if (poolAddress === null) {
          report('pool', `no pool on ${positionDex} for this pair/fee`);
          failures.push(`cannot resolve the pool for position ${tokenId}`);
        } else {
          const view = await positionReader.getPositionView({
            dex: positionDex,
            tokenId,
            poolAddress,
            expectedOwner: wallet,
          });
          report('pool id', view?.poolId ?? '(unresolved)');
          report('confirmed owner', view?.confirmedOwner ?? '(unresolved)');
          const slot0 = await poolReader.readSlot0(poolAddress);
          report('current tick', slot0.tick.toString());
          const inRange = slot0.tick >= raw.tickLower && slot0.tick <= raw.tickUpper;
          report('in range', inRange ? 'yes' : 'NO (out of range)');
          // §49 range progress, reported for the operator's benefit only (never a decision input).
          const progress = (slot0.tick - raw.tickLower) / (raw.tickUpper - raw.tickLower);
          report('range progress (§49)', `${(progress * 100).toFixed(2)}%`);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report('POSITION READ FAILED', message);
      failures.push(`position read: ${message}`);
    }
  }

  // ---------------------------------------------------------------- verdict
  section('verdict');
  if (failures.length === 0) {
    process.stdout.write('  all required reads succeeded\n\n');
    return;
  }
  process.stdout.write(`  ${failures.length} failure(s):\n`);
  for (const failure of failures) process.stdout.write(`   - ${failure}\n`);
  process.stdout.write('\n');
  process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  if (error instanceof RpcUnavailableError) {
    process.stderr.write(
      `\nSMOKE READ FAILED (all RPC endpoints unreachable): ${error.message}\n` +
        'Set BSC_RPC_URL / BSC_RPC_URL_SECONDARY in .env to a reachable endpoint and retry.\n',
    );
  } else if (error instanceof ChainError) {
    process.stderr.write(`\nSMOKE READ FAILED (${error.code}): ${error.message}\n`);
  } else {
    process.stderr.write(
      `\nSMOKE READ FAILED: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
  }
  process.exitCode = 1;
}
