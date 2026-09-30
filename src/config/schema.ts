import { z } from 'zod';
import { DEX_IDS, TOKEN_RISK_TIERS, type Address } from '../types/primitives.ts';

/**
 * Zod schemas for the three YAML files (`strategy.yaml` §85, `tokens.yaml` §86,
 * `stablecoins.yaml` §87).
 *
 * Design rules:
 * - Unknown keys are REJECTED (`z.strictObject`). A typo'd threshold must fail at startup rather
 *   than silently fall back to a default (fail closed).
 * - Every field carries the §85 default so an omitted block yields the baseline behaviour instead
 *   of `undefined`. Thresholds are explicit even when they merely restate the baseline, because
 *   the operator must be able to see and change them.
 * - Addresses are accepted in any case and normalised to lowercase immediately, because registry
 *   keys are lowercased (an EIP-55 checksum mismatch must not change identity).
 */

/** 20-byte hex address, normalised to lowercase. */
export const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/u, 'must be a 20-byte 0x-prefixed hex address')
  .transform((value) => value.toLowerCase() as Address);

/** Fractional ratio (thresholds such as 0.003, 0.70). */
const ratioSchema = z.number().min(0).max(1);
/** Price multiple (range bounds: lower 0.85, upper 1.16) — may exceed 1. */
const priceMultipleSchema = z.number().positive();
const positiveUsdSchema = z.number().positive();
const nonNegativeUsdSchema = z.number().min(0);
const positiveIntSchema = z.number().int().positive();
const nonNegativeIntSchema = z.number().int().min(0);

const dexIdSchema = z.enum([DEX_IDS.UNISWAP_V3, DEX_IDS.PANCAKESWAP_V3] as const);
const riskTierSchema = z.enum([TOKEN_RISK_TIERS.CORE, TOKEN_RISK_TIERS.HIGH_VOL]);

/** One token entry in `tokens.yaml` / `stablecoins.yaml`. */
export const tokenEntrySchema = z.strictObject({
  /**
   * DISPLAY ALIAS ONLY. Never used as an identity: the same symbol exists on multiple contracts
   * (QQQB/QQQx/QQQon) and on-chain casing is inconsistent. Duplicate symbols across contracts are
   * therefore allowed, and two entries with the same contract address must agree.
   */
  symbol: z.string().min(1),
  chain_id: positiveIntSchema.default(56),
  /** Canonical identity. The only thing that authorises a token. */
  contract: addressSchema,
  name: z.string().min(1).optional(),
  /** §9 risk tier; defaults to the builtin tier, then `CORE` for stocks / `CORE` for stables. */
  risk_tier: riskTierSchema.optional(),
  auto_trade: z.boolean().optional(),
  decimals: z.number().int().min(0).max(36).optional(),
  notes: z.string().min(1).optional(),
});

/** §87 stablecoin priority is a top-level field so ordering is explicit, not list order. */
export const stablecoinEntrySchema = tokenEntrySchema.extend({
  priority: positiveIntSchema.optional(),
});

export const tokensFileSchema = z.strictObject({
  tokens: z.array(tokenEntrySchema).default([]),
});

export const stablecoinsFileSchema = z.strictObject({
  stablecoins: z.array(stablecoinEntrySchema).default([]),
});

const capitalSchema = z.strictObject({
  max_lp_ratio: ratioSchema.default(0.7),
  reserve_ratio: ratioSchema.default(0.3),
  /** §68 InitialStrategyCapital — user-set, never auto-topped-up. */
  initial_strategy_capital_usd: positiveUsdSchema.default(10_000),
});

const monitorSchema = z.strictObject({
  portfolio_interval_minutes: positiveIntSchema.default(5),
  pool_scan_interval_minutes: positiveIntSchema.default(60),
  pool_health_interval_minutes: positiveIntSchema.default(15),
});

const rangeSchema = z.strictObject({
  lower_ratio: priceMultipleSchema.default(0.85),
  upper_ratio: priceMultipleSchema.default(1.16),
});

const yieldSchema = z.strictObject({
  target_net_apr: ratioSchema.default(0.15),
  warning_net_apr: ratioSchema.default(0.12),
  warning_duration_hours: positiveIntSchema.default(72),
});

const poolSchema = z.strictObject({
  min_tvl_usd: nonNegativeUsdSchema.default(500_000),
  min_avg_daily_volume_7d: nonNegativeUsdSchema.default(250_000),
  min_age_days: nonNegativeIntSchema.default(7),
  max_nav_deviation: ratioSchema.default(0.01),
  /**
   * ADMISSION threshold: is this pool deep enough for the budgeted ticket (§16). A property of the pool,
   * independent of any single trade's tolerance.
   */
  max_swap_price_impact: ratioSchema.default(0.005),
});

/**
 * §40 EXECUTION tolerances — how much slippage one swap may accept.
 *
 * Distinct from §16's admission threshold on purpose: admission asks "is this pool deep enough", this
 * asks "how much may THIS swap slip". A deep pool can still quote badly for a moment, and a wide
 * tolerance cannot rescue a pool that fails admission. Per-pool overrides may widen these (the user
 * asked for per-pool 0.8% / 1%) but never below the admission threshold.
 */
const swapSchema = z.strictObject({
  max_slippage: ratioSchema.default(0.003),
  max_price_impact: ratioSchema.default(0.005),
  quote_ttl_seconds: positiveIntSchema.default(30),
});

/** Per-pool §40 override, keyed by the §13 pool identity `chainId:dex:poolAddress`. */
const poolOverrideSchema = z.strictObject({
  max_slippage: ratioSchema.optional(),
  max_price_impact: ratioSchema.optional(),
});

const poolOverridesSchema = z.record(z.string(), poolOverrideSchema);

const switchSchema = z.strictObject({
  min_apr_improvement: ratioSchema.default(0.08),
  max_break_even_days: nonNegativeIntSchema.default(14),
  cooldown_days: nonNegativeIntSchema.default(7),
  max_switch_cost_ratio: ratioSchema.default(0.0075),
});

const riskSchema = z.strictObject({
  /** §65/§66: NAV <= initial * (1 - max_drawdown) triggers GLOBAL_RISK_OFF. */
  max_drawdown: ratioSchema.default(0.15),
  peg_warning: ratioSchema.default(0.01),
  stop_new_position: ratioSchema.default(0.02),
  exit_review: ratioSchema.default(0.03),
  emergency_exit: ratioSchema.default(0.05),
  /** §59 TVL collapse thresholds (24h drop). */
  tvl_drop_review: ratioSchema.default(0.5),
  tvl_drop_emergency: ratioSchema.default(0.7),
  /** §60 reserve floor below which no new LP may be added. */
  min_reserve_before_new_lp: ratioSchema.default(0.25),
  /**
   * Consecutive beats the pool's own contribution must be negative before it is reported.
   *
   * Persistence, not a single reading: two block reads seconds apart can differ by more than the pool's
   * entire contribution, so acting on one would exit on measurement noise and pay a round trip to do it.
   */
  negative_contribution_rounds: z.number().int().min(1).max(1000).default(6),
  /** Ignore negatives smaller than this many USD — the valuation has rounding error. */
  negative_contribution_threshold_usd: nonNegativeUsdSchema.default(1),
});

const feesSchema = z.strictObject({
  /** §61: permanently false in V1 — a `true` here is a deliberate config change, not an accident. */
  auto_compound: z.literal(false).default(false),
  min_collect_usd: nonNegativeUsdSchema.default(100),
  collect_interval_days: positiveIntSchema.default(30),
  /** §63: convert stock-token fees into the stablecoin before they reach the reserve. */
  convert_stock_fees_to_stable: z.boolean().default(true),
});

/**
 * Human confirmation policy. Only building a position and switching a pool need a decision;
 * collect/exit/risk operations stay automatic (§91). `others` is fixed to `auto` so a config
 * cannot quietly demand confirmation for the emergency path and stall an exit.
 */
const approvalsSchema = z.strictObject({
  build_position: z.literal('confirm').default('confirm'),
  switch_pool: z.literal('confirm').default('confirm'),
  others: z.literal('auto').default('auto'),
  /** How long a request stays answerable before it expires (nothing runs after expiry). */
  timeout_minutes: positiveIntSchema.default(30),
});

const telegramSchema = z.strictObject({
  /** false ⇒ the notifier is a no-op and therefore no approval can ever be granted. */
  enabled: z.boolean().default(false),
});

/** §85 Strategy Config. */
export const strategyFileSchema = z.strictObject({
  strategy: z
    .strictObject({
      capital: capitalSchema.prefault({}),
      monitor: monitorSchema.prefault({}),
      range: rangeSchema.prefault({}),
      yield: yieldSchema.prefault({}),
      pool: poolSchema.prefault({}),
      swap: swapSchema.prefault({}),
      // §40 per-pool tolerances; a key is the §13 identity, so the override cannot be applied to a pool
      // identified only by its token pair.
      pool_overrides: poolOverridesSchema.prefault({}),
      switch: switchSchema.prefault({}),
      risk: riskSchema.prefault({}),
      fees: feesSchema.prefault({}),
      approvals: approvalsSchema.prefault({}),
      telegram: telegramSchema.prefault({}),
    })
    .prefault({}),
  /**
   * §11/§12 whitelists. `tokens`/`stablecoins` files are the source of the address list; this block
   * restricts which chains and DEXes may be touched.
   */
  whitelist: z
    .strictObject({
      chains: z.array(positiveIntSchema).default([56]),
      dexes: z
        .array(
          z.strictObject({
            chain_id: positiveIntSchema,
            dex: dexIdSchema,
          }),
        )
        .default([]),
    })
    .prefault({}),
});

export type StrategyYaml = z.infer<typeof strategyFileSchema>;
/** The `strategy:` block only — the typed input of `assembleStrategyConfig`. */
export type StrategyConfigYaml = StrategyYaml['strategy'];
export type TokensYaml = z.infer<typeof tokensFileSchema>;
export type StablecoinsYaml = z.infer<typeof stablecoinsFileSchema>;
export type TokenEntryYaml = z.infer<typeof tokenEntrySchema>;
export type StablecoinEntryYaml = z.infer<typeof stablecoinEntrySchema>;
export type WhitelistYaml = StrategyYaml['whitelist'];
