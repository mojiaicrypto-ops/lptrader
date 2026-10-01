/**
 * Operator-facing message formatting.
 *
 * ## Why this module exists
 *
 * Every alert was assembled inline at its call site, and the result read like internal logging rather
 * than something a person would act on. Measured output from a real run:
 *
 * ```text
 * risk: NO_NEW_CAPITAL
 * NO_NEW_CAPITAL (severity info)                                     ← repeats the title
 *   · NO_NEW_CAPITAL: §60 reserve 0.00% < 25.00% — new LP prohibited ← repeats it a third time,
 *      (no forced rebalance); §105 below the 20.00% warning floor       and cites clause numbers
 * NAV: $0
 * ```
 *
 * Three problems, each of which this module removes by construction:
 *
 * 1. **The same fact stated three times.** A title is a conclusion; the body must add information, not
 *    restate it.
 * 2. **Clause numbers and internal vocabulary.** `§60`, `PARTIAL_POSITION`, `insufficient-data` are how
 *    the system describes itself to its authors. An operator needs to know what to DO.
 * 3. **One line carrying several assertions.** A run-on sentence cannot be skimmed on a phone.
 *
 * ## The shape every message follows
 *
 * ```text
 * ⚠️ 暂不能开新仓                        ← one line, the conclusion
 *
 *   储备金 0.0%（下限 25%）               ← the numbers that support it
 *   总权益 $0
 *
 *   钱包还没有资金。转入后即可开始。        ← what to do next, when there is something to do
 * ```
 *
 * ## Severity is carried by the icon, not by a word
 *
 * `severity info` in the body told the operator nothing they could not see, while an icon is read at a
 * glance in a notification list. The word is dropped; the icon stays.
 */

/** Severity icons. One glyph per level, so a notification list can be scanned without reading. */
export const SEVERITY_ICONS = {
  info: 'ℹ️',
  warning: '⚠️',
  critical: '🔴',
} as const;

export type MessageSeverity = keyof typeof SEVERITY_ICONS;

/**
 * Prefix a title with its severity icon.
 *
 * Applied centrally rather than at each call site: 17 sites each prepending their own glyph is 17 chances
 * to use the wrong one, and the icon is the only thing conveying severity now that the word is gone.
 */
export function titleWithIcon(severity: MessageSeverity, title: string): string {
  return `${SEVERITY_ICONS[severity]} ${title}`;
}

/** One labelled value, rendered as `label: value` with the label padded to a common width. */
export interface MessageRow {
  readonly label: string;
  readonly value: string;
}

/**
 * Render labelled rows aligned to the widest label.
 *
 * Alignment is what makes a list scannable: ragged values force the eye to hunt for each number, which is
 * the difference between reading a message and decoding it.
 */
export function renderRows(rows: readonly MessageRow[]): string {
  if (rows.length === 0) return '';
  const width = Math.max(...rows.map((row) => displayWidth(row.label)));
  return rows
    .map((row) => `  ${row.label}${' '.repeat(width - displayWidth(row.label))}  ${row.value}`)
    .join('\n');
}

/**
 * Display width, counting CJK characters as two columns.
 *
 * `String.length` would misalign every Chinese label: a terminal renders 储备金 (3 characters, 6 columns)
 * wider than `TVL` (3 characters, 3 columns), so padding by character count produces visibly ragged output.
 */
function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    width += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/u.test(char)
      ? 2
      : 1;
  }
  return width;
}

/** A fully-formed operator message: a conclusion, its supporting rows, and an optional instruction. */
export interface OperatorMessage {
  readonly severity: MessageSeverity;
  /** The conclusion. One line, no trailing period, no restatement of the body. */
  readonly title: string;
  readonly rows?: readonly MessageRow[];
  /** What the operator should do. Omitted when there is nothing to do. */
  readonly action?: string;
  /** A short explanation for the unusual cases, placed last so it never delays the actionable part. */
  readonly note?: string;
}

/** Render a message for Telegram. */
export function renderMessage(message: OperatorMessage): string {
  const blocks: string[] = [];
  const rows = renderRows(message.rows ?? []);
  if (rows.length > 0) blocks.push(rows);
  if (message.action !== undefined && message.action.length > 0) blocks.push(message.action);
  if (message.note !== undefined && message.note.length > 0) blocks.push(message.note);
  return blocks.join('\n\n');
}

/** USD for a message: thousands separators, two decimals, no trailing zeros on whole amounts. */
export function usd(value: number): string {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** A ratio as a percentage. */
export function pct(value: number, digits = 2): string {
  return `${(value * 100).toFixed(digits)}%`;
}

/**
 * Plain-language names for the internal condition codes.
 *
 * The codes are the system's own vocabulary — precise, stable, and meaningless to the operator. Mapping
 * them here (rather than at each call site) keeps one translation table instead of a dozen ad-hoc ones.
 */
export const CONDITION_LABELS: Readonly<Record<string, string>> = {
  TVL_BELOW_MINIMUM: '池子规模不足',
  TVL_UNAVAILABLE: '池子规模读不到',
  VOLUME_7D_BELOW_MINIMUM: '成交量不足',
  VOLUME_7D_UNAVAILABLE: '成交量读不到',
  POOL_AGE_BELOW_MINIMUM: '池子上线时间太短',
  NAV_DEVIATION_EXCEEDED: '代币偏离净值过多',
  NAV_DEVIATION_UNAVAILABLE: '净值偏离读不到',
  SWAP_IMPACT_EXCEEDED: '大额兑换影响价格过多',
  SWAP_IMPACT_UNAVAILABLE: '价格影响读不到',
  ONCHAIN_UNVERIFIED: '链上状态未验证',
  SNAPSHOT_INCONSISTENT: '数据自相矛盾',
  CHAIN_NOT_WHITELISTED: '不在链的白名单',
  DEX_NOT_WHITELISTED: '不在交易所白名单',
  LEG_NOT_WHITELISTED: '代币不在白名单',
  STOCK_LEG_MISSING: '缺少股票代币那一脚',
  STABLECOIN_LEG_MISSING: '缺少稳定币那一脚',
  NO_QUALIFIED_POOL: '没有合格的池子',
  SCREEN_ABORTED: '数据源故障，未能完成筛选',
  ALLOCATION_REFUSED: '超出资金配置比例',
  PLAN_FAILED: '仓位计划算不出来',
  QUOTE_FAILED: '拿不到报价',
  GATE_REFUSED: '兑换条件不达标',
  TOKEN_METADATA_MISSING: '代币信息缺失',
  NO_QUOTE_TOKEN_FUNDS: '资金不足',
  NO_CONVERSION_SOURCE: '没有可兑换的稳定币',
};

/** The operator-facing name for a condition code, falling back to the code when unmapped. */
export function conditionLabel(code: string): string {
  return CONDITION_LABELS[code] ?? code;
}

/**
 * Risk actions in plain language, as a headline.
 *
 * Covers every member of `RISK_ACTIONS` — a missing key would fall back to the raw code, which is the
 * internal vocabulary this module exists to remove.
 */
export const RISK_HEADLINES: Readonly<Record<string, string>> = {
  HOLD: '一切正常',
  ALERT: '需要留意',
  BOUNDARY_WATCH: '价格接近区间边界',
  MARKET_RISK: '市场整体下跌',
  NO_NEW_CAPITAL: '暂不能开新仓',
  RISK_REVIEW: '需要你判断',
  OUT_OF_RANGE_UP: '价格涨出区间',
  EXIT_REVIEW: '建议考虑撤池',
  GLOBAL_RISK_OFF: '已触及全局止损线',
  EMERGENCY: '紧急情况',
  EMERGENCY_EXIT: '严重脱锚，已自动撤池',
};

/** The headline for a risk action, falling back to the action code. */
export function riskHeadline(action: string): string {
  return RISK_HEADLINES[action] ?? action;
}
