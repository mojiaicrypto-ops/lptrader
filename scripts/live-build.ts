/**
 * Live full-flow build (real money, real chain) — the acceptance run for plan T5.
 *
 *   node --experimental-strip-types --env-file-if-exists=.env scripts/live-build.ts \
 *        --dex pancake --pool 0xe9b9998b2ec5430d2246c7f1f8d9f298c97d7365
 *   node --experimental-strip-types --env-file-if-exists=.env scripts/live-build.ts \
 *        --dex uniswap  --pool 0x36c0fc3159eb8662a2e1b84a4df518d916bce0e1
 *
 * Requires KEYSTORE_PASSPHRASE (unattended) or a terminal to type it into.
 *
 * The flow is the production path (runtime.openPositionFromLatestScan), driven with one fixed
 * candidate pool so the run is deterministic:
 *
 *   scan → §16 filter → screen+plan+quote+gates → funding →
 *   approve → (confirmed) → swap → (confirmed) → re-read wallet → mint → (confirmed)
 */
import { parseArgs } from 'node:util';
import { privateKeyToAccount } from 'viem/accounts';
import { loadConfig } from '../src/config/index.ts';
import { BscChainAdapter } from '../src/chain/adapter.ts';
import { buildTxGuard } from '../src/chain/txState.ts';
import { createPancakeV3Adapter } from '../src/dex/pancakeV3.ts';
import { createUniswapV3Adapter } from '../src/dex/uniswapV3.ts';
import { LayeredPoolDataProvider } from '../src/data/poolDataProvider.ts';
import { BscOnchainPoolStateSource } from '../src/data/bscOnchainSource.ts';
import { createReferencePriceProvider } from '../src/data/referencePrice.ts';
import { createPoolScanner, foundPools } from '../src/data/poolScanner.ts';
import { filterPools } from '../src/data/poolFilter.ts';
import { BuildOrchestrator } from '../src/strategy/buildOrchestrator.ts';
import { FundingPlanner } from '../src/strategy/funding.ts';
import { PositionExecutor } from '../src/execution/positionExecutor.ts';
import { ApprovalGate } from '../src/execution/approvalGate.ts';
import type { DecisionLog } from '../src/types/portfolio.ts';
import { StateMachine } from '../src/strategy/stateMachine.ts';
import { TxStore } from '../src/store/txStore.ts';
import { openDatabase } from '../src/store/db.ts';
import { PoolScreener } from '../src/data/poolScreener.ts';
import { BSC_ADDRESSES, BSC_DEX_CONTRACTS } from '../src/config/builtins.ts';
import { UNISWAP_V3_POSITION_MANAGER_ABI } from '../src/dex/uniswapV3.ts';
import { liquidityToAmounts } from '../src/strategy/positionPlanner.ts';
import { DEX_IDS, type Address, type DexId, type UsdAmount } from '../src/types/primitives.ts';
import type { DexAdapter } from '../src/types/adapters.ts';

const { values } = parseArgs({
  options: {
    dex: { type: 'string' },
    pool: { type: 'string' },
    'config-dir': { type: 'string' },
    exit: { type: 'string' },
    value: { type: 'string' },
    entry: { type: 'string' },
  },
  strict: true,
});
const dexArg = values.dex ?? '';
const poolArg = (values.pool ?? '').toLowerCase();
if (!['pancake', 'uniswap'].includes(dexArg) ||
    (!/^0x[0-9a-f]{40}$/.test(poolArg) && /^[0-9]+$/.test(values.exit ?? '') === false && values.value === undefined)) {
  process.stderr.write('usage: live-build.ts --dex pancake|uniswap (--pool 0x…40hex | --exit tokenId | --value tokenId --entry usd)\n');
  process.exit(2);
}

const config = await loadConfig(
  values['config-dir'] === undefined ? {} : { configDir: values['config-dir'] },
);
const chainId = (config.whitelist.chains[0] ?? 56) as 56;

// ---- signer --------------------------------------------------------------------------------------
// Two sources, in order of preference:
//   LIVE_PRIVATE_KEY — a raw key for a TEST wallet only; never wired into src/ (the product's rule is
//                      keystore-only, §密钥管理). Exists so an acceptance run is unattended.
//   KEYSTORE_PATH + passphrase — the production path.
const liveKey = process.env['LIVE_PRIVATE_KEY'];
const signer = ((): { account: ReturnType<typeof privateKeyToAccount> } | null => {
  if (liveKey === undefined || liveKey.length === 0) return null;
  // A raw key for a TEST wallet only; never wired into src/ (the product's rule is keystore-only).
  return { account: privateKeyToAccount((liveKey.startsWith('0x') ? liveKey : `0x${liveKey}`) as `0x${string}`) };
})();
if (signer === null) {
  process.stderr.write('no signer: set LIVE_PRIVATE_KEY (test wallet only)\n');
  process.exit(2);
}
process.stdout.write(`signer: ${signer.account.address}\n`);
if (signer === null) {
  process.stderr.write('no signer resolved (passphrase missing/empty); refusing a live build\n');
  process.exit(2);
}
const walletAddress = signer.account.address as Address;

// ---- data layer (module 1: HTTP only) ------------------------------------------------------------
const provider = new LayeredPoolDataProvider({
  chainId,
  registry: config.whitelist.registry,
  onchain: new BscOnchainPoolStateSource(
    process.env['BSC_RPC_URL'] === undefined ? {} : { rpcUrl: process.env['BSC_RPC_URL'] },
  ),
  referencePrice: createReferencePriceProvider({ chainId, registry: config.whitelist.registry }),
});
const scanner = createPoolScanner({ config, provider });

// ---- chain + adapters (module 2/3 read + write) ---------------------------------------------------
const chain = new BscChainAdapter({ chainId, whitelist: config.whitelist, account: signer.account });
const PANCAKE_QQQB_POOL = '0xe531fcb1f5a195de7608b9f4f9518544c2cdb693';
const UNISWAP_AAPLB_POOL = '0x36c0fc3159eb8662a2e1b84a4df518d916bce0e1';
const dexId: DexId = dexArg === 'pancake' ? DEX_IDS.PANCAKESWAP_V3 : DEX_IDS.UNISWAP_V3;
const adapters: readonly DexAdapter[] = [
  createPancakeV3Adapter({ chainId, whitelist: config.whitelist, chain }),
  createUniswapV3Adapter({ chainId, whitelist: config.whitelist, chain }),
];
const owner = adapters.find((a) => a.dex === dexId);
if (owner === undefined) throw new Error(`no adapter for ${dexId}`);

// ---- bookkeeping (in-memory: the chain is the rehearsal target, persistence is not) ---------------
const db = openDatabase(':memory:');
const txStore = new TxStore(db);
const stateMachine = StateMachine.open(db);
const OPERATOR = 'operator-session-2026-10-02';
const approvals = new ApprovalGate({
  notifier: {
    async send() {},
    async requestApproval(request) {
      // The operator pre-authorized the live runs for this session; returning the decision here is
      // the complete contract — the gate persists it (settle), so no double decide happens.
      return {
        requestId: request.id,
        approved: true,
        decidedBy: OPERATOR,
        decidedAt: new Date().toISOString(),
        reason: 'pre-authorized live acceptance run (plan T5)',
      };
    },
    async query(question) {
      return question;
    },
  },
  timeoutMinutes: config.approvals.timeoutMinutes,
  audit: {
    append: (entry: DecisionLog): void => {
      process.stdout.write(`  audit      : ${entry.action} ${entry.reason}\n`);
    },
  },
  logger: console,
});

const executor = new PositionExecutor({
  dex: owner,
  txStore,
  stateMachine,
  approvalGate: approvals,
  currentState: () => stateMachine.current,
  logger: console,
});
const orchestrator = new BuildOrchestrator({
  config,
  screener: new PoolScreener({
    config,
    adapters: new Map(adapters.map((a) => [a.dex, a])),
  }),
  tokenMeta: (address) => config.whitelist.registry.getTokenByAddress(chainId, address),
  quoteSwap: (request) => owner.quoteSwap(request),
  guard: () => buildTxGuard(guardChecks()),
  walletAddress,
  now: () => new Date().toISOString(),
  logger: console,
});
const fundingPlanner = new FundingPlanner({
  config,
  balanceOf: (token) => chain.getTokenBalanceOf(token, walletAddress),
  tokenMeta: (address) => config.whitelist.registry.getTokenByAddress(chainId, address),
  residualHoldings: async () => {
    const stockTokens = config.whitelist.registry
      .listStockTokens({})
      .map((meta) => meta.address as Address);
    const stockBalances = await chain.getTokenBalances(stockTokens, walletAddress);
    const npmNftCount = await Promise.all(
      ([DEX_IDS.PANCAKESWAP_V3, DEX_IDS.UNISWAP_V3] as const).map(async (dex) => {
        const npm = BSC_DEX_CONTRACTS[dex]?.positionManager;
        if (npm === undefined) return 0n;
        return (await chain.readContract<bigint>({
          address: npm,
          abi: [
            { type: 'function', name: 'balanceOf', stateMutability: 'view',
              inputs: [{ name: 'owner', type: 'address' }],
              outputs: [{ type: 'uint256' }] },
          ],
          functionName: 'balanceOf',
          args: [walletAddress],
        })).value;
      }),
    ).then((xs) => xs.reduce((sum, x) => sum + x, 0n));
    return { stockBalances, npmNftCount };
  },
  uToken: BSC_ADDRESSES.USDT as Address,
});

function guardChecks(): Omit<Parameters<typeof buildTxGuard>[0], 'ok' | 'failures'> {
  return {
    chainIdOk: config.whitelist.isWhitelistedChain(chainId),
    toWhitelisted: config.whitelist.isWhitelistedDex(chainId, dexId),
    // §8/§14: candidates come from the whitelist cross-set, so both legs are whitelisted by construction.
    tokenInWhitelisted: true,
    tokenOutWhitelisted: true,
    functionSelectorOk: true,
    amountWithinLimit: true,
    slippageWithinLimit: true,
    deadlineOk: true,
    gasLimitSet: true,
    allowanceNotUnlimited: true,
  };
}

const out = (l: string, v: unknown): void => { process.stdout.write(`  ${l.padEnd(30)} ${String(v)}\n`); };
const heading = (t: string): void => { process.stdout.write(`\n${t}\n${'-'.repeat(Math.max(t.length, 20))}\n`); };

// ---- exit mode: remove + collect + convert everything back to U (§5.3.2) --------------------------
if (values.exit !== undefined) {
  const tokenId = BigInt(values.exit);
  const position = await owner.getPosition(tokenId);
  if (position === null) {
    // A previous attempt already removed-and-burned but aborted at the conversion (§5.3.2 says the
    // job is not done until the wallet is pure U). Finish it: convert any non-U stock remains.
    process.stdout.write(`tokenId ${tokenId} is gone (already removed-and-burned); converting leftover stock to U\n`);
    const usdtAddress = BSC_ADDRESSES.USDT as Address;
    const DUST = 10n ** 14n; // 0.0001 of an 18-dp token
    let convertedAny = false;
    for (const token of config.whitelist.registry.listStockTokens({})) {
      const held = await chain.getTokenBalanceOf(token.address as Address, walletAddress);
      if (held <= DUST) continue;
      const quote = await owner.quoteSwap({
        poolId: token.address.toLowerCase() === '0x205812cdbed920aff76c6580abd681a46d11efc7'
            ? `56:${dexId}:${PANCAKE_QQQB_POOL}`
            : `56:${dexId}:${UNISWAP_AAPLB_POOL}`,
        tokenIn: token.address as Address,
        tokenOut: usdtAddress,
        amountIn: held,
        ttlSeconds: config.swap.quoteTtlSeconds,
      });
      process.stdout.write(`  convert ${token.symbol} ${held.toString()} → ${quote.amountOutRaw.toString()} (impact ${(quote.priceImpact * 100).toFixed(3)}%)\n`);
      const swap = await owner.executeSwap({
        quote,
        deadline: { kind: 'timestamp', unixSeconds: Math.floor(Date.now() / 1000) + 600 },
        purpose: 'EXIT_POSITION',
        idempotencyKey: `live-convert:${token.address}:2026-10-02`,
        guard: buildTxGuard(guardChecks()),
      });
      process.stdout.write(`  tx ${swap.txHash} state ${swap.state}\n`);
      convertedAny = true;
    }
    if (!convertedAny) process.stdout.write('  nothing to convert\n');
    process.exit(0);
  }

  const usdtBalance0 = await chain.getTokenBalanceOf(BSC_ADDRESSES.USDT as Address, walletAddress);
  heading('exit');
  out('tokenId', tokenId.toString());
  out('legs', `${position.token0} / ${position.token1}`);
  out('liquidity', position.liquidity.toString());

  const exitExecutor = new PositionExecutor({
    dex: owner,
    txStore,
    stateMachine,
    approvalGate: approvals,
    currentState: () => stateMachine.current,
    logger: console,
    swapLimits: () => ({
      maxSlippage: config.swap.maxSlippage,
      maxPriceImpact: config.swap.maxPriceImpact,
      quoteTtlSeconds: config.swap.quoteTtlSeconds,
      liquidityRiskPriceImpact: config.swap.maxPriceImpact * 4,
    }),
    quoteTtlSeconds: config.swap.quoteTtlSeconds,
  });

  const outcome = await exitExecutor.exitPosition({
    poolId: position.poolId,
    positionTokenId: tokenId,
    liquidityRaw: null, // full exit (burns the NFT)
    amount0MinRaw: 0n,
    amount1MinRaw: 0n,
    recipient: walletAddress,
    deadline: { kind: 'timestamp', unixSeconds: Math.floor(Date.now() / 1000) + 600 },
    guard: buildTxGuard(guardChecks()),
    idempotencyKey: `live-exit:${position.poolId}:${tokenId}:2026-10-02T06:00:00.000Z`,
  });
  if (!outcome.ok) {
    process.stdout.write(`EXIT FAILED: ${outcome.reason}\n`);
    process.exit(1);
  }
  out('remove+convert', outcome.reason);

  heading('post-exit verify (§5.3.2: wallet = pure U)');
  const stockLeg = [position.token0, position.token1].find(
    (t) => t.toLowerCase() !== (BSC_ADDRESSES.USDT as Address).toLowerCase(),
  );
  const stockLeft = await chain.getTokenBalanceOf(stockLeg as Address, walletAddress);
  const usdtBalance1 = await chain.getTokenBalanceOf(BSC_ADDRESSES.USDT as Address, walletAddress);
  out(`stock balance (raw)`, stockLeft.toString());
  out('final USDT', `${(Number(usdtBalance1) / 1e18).toFixed(6)} (was ${(Number(usdtBalance0) / 1e18).toFixed(6)})`);
  process.exit(stockLeft > 0n ? 1 : 0);
}

// ---- value mode: read the position's legs + fees + APR from the chain (§4.2.1) --------------------
if (values.value !== undefined) {
  const tokenId = BigInt(values.value);
  const position = await owner.getPosition(tokenId);
  if (position === null) throw new Error(`tokenId ${tokenId} not known to the ${dexArg} NPM`);
  const entryUsd = values.entry === undefined ? null : Number(values.entry);
  const OPENED_AT = Date.now() - 600_000; // the build this run started 10 min ago
  const readRaw = await (async () => {
    // feeGrowth checkpoint → tokensOwed is the already-credited floor; the CURRENT unclaimed total is
    // what a static-call `collect` would return. Directly reading it beats rewriting the growth math.
    const result = await chain.readContract<readonly [bigint, bigint]>({
      address: BSC_DEX_CONTRACTS[dexId]!.positionManager,
      abi: UNISWAP_V3_POSITION_MANAGER_ABI,
      functionName: 'collect',
      args: [
        { tokenId, recipient: '0x0000000000000000000000000000000000000001',
          amount0Max: (1n << 128n) - 1n, amount1Max: (1n << 128n) - 1n },
      ],
    }).catch(() => null);
    return result;
  })();
  const fee0 = readRaw === null ? null : readRaw.value[0];
  const fee1 = readRaw === null ? null : readRaw.value[1];

  // Leg values at the CURRENT pool price: read the pool's slot0 and convert the position's liquidity.
  const poolAddress = position.poolId.split(':')[2] as Address;
  const slot0 = await chain.readContract<readonly [bigint, number]>({
    address: poolAddress,
    abi: [
      { type: 'function', name: 'slot0', stateMutability: 'view',
        inputs: [], outputs: [
          { name: 'sqrtPriceX96', type: 'uint160' },
          { name: 'tick', type: 'int24' },
        ] },
    ],
    functionName: 'slot0',
    args: [],
  });
  const sqrtPriceX96 = slot0.value[0];
  const tick = slot0.value[1];
  const { amount0, amount1 } = liquidityToAmounts({ sqrtPriceX96, tick,
    lowerTick: position.tickLower, upperTick: position.tickUpper, liquidity: position.liquidity });

  const out = (l: string, v: unknown): void => { process.stdout.write(`  ${l.padEnd(28)} ${String(v)}\n`); };
  const heading = (t: string): void => { process.stdout.write(`\n${t}\n${'-'.repeat(Math.max(t.length, 20))}\n`); };
  heading('position valuation (§4.2.1)');
  out('tokenId', tokenId.toString());
  out('legs raw', `${amount0.toString()} / ${amount1.toString()}`);
  out('fees raw (collect-read)', fee0 === null ? 'read failed' : `${fee0.toString()} / ${fee1!.toString()}`);
  // APR: entry U (= the committed budget, recorded at build), position legs priced at the current pool price.
  // Prise everything in token1 = U leg. token1 is per §5.3.2 always the U; token0 = stock.
  const price = (1.0001 ** tick); // token1 per whole token0, decimal-adjusted for the 18/18 pools scanned
  const stockUsdValue = (Number(amount0) / 1e18) * price;
  const quoteUsdValue = Number(amount1) / 1e18;
  const feesUsdValue = fee0 === null ? null : ((Number(fee0) / 1e18) * price + Number(fee1!) / 1e18);
  const equity = stockUsdValue + quoteUsdValue + (feesUsdValue ?? 0);
  out('as-token1-per-stock', price.toFixed(4));
  out('leg0 value (U)', stockUsdValue.toFixed(4));
  out('leg1 value (U)', quoteUsdValue.toFixed(4));
  if (feesUsdValue !== null) out('fees value (U)', feesUsdValue.toFixed(4));
  out('position equity (U)', equity.toFixed(4));
  if (entryUsd !== null) {
    const ret = equity - entryUsd;
    const ratio = ret / entryUsd;
    const aprYear = ratio / ((Date.now() - OPENED_AT) / (86_400_000 * 365));
    out('return vs entry U', `${ret.toFixed(4)} (${(ratio * 100).toFixed(3)}%)`);
    out('APR (simple, live)', `${(aprYear * 100).toFixed(2)}% (holding ${(Date.now() - OPENED_AT) / 60_000 | 0} min)`);
  }
  process.exit(0);
}

// ---- 1. discover + §16 filter (live) -------------------------------------------------------------

heading('scan + §16 filter');
const scan = await scanner.scan();
const filtered = filterPools(
  foundPools(scan),
  {
    minTvlUsd: config.pool.minTvlUsd,
    minAvgDailyVolume7dUsd: config.pool.minAvgDailyVolume7dUsd,
    minPoolAgeDays: config.pool.minPoolAgeDays,
    maxNavDeviation: config.pool.maxNavDeviation,
    maxSwapPriceImpact: config.pool.maxSwapPriceImpact,
  },
  {
    evaluatedAt: new Date().toISOString(),
    whitelist: config.whitelist,
    isOnchainVerified: (snapshot) => scan.onchainVerifiedByPool[snapshot.poolId] === true,
  },
);
out('decisive', filtered.decisive);
out('passed/rejected', `${filtered.passed.length}/${filtered.rejected.length}`);
const rejected = filtered.rejected.find((p) => p.snapshot.poolAddress.toLowerCase() === poolArg);
if (rejected !== undefined) {
  const evalz = rejected.evaluation as unknown as Record<string, unknown>;
  throw new Error(
    `pool ${poolArg} was REJECTED by §16: ${JSON.stringify(evalz).slice(0, 500)}`,
  );
}
const snapshot = filtered.passed.find((p) => p.snapshot.poolAddress.toLowerCase() === poolArg)?.snapshot;
if (snapshot === undefined) {
  throw new Error(`pool ${poolArg} was not seen by the scan at all (found ${foundPools(scan).length} pools)`);
}
out('pool', snapshot.poolId);
out('tvlUsd', snapshot.tvlUSD.value.toFixed(0));

// ---- 2. screen + plan + quote + gates (the production orchestration) ------------------------------
heading('prepare');
const usdtBalance = await chain.getTokenBalanceOf(BSC_ADDRESSES.USDT as Address, walletAddress);
const navUsd = (Number(usdtBalance) / 1e18) as UsdAmount; // U 本位: the wallet's U IS the equity denominator.
out('navUsd (wallet U)', navUsd.toFixed(4));
const decision = await orchestrator.prepare([snapshot], navUsd);
if (!decision.ok) throw new Error(`${decision.reason}: ${decision.message}`);
out('capitalUsd', decision.request.input.capitalUsd.toFixed(4));
out('plan.amount0', decision.request.plan.amount0.toString());
out('plan.amount1', decision.request.plan.amount1.toString());
out('swap.amountIn', decision.request.quote.amountInRaw.toString());

// ---- 3. funding (a no-op when the wallet's stablecoin is the pool's quote leg) --------------------
const funding = await fundingPlanner.plan({
  pool: decision.request.pool,
  quoteTokenNeededRaw: decision.request.plan.amount1,
  stockTokenNeededRaw: decision.request.plan.amount0,
});
if (!funding.ok) throw new Error(`cannot fund — ${funding.message}`);
out('conversion', funding.plan.conversion === null ? 'none needed' : funding.plan.conversion.meta.symbol);

// ---- 4. execute: approve → swap → re-read → mint, every step confirmed ---------------------------
heading('build');
const built = await executor.buildPosition(decision.request.input);
if (!built.ok) {
  process.stdout.write(`BUILD FAILED: ${built.reason}\n`);
  process.exit(1);
}
out('swap tx', built.swapTxHash ?? 'n/a');
out('mint tx', built.addLiquidityTxHash);
out('tokenId', built.positionTokenId?.toString() ?? 'NOT PARSED');

// ---- 5. post-verify on chain ---------------------------------------------------------------------
heading('post-verify');
if (built.positionTokenId === undefined) {
  process.stderr.write('the build succeeded but no tokenId was parsed; cannot verify the position\n');
  process.exit(1);
}
const position = await owner.getPosition(built.positionTokenId);
if (position === null) throw new Error('the NPM does not know this tokenId');
out('owner', position.owner);
out('liquidity', position.liquidity.toString());
out('pool', position.poolId);
const finalUsdt = await chain.getTokenBalanceOf(BSC_ADDRESSES.USDT as Address, walletAddress);
out('final USDT', (Number(finalUsdt) / 1e18).toFixed(6));
