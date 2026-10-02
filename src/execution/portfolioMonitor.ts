/**
 * §5/§46 portfolio monitoring: assemble one `PortfolioSnapshot` from live chain state.
 *
 * This is the read path everything else hangs off, so it is the only place that turns "wallet + LP
 * position + reference prices" into NAV. Every consumer (§66 drawdown, §60 reserve ratio, §7 fee/IL,
 * §79 reporting) reads the same number from here.
 *
 * Rules this module exists to enforce:
 * - **NAV is not the wallet balance** (§5). LP legs and unclaimed fees are READ from the position
 *   manager and the pool, never inferred from a deposit.
 * - **No price is invented.** A held balance with no usable price makes the valuation incomplete and
 *   is reported, rather than contributing a silent zero that would understate NAV (§96).
 * - **Stablecoins are priced, not assumed to be 1.0.** A stablecoin depeg is exactly the event the
 *   risk layer must see; hardcoding 1.0 would hide it (§58).
 * - **bStocks are UI amounts** (BEP-677). The multiplier comes from `TokenReader` — the same value it
 *   read for the wallet balances — so nothing here assumes 1e18 and no leg can disagree with another.
 * - **Reference NAV is the stock leg's price**, with the pool price only as a fallback (§57); when the
 *   market is closed the reference provider says so and the RISK layer decides, not this module.
 */
import type { BscChainAdapter } from '../chain/adapter.ts';
import type { LpPositionRead, PositionReader } from '../chain/positionReader.ts';
import type { DexId, PoolId } from '../types/primitives.ts';
import type { TokenReader } from '../chain/tokenReader.ts';
import type { PoolSnapshot, Sourced } from '../types/market.ts';
import type { DrawdownState, PortfolioSnapshot } from '../types/portfolio.ts';
import type {
  Address,
  ChainId,
  IsoTimestamp,
  PriceUsd,
  TokenId,
  UnixSeconds,
} from '../types/primitives.ts';
import type { ReferencePriceProvider } from '../types/adapters.ts';
import type { Whitelist } from '../types/registry.ts';
import type { TokenAmount, TokenMeta } from '../types/token.ts';
import {
  verifyPostAllocation,
  type AllocationLimits,
  type AllocationVerification,
} from '../strategy/allocation.ts';
import { buildDrawdownState, buildPortfolioSnapshot } from '../strategy/nav.ts';
import type { BenchmarkPosition, PriceTable } from '../strategy/nav.ts';
import { liquidityToAmounts } from '../strategy/positionPlanner.ts';
import { toFloat } from '../util/decimal.ts';

/** BEP-677 multiplier for a token with no scaling (and the only value a plain ERC-20 can have). */
const ONE = 10n ** 18n;

/** §46 the state one monitoring round reads. */
export interface MonitorInputs {
  readonly walletAddress: Address;
  readonly now: IsoTimestamp;
  /** The open position, when there is one. `null` = flat: reserve only, no LP. */
  readonly position: LpPositionRead | null;
  /** The pool the position belongs to. Required to value the LP legs. */
  readonly pool: PoolSnapshot | null;
  /** §6 entry-time benchmark legs; `null` until a position has been opened. */
  readonly benchmark: BenchmarkPosition | null;
  /** §68 fixed capital; the §65 risk line is derived from it. */
  readonly initialNAV: number;
  /** §4 `reserve_ratio` (0.30) — the §64 principal/profit split point. */
  readonly reserveRatio: number;
  /** Prior high-water mark; `null` on the first round. */
  readonly priorPeakNAV: number | null;
  /** Cumulative realised fees since inception (§64). */
  readonly realizedFees: number;
  readonly gasCost: number;
  readonly swapCost: number;
  readonly slippageCost: number;
}

export interface MonitorResult {
  readonly snapshot: PortfolioSnapshot;
  /**
   * §3/§60 allocation check on the OBSERVED balances: is LP inside `max_lp_ratio`, is the reserve at or
   * above `reserve_ratio`? Reported every round because the user funds the strategy manually and the
   * ratios drift with every deposit — the monitor's job here is to notice, not to act (§68).
   */
  readonly allocation: AllocationVerification;
  /**
   * §65 drawdown, or `null` when the valuation was incomplete.
   *
   * `null` is the honest answer and it is deliberately NOT `{ breached: false }`: with an unpriced leg
   * the snapshot's `totalNAV` is a *floor*, not the portfolio value, so neither "safe" nor "breached" can
   * be concluded. Measured failure this prevents: with no stablecoin price source the reserve valued to
   * zero, `totalNAV` became `0`, and the §66 line reported `breached: true` for a perfectly healthy
   * portfolio — the bot would have halted on a fabricated total loss. A caller that needs a verdict must
   * first make the valuation complete.
   */
  readonly drawdown: DrawdownState | null;
  /** `false` when any leg was unreadable or unpriced — consumers must not act on an incomplete NAV. */
  readonly complete: boolean;
  readonly problems: readonly string[];
}

/** Wallet holdings plus the native balance; named so callers do not reach through the reader. */
export interface WalletRead {
  readonly balances: readonly TokenAmount[];
  readonly nativeBalanceWei: bigint;
}

export interface PortfolioMonitorOptions {
  readonly chain: BscChainAdapter;
  readonly tokenReader: TokenReader;
  readonly positionReader: PositionReader;
  readonly referencePrice: ReferencePriceProvider;
  readonly whitelist: Whitelist;
  /** §65 `StrategyConfig.risk.maxDrawdown`. */
  readonly maxDrawdown: number;
  /**
   * Wallet to monitor when no signer is attached (read-only runs). With a signer the signer's address
   * is used, so a read-only process cannot accidentally watch a different wallet than the one it
   * would trade from.
   */
  readonly watchAddress?: Address;
  /**
   * USD price for a **stablecoin**.
   *
   * Separate from `referencePrice`, which answers for the *stock* leg: the reference provider's job is
   * the stock token's NAV versus the underlying equity, so asking it about USDC is a category error and
   * it correctly returns nothing. Without this, the entire reserve prices to zero and NAV collapses to
   * the LP leg only (measured: `totalNAV = 0` for a healthy wallet, which then tripped §66).
   *
   * Absent ⇒ stablecoins are treated as unpriced and the valuation is reported incomplete, which is the
   * honest outcome rather than assuming 1.0. Assuming 1.0 is what would hide a depeg (§58).
   */
  readonly stablecoinPrice?: (token: TokenMeta) => Promise<Sourced<PriceUsd | null>>;
  /** §46 monitoring cadence, recorded as the observation window on each drawdown reading. */
  readonly windowSeconds?: UnixSeconds;
  /** §3 allocation limits, read from config. Absent ⇒ the allocation check is skipped, not faked. */
  readonly allocationLimits?: AllocationLimits;
}

export class PortfolioMonitor {
  private readonly options: PortfolioMonitorOptions;
  private readonly chainId: ChainId;

  constructor(options: PortfolioMonitorOptions) {
    this.options = options;
    this.chainId = options.chain.chainId;
  }

  /** The address being monitored. A signer always wins over the configured watch address. */
  walletAddress(): Address {
    const signer = this.options.chain.getSignerAddress();
    if (signer !== null) return signer;
    const configured = this.options.watchAddress;
    if (configured === undefined) {
      throw new Error(
        'no wallet to monitor: attach a signer or set STRATEGY_WALLET_ADDRESS (even read-only monitoring needs an address)',
      );
    }
    return configured;
  }

  /**
   * §46 wallet balances for every whitelisted token plus native BNB.
   *
   * All whitelisted addresses are read in one batch and UI-converted by `TokenReader`, so a bStock
   * leg is reported in the units its issuer displays (BEP-677) with the live multiplier.
   */
  async readWallet(): Promise<WalletRead> {
    const holder = this.walletAddress();
    const addresses = this.options.whitelist.registry.listAddresses(this.chainId);
    const balances = await this.options.tokenReader.getBalances(addresses, holder);
    const nativeBalanceWei = await this.options.chain.getNativeBalance(holder);
    return { balances, nativeBalanceWei };
  }

  /**
   * Price table for valuation, built from the reference provider.
   *
   * Returns the problems it found rather than throwing: an unpriced leg is a degraded valuation the
   * caller must see, not a crash — the monitor is also what powers the critical alerts.
   */
  async buildPriceTable(
    pool: PoolSnapshot | null,
    held: ReadonlySet<TokenId> = new Set(),
  ): Promise<{
    readonly prices: PriceTable;
    readonly problems: readonly string[];
  }> {
    const problems: string[] = [];
    const prices = new Map<TokenId, PriceUsd>();
    // A missing price only matters for a token the wallet actually holds: with a zero balance there is
    // nothing for the absent price to understate. Without this distinction the monitor reported the whole
    // whitelist as a problem and every valuation looked incomplete, which in turn suppressed the §65
    // verdict even for a perfectly priceable portfolio.
    const matters = (id: TokenId): boolean => held.size === 0 || held.has(id);

    for (const meta of this.options.whitelist.registry.list()) {
      // Wrapped native is not a strategy leg and has no wired USD source. Skipping it is correct; a
      // held wrapped-native balance still surfaces through the held-but-unpriced check.
      if (meta.kind === 'wrapped-native') continue;

      // A stablecoin is priced by the stablecoin source, never by the stock reference provider: the
      // latter answers the stock leg's NAV-versus-equity question and knows nothing about USDC.
      if (meta.kind === 'stablecoin' && this.options.stablecoinPrice !== undefined) {
        const stable = await this.options.stablecoinPrice(meta);
        if (!stable.stale && stable.value !== null) {
          prices.set(meta.id, stable.value);
          continue;
        }
        if (matters(meta.id)) {
          problems.push(
            `${meta.symbol}: stablecoin price unavailable (${stable.source}) — NAV would exclude this ` +
              'holding, so the valuation is incomplete rather than assuming 1.0',
          );
        }
        continue;
      }

      const reference = await this.options.referencePrice.getStockReferencePrice(meta.address);
      if (!reference.stale && reference.value !== null) {
        prices.set(meta.id, reference.value);
        continue;
      }

      // Only a stock leg actually in the pool may fall back to the pool price: that price is real and
      // tradable even when the reference NAV is unavailable (§57). A stablecoin never falls back —
      // its depeg is precisely what must stay visible.
      const fallback = meta.isStockToken ? this.poolStockPrice(pool, meta) : null;
      if (fallback === null) {
        if (matters(meta.id)) {
          problems.push(
            `${meta.symbol}: no usable reference price (${reference.source}); a non-zero balance of it would understate NAV`,
          );
        }
        continue;
      }
      if (matters(meta.id)) {
        problems.push(
          `${meta.symbol}: reference price unusable (${reference.source}); valued at the pool price $${fallback.toFixed(4)} instead`,
        );
      }
      prices.set(meta.id, fallback);
    }

    return { prices, problems };
  }

  /** Pool price for a stock leg, when this pool quotes that leg against a stablecoin. */
  private poolStockPrice(pool: PoolSnapshot | null, meta: TokenMeta): PriceUsd | null {
    if (pool === null) return null;
    const address = meta.address.toLowerCase();
    const inPool = pool.token0.toLowerCase() === address || pool.token1.toLowerCase() === address;
    if (!inPool) return null;
    // §12 whitelists only stock/stable pools, so `currentPrice` is USD per whole stock token.
    const price = pool.currentPrice.value;
    return Number.isFinite(price) && price > 0 ? price : null;
  }

  /**
   * §5 LP legs as RAW amounts, from the position's liquidity at the pool's live price.
   *
   * The math is the same §37 function the planner uses, evaluated at the CURRENT tick: that is what
   * the pool would return on withdraw right now, which is the number NAV needs. A second
   * implementation is how the two would drift.
   */
  lpLegs(
    position: LpPositionRead,
    pool: PoolSnapshot,
  ): { readonly amount0: bigint; readonly amount1: bigint } {
    return liquidityToAmounts({
      tick: pool.currentTick,
      lowerTick: position.tickLower,
      upperTick: position.tickUpper,
      sqrtPriceX96: pool.sqrtPriceX96,
      liquidity: position.liquidity,
    });
  }

  /**
   * USD value of the LP position.
   *
   * `null` means "could not value" and is deliberately distinct from `0` meaning "flat" — conflating
   * them would let a missing pool price look like an empty position (§96).
   */
  lpPositionValue(
    position: LpPositionRead | null,
    pool: PoolSnapshot | null,
    prices: PriceTable,
  ): number | null {
    if (position === null) return 0;
    if (position.liquidity === 0n) return 0;
    if (pool === null) return null;

    const token0 = this.tokenMeta(pool.token0);
    const token1 = this.tokenMeta(pool.token1);
    if (token0 === null || token1 === null) return null;

    const price0 = prices.get(token0.id);
    const price1 = prices.get(token1.id);
    if (price0 === undefined || price1 === undefined) return null;

    const { amount0, amount1 } = this.lpLegs(position, pool);
    return toFloat(amount0, token0.decimals) * price0 + toFloat(amount1, token1.decimals) * price1;
  }

  /**
   * One §46 round: read the wallet, price everything, value the position, derive the §65 drawdown.
   *
   * `complete` is the gate. Any unread or unpriced holding sets it false, and the caller must treat an
   * incomplete NAV as unusable for decisions rather than as merely a smaller NAV.
   */
  /**
   * The LIVE position (§4.2.1: read the chain, never a cache), plus the pool's current slot0.
   *
   * `null` when the position is gone (burned/owned elsewhere) — different from "the record exists but
   * the read failed"; the caller distinguishes via the pool/position reads it still holds.
   */
  async readOpenPosition(record: {
    readonly dex: string;
    readonly id: string;
    readonly poolAddress: Address;
    readonly poolId: PoolId;
  }): Promise<{ readonly position: LpPositionRead | null; readonly sqrtPriceX96: bigint; readonly tick: number } | null> {
    const read = await this.options.positionReader.getPositionView({
      dex: record.poolId.split(':')[1] as DexId,
      tokenId: BigInt(record.id),
      poolAddress: record.poolAddress,
    });
    const [slot0] = await Promise.all([
      this.options.chain.readContract<readonly [bigint, number]>({
        address: record.poolAddress,
        abi: [
          { type: 'function', name: 'slot0', stateMutability: 'view',
            inputs: [], outputs: [{ name: 'sqrtPriceX96', type: 'uint160' }, { name: 'tick', type: 'int24' }] },
        ],
        functionName: 'slot0',
        args: [],
      }),
    ]);
    return {
      position: read === null ? null : { ...read, poolId: record.poolId },
      sqrtPriceX96: slot0.value[0],
      tick: slot0.value[1],
    };
  }

  async monitor(inputs: MonitorInputs): Promise<MonitorResult> {
    const { balances, nativeBalanceWei } = await this.readWallet();
    // Which tokens actually have a balance decides which missing prices matter, so the wallet is read
    // first and the held set is passed into pricing.
    const held = new Set<TokenId>();
    for (const balance of balances) {
      if (balance.ui !== 0n) held.add(balance.tokenId);
    }
    const { prices, problems: priceProblems } = await this.buildPriceTable(inputs.pool, held);
    const problems: string[] = [...priceProblems];

    for (const balance of balances) {
      if (balance.ui !== 0n && !prices.has(balance.tokenId)) {
        problems.push(`${balance.tokenId}: held with a non-zero balance but no price — NAV is understated`);
      }
    }

    /*
     * 腿价 (§4.2.1): legs are priced from the POSITION when there is one — the scan snapshot is a
     * bonus, not a precondition. A pool falling out of the §16 list at some round must never fold the
     * LP into "no position" again: measured live, the wallet's U was counted and the LP counted as 0,
     * which put NAV ~30% below the truth and tripped the §66 line on a healthy position.
     */
    const legTokens = new Set(balances.map((b) => b.tokenId as TokenId));
    const hasLivePosition = inputs.position !== null;
    if (hasLivePosition) {
      legTokens.add(this.options.whitelist.registry.getTokenByAddress(this.chainId, inputs.position!.token0)?.id ?? '');
      legTokens.add(this.options.whitelist.registry.getTokenByAddress(this.chainId, inputs.position!.token1)?.id ?? '');
      legTokens.delete('');
    }

    // The multiplier is read once per token from the balance batch and reused for the LP and fee legs,
    // so a bStock leg can never be valued with a different multiplier than the wallet balance was.
    const multipliers = multiplierTable(balances);

    let lpLeg0: TokenAmount;
    let lpLeg1: TokenAmount;
    let feeLeg0: TokenAmount;
    let feeLeg1: TokenAmount;
    let lpValue: number | null = null;

    // The legs now come from the LIVE position when there is one; the scan snapshot contributes only
    // when it happens to be present. AND-ing them was what folded the LP out of NAV: a pool drifting
    // out of the §16 list zeroed the position entirely while the tokens sat on chain (2026-10-02 live).
    if (hasLivePosition && inputs.position !== null) {
      const pos = inputs.position;
      const meta0 = this.requireToken(pos.token0);
      const meta1 = this.requireToken(pos.token1);

      let sqrtPriceX96 = inputs.pool?.sqrtPriceX96;
      let tick = inputs.pool?.currentTick;
      if (sqrtPriceX96 === undefined || tick === undefined) {
        // No scan snapshot: read the pool's own head from the chain — the position's raw truth.
        const poolAddress = pos.poolId.split(':')[2] as Address; // §13 tail = pool address
        const slot0 = await this.options.chain.readContract<readonly [bigint, number]>({
          address: poolAddress,
          abi: [
            { type: 'function', name: 'slot0', stateMutability: 'view',
              inputs: [], outputs: [{ name: 'sqrtPriceX96', type: 'uint160' }, { name: 'tick', type: 'int24' }] },
          ],
          functionName: 'slot0',
          args: [],
        });
        sqrtPriceX96 = slot0.value[0];
        tick = slot0.value[1];
      }

      const { amount0, amount1 } = liquidityToAmounts({
        tick,
        lowerTick: pos.tickLower,
        upperTick: pos.tickUpper,
        sqrtPriceX96,
        liquidity: pos.liquidity,
      });
      lpLeg0 = amountOf(meta0, amount0, multipliers);
      lpLeg1 = amountOf(meta1, amount1, multipliers);
      // §108 "unclaimed fees": tokensOwed0/1 are RA amounts the manager already owes.
      feeLeg0 = amountOf(meta0, pos.tokensOwed0Raw, multipliers);
      feeLeg1 = amountOf(meta1, pos.tokensOwed1Raw, multipliers);

      const price0 = prices.get(meta0.id);
      const price1 = prices.get(meta1.id);
      lpValue =
        price0 === undefined || price1 === undefined
          ? null
          : toFloat(amount0, meta0.decimals) * price0 + toFloat(amount1, meta1.decimals) * price1;
      if (lpValue === null) {
        problems.push(
          `LP position could not be valued fully (missing ${meta0.symbol ?? meta0.id}/${meta1.symbol ?? meta1.id} price) — position equity excludes that leg`,
        );
      }
    } else if (inputs.pool === null) {
      // Flat portfolio: zero legs, anchor-token holders only.
      const anchor0 = this.anchorToken();
      const anchor1 = this.anchorToken();
      lpLeg0 = zeroAmount(anchor0, multipliers);
      lpLeg1 = zeroAmount(anchor1, multipliers);
      feeLeg0 = lpLeg0;
      feeLeg1 = lpLeg1;
    } else {
      // DEAD shape retained for type completeness (pool without position), zeroed legs.
      const meta0 = this.requireToken(inputs.pool.token0);
      const meta1 = this.requireToken(inputs.pool.token1);
      lpLeg0 = zeroAmount(meta0, multipliers);
      lpLeg1 = zeroAmount(meta1, multipliers);
      feeLeg0 = lpLeg0;
      feeLeg1 = lpLeg1;
    }

    const result = buildPortfolioSnapshot({
      chainId: this.chainId,
      walletAddress: inputs.walletAddress,
      timestamp: inputs.now,
      registry: this.options.whitelist.registry,
      prices,
      walletBalances: balances,
      nativeBalanceWei,
      lpToken0: lpLeg0,
      lpToken1: lpLeg1,
      lpPositionValueOverride: lpValue,
      unclaimedFeeToken0: feeLeg0,
      unclaimedFeeToken1: feeLeg1,
      realizedFees: inputs.realizedFees,
      gasCost: inputs.gasCost,
      swapCost: inputs.swapCost,
      slippageCost: inputs.slippageCost,
      initialNAV: inputs.initialNAV,
      reserveRatio: inputs.reserveRatio,
      priorPeakNAV: inputs.priorPeakNAV,
      benchmark: inputs.benchmark,
    });

    for (const tokenId of result.unpricedTokens) {
      problems.push(`${tokenId}: held with a non-zero balance but no price — NAV is understated`);
    }

    return {
      snapshot: result.snapshot,
      allocation:
        this.options.allocationLimits === undefined
          ? verifyPostAllocation({
              // Without configured limits there is nothing to compare against, so the check reports
              // itself unjudgeable rather than passing.
              navUsd: Number.NaN,
              lpValueUsd: result.snapshot.lpPositionValue,
              reserveUsd: result.snapshot.walletStablecoinValue,
              limits: { maxLpRatio: 1, reserveRatio: 0 },
            })
          : verifyPostAllocation({
              navUsd: result.snapshot.totalNAV,
              lpValueUsd: result.snapshot.lpPositionValue,
              reserveUsd: result.snapshot.walletStablecoinValue,
              limits: this.options.allocationLimits,
            }),
      // §65 is only assessed on a COMPLETE valuation: an unpriced leg makes `totalNAV` a floor, so a
      // breach verdict derived from it would be a claim about a number we know is wrong.
      drawdown:
        problems.length === 0
          ? buildDrawdownState(
              result.snapshot,
              this.options.maxDrawdown,
              inputs.now,
              this.options.windowSeconds ?? 300,
            )
          : null,
      complete: problems.length === 0,
      problems: dedupe(problems),
    };
  }

  private tokenMeta(address: Address): TokenMeta | null {
    return this.options.whitelist.registry.getTokenByAddress(this.chainId, address);
  }

  /** A pool leg must be whitelisted; §8 identity is the address, so a miss is a real inconsistency. */
  private requireToken(address: Address): TokenMeta {
    return this.options.whitelist.registry.requireTokenByAddress(this.chainId, address);
  }

  private anchorToken(): TokenMeta {
    const token = this.options.whitelist.registry.list()[0];
    if (token === undefined) {
      throw new Error('whitelist is empty: refusing to build a portfolio snapshot (§96)');
    }
    return token;
  }
}

/** Live BEP-677 multiplier per token id, taken from the balance batch that already read it. */
function multiplierTable(balances: readonly TokenAmount[]): ReadonlyMap<TokenId, bigint> {
  const table = new Map<TokenId, bigint>();
  for (const balance of balances) table.set(balance.tokenId, balance.uiMultiplier);
  return table;
}

/** `ui = raw * multiplier / 1e18`, with the multiplier the balance read observed (never an assumed 1e18). */
function amountOf(meta: TokenMeta, raw: bigint, multipliers: ReadonlyMap<TokenId, bigint>): TokenAmount {
  const uiMultiplier = multipliers.get(meta.id) ?? ONE;
  return {
    tokenId: meta.id,
    address: meta.address,
    decimals: meta.decimals,
    raw,
    ui: (raw * uiMultiplier) / ONE,
    uiMultiplier,
  };
}

function zeroAmount(meta: TokenMeta, multipliers: ReadonlyMap<TokenId, bigint>): TokenAmount {
  return amountOf(meta, 0n, multipliers);
}

function dedupe(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
