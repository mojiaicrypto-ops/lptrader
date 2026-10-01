/**
 * `/status` `/position` `/pools` `/nav` `/risk` — answered from the query cache.
 *
 * ## The rule these follow
 *
 * Never read the chain, never run a scan. The data sources have per-minute budgets and a fresh scan takes
 * minutes; a command that fetched live would both starve the cadences and time out in Telegram. Everything
 * here reads the last observation and states when it was taken.
 *
 * ## "Not measured yet" is not zero
 *
 * A command answered before the first beat must say so. Printing `$0.00` would read as a real measurement
 * and, for NAV, as a catastrophic one. This is the same fail-closed discipline the rest of the system uses,
 * applied to the operator's view.
 *
 * ## Reading it
 *
 * Labels are aligned so the eye can run down the values, the conclusion comes first and the supporting
 * numbers follow, and the explanation is one short paragraph — not the internal reasoning. Clause numbers
 * and condition codes stay out: an operator acts on "储备金不足", not on "§60".
 */
import type { QueryHandlers } from '../notify/telegram.ts';
import type { QueryCache, PoolView } from './queryCache.ts';
import { renderRows, usd, pct, riskHeadline } from '../notify/messageFormat.ts';

/** Human-readable age, so freshness is legible rather than a timestamp to compute in one's head. */
function ageLabel(at: string, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - Date.parse(at)) / 1000));
  if (seconds < 90) return `${seconds} 秒前`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} 分钟前`;
  return `${Math.round(minutes / 60)} 小时前`;
}

function measured(at: string, nowMs: number): string {
  return `数据取自 ${ageLabel(at, nowMs)}`;
}

/**
 * How many pools to list.
 *
 * `/pools` is read on a phone. Ten candidates with full reason text each is unreadable, which is the
 * observed size — so the admitted ones are shown in full and the rejected ones are counted, with their
 * reasons available via `/pools all`.
 */
const POOL_LIST_LIMIT = 5;

export interface QueryHandlerDeps {
  readonly cache: QueryCache;
  /** Injected so the output can say how old it is without the handler owning a clock. */
  readonly now?: () => number;
}

export function createQueryHandlers(deps: QueryHandlerDeps): QueryHandlers {
  const nowMs = (): number => deps.now?.() ?? Date.now();
  const cache = deps.cache;

  const notMeasured = (what: string, firstBeat: string): string =>
    `${what}：还没有数据。\n\n第一轮${firstBeat}尚未完成。冷启动的首轮扫描约 4 分钟（数据源限流），` +
    '刚启动时看到这条是正常的。';

  return {
    status: () => {
      const observed = cache.status;
      if (observed === null) return notMeasured('状态', '自检');
      const s = observed.value;
      const rows = [
        // The §44 state names are the system's own vocabulary; a state an operator cannot read is not
        // information. Mapped rather than renamed, because the codes are what the audit trail records.
        { label: '运行状态', value: STATE_LABELS[s.state] ?? s.state },
        { label: '模式', value: s.readOnly ? '只读监控（不能交易）' : '实盘' },
        { label: '试运行', value: s.dryRun ? '是（不广播交易）' : '否 —— 会真实签名发送' },
        { label: '通知', value: s.telegramEnabled ? '已启用' : '未启用（不能建仓，也无法确认）' },
        {
          label: '节拍',
          value: s.cadences
            .map((c) => `${BEAT_LABELS[c.name] ?? c.name} ${c.intervalMinutes} 分`)
            .join(' · '),
        },
      ];
      const position = cache.position;
      rows.push({
        label: '当前仓位',
        value:
          cache.positionObservedAt === null
            ? '尚未读取'
            : position === null
              ? '空仓'
              : position.value.poolId.split(':')[2]?.slice(0, 12) ?? position.value.poolId,
      });
      return `${renderRows(rows)}\n\n${measured(observed.at, nowMs())}`;
    },

    position: () => {
      if (cache.positionObservedAt === null) return notMeasured('仓位', '估值节拍');
      const observed = cache.position;
      if (observed === null) {
        return '当前空仓。\n\n这是实测结果，不是数据缺失 —— 最近一轮估值确实没有找到仓位。\n想建仓请发 /start。';
      }
      const p = observed.value;
      const rows = [
        { label: '池子', value: p.poolId.split(':')[2]?.slice(0, 12) ?? p.poolId },
        { label: '交易所', value: p.dex },
        { label: '仓位编号', value: p.positionTokenId },
        { label: '区间位置', value: `${pct(p.rangeProgress)}（0% 在下限，100% 在上限）` },
        { label: '未领手续费', value: usd(p.unclaimedFeesUsd) },
        { label: '开仓时间', value: p.openedAt.slice(0, 16).replace('T', ' ') },
      ];
      return `${renderRows(rows)}\n\n${measured(observed.at, nowMs())}`;
    },

    pools: (args) => {
      const observed = cache.pools;
      if (observed === null) return notMeasured('池子', '扫描节拍');

      const showAll = args.trim().toLowerCase() === 'all';
      const pools = observed.value;
      const admitted = pools.filter((p) => p.admitted);
      const indeterminate = pools.filter((p) => !p.admitted && p.indeterminate);
      const rejected = pools.filter((p) => !p.admitted && !p.indeterminate);

      const lines = [
        `最近一轮扫描发现 ${pools.length} 个候选池`,
        '',
        renderRows([
          { label: '已通过初筛', value: String(admitted.length) },
          { label: '不合格', value: String(rejected.length) },
          { label: '数据缺失未判定', value: String(indeterminate.length) },
        ]),
      ];

      if (admitted.length > 0) {
        lines.push('', `通过初筛（${admitted.length} 个）：`);
        for (const pool of admitted.slice(0, POOL_LIST_LIMIT)) lines.push(describePool(pool));
        if (admitted.length > POOL_LIST_LIMIT) lines.push(`  …另有 ${admitted.length - POOL_LIST_LIMIT} 个`);
        lines.push('', '注意：这些池子尚未做链上核验。真正建仓前会再读链确认价格影响与区间对齐。');
      } else {
        lines.push('', '当前没有池子通过初筛。发 /pools all 查看每个池子的具体原因。');
      }

      if (indeterminate.length > 0) {
        // Separated deliberately: these are a DATA problem, and calling them "rejected" would send the
        // operator looking for a pool problem that does not exist.
        lines.push('', `因数据缺失未判定（${indeterminate.length} 个）：`);
        for (const pool of indeterminate.slice(0, POOL_LIST_LIMIT)) {
          lines.push(`  ${shortId(pool.poolId)}  ${pool.reasons.map(plainReason).slice(0, 1).join('')}`);
        }
      }

      if (showAll && rejected.length > 0) {
        lines.push('', '不合格的池子：');
        for (const pool of rejected) {
          lines.push(describePool(pool));
          for (const reason of pool.reasons.slice(0, 2)) lines.push(`      ${plainReason(reason)}`);
        }
      } else if (rejected.length > 0) {
        lines.push('', `（${rejected.length} 个不合格 —— 发 /pools all 查看原因）`);
      }

      lines.push('', measured(observed.at, nowMs()));
      return lines.join('\n');
    },

    nav: () => {
      const observed = cache.nav;
      if (observed === null) return notMeasured('净值', '估值节拍');
      const n = observed.value;

      const lines = [
        renderRows([
          { label: '总权益', value: usd(n.totalNavUsd) },
          { label: '其中钱包', value: usd(n.walletUsd) },
          { label: '其中 LP', value: usd(n.lpValueUsd) },
          { label: '未领手续费', value: usd(n.unclaimedFeesUsd) },
        ]),
        '',
        renderRows([
          { label: '储备金比例', value: `${pct(n.reserveRatio)}（下限 25%）` },
          { label: 'LP 比例', value: `${pct(n.lpRatio)}（上限 70%）` },
          { label: '回撤', value: `${pct(n.drawdown)}（15% 触线）` },
        ]),
      ];

      const r = n.returns;
      if (r !== undefined) {
        lines.push('', '收益：');
        if (r.returnRatio === null) {
          lines.push('  这笔仓位没有记录入场权益，无法计算收益率。');
        } else {
          lines.push(
            renderRows([
              { label: '总收益', value: `${sign(r.returnUsd ?? 0)}（${signPct(r.returnRatio)}）` },
              ...(r.marketContributionUsd === null
                ? []
                : [{ label: '其中股价', value: sign(r.marketContributionUsd) }]),
              ...(r.poolContributionUsd === null
                ? []
                : [{ label: '其中池子', value: `${sign(r.poolContributionUsd)}${r.poolContributionUsd < 0 ? '（拖累）' : ''}` }]),
            ]),
          );
          lines.push('', '  「其中池子」为负说明池子本身在拖后腿 —— 这才是考虑换池的理由，总收益为负未必是。');
        }
        if (r.incompleteReasons.length > 0) {
          lines.push('', `  （归因不完整：${r.incompleteReasons[0]}）`);
        }
      }

      lines.push('', measured(observed.at, nowMs()));
      return lines.join('\n');
    },

    risk: () => {
      const observed = cache.risk;
      if (observed === null) return notMeasured('风控', '估值或池健康节拍');
      const r = observed.value;

      const lines = [
        renderRows([
          { label: '结论', value: riskHeadline(r.action) },
          ...(r.navUsd === undefined ? [] : [{ label: '判定时权益', value: usd(r.navUsd) }]),
        ]),
      ];

      if (r.valuationProblems !== undefined && r.valuationProblems.length > 0) {
        // No verdict was produced. Saying so is the point: an incomplete valuation must not read as "safe".
        lines.push('', '本轮没有判定 —— 部分资产价格读不到，所以止损线无法计算。这不代表安全。');
      }

      lines.push('', measured(observed.at, nowMs()));
      return lines.join('\n');
    },
  };
}

/** `56:pancakeswap-v3:0xe9b9998b…` → `…e9b9998b` — the tail is what tells pools apart. */
function shortId(poolId: string): string {
  const address = poolId.split(':')[2] ?? poolId;
  return `…${address.slice(-10)}`;
}

function describePool(pool: PoolView): string {
  const apr = pool.estimatedApr7d === null ? '收益率读不到' : `年化 ${pct(pool.estimatedApr7d)}`;
  return (
    `  ${shortId(pool.poolId)}\n` +
    `      规模 ${usd(pool.tvlUsd)} · 日均成交 ${usd(pool.avgDailyVolume7dUsd)} · ` +
    // Rounded: the age is a float derived from a timestamp, and `63.993998043981485 天` reads as noise on a
    // phone. Whole days is the resolution an operator judges a pool by.
    `上线 ${Math.round(pool.poolAgeDays)} 天 · ${apr}`
  );
}

/**
 * Turn a filter's internal reason into something an operator can act on.
 *
 * The engine's text is precise and cites clause numbers; on a phone that is noise. Only the code prefix is
 * translated: the numbers that follow it are the useful part and are kept verbatim.
 */
function plainReason(reason: string): string {
  const match = /^\[([A-Z_]+)\]\s*(.*)$/u.exec(reason.trim());
  if (match === null) return reason.trim();
  const [, code, rest] = match;
  return CONDITION_LABELS[code ?? ''] ?? rest ?? reason.trim();
}

/** The three cadences, named for what they do rather than by their internal id. */
const BEAT_LABELS: Readonly<Record<string, string>> = {
  'pool-scan': '扫描池子',
  'portfolio-monitor': '估值',
  'pool-health': '池子健康',
};

/** The §44 states in plain language. */
const STATE_LABELS: Readonly<Record<string, string>> = {
  IDLE: '空仓待命',
  SELECT_POOL: '正在选池',
  PREPARE_POSITION: '正在准备建仓',
  SWAP: '正在兑换',
  ADD_LIQUIDITY: '正在注入流动性',
  MONITOR: '监控中',
  OUT_OF_RANGE: '价格在区间外',
  UNDERPERFORMING: '收益不佳',
  SEARCH_REPLACEMENT: '正在寻找替代池',
  EXIT_POSITION: '正在撤池',
  SWITCH_POOL: '正在换池',
  RISK_REVIEW: '待人工判断',
  GLOBAL_RISK_OFF: '已全局停机',
  PAUSED: '已暂停',
  ERROR: '故障',
  PARTIAL_POSITION: '建仓未完成，需人工处理',
  EMERGENCY: '紧急状态',
};

/** Kept local so this module does not import the whole formatter for one table. */
const CONDITION_LABELS: Readonly<Record<string, string>> = {
  TVL_BELOW_MINIMUM: '池子规模不足',
  TVL_UNAVAILABLE: '池子规模读不到',
  VOLUME_7D_BELOW_MINIMUM: '成交量不足',
  VOLUME_7D_UNAVAILABLE: '成交量读不到',
  POOL_AGE_BELOW_MINIMUM: '上线时间太短',
  NAV_DEVIATION_EXCEEDED: '代币偏离净值过多',
  NAV_DEVIATION_UNAVAILABLE: '净值偏离读不到',
  SWAP_IMPACT_EXCEEDED: '大额兑换影响价格过多',
  SWAP_IMPACT_UNAVAILABLE: '价格影响读不到',
  ONCHAIN_UNVERIFIED: '链上状态未核验',
  SNAPSHOT_INCONSISTENT: '数据自相矛盾',
  CHAIN_NOT_WHITELISTED: '不在链的白名单',
  DEX_NOT_WHITELISTED: '不在交易所白名单',
  LEG_NOT_WHITELISTED: '代币不在白名单',
  STOCK_LEG_MISSING: '缺少股票代币那一脚',
  STABLECOIN_LEG_MISSING: '缺少稳定币那一脚',
};

/** A signed USD amount, so a loss reads as a loss. */
function sign(value: number): string {
  return `${value >= 0 ? '+' : '−'}${usd(Math.abs(value))}`;
}

/** A signed percentage. */
function signPct(value: number): string {
  return `${value >= 0 ? '+' : '−'}${pct(Math.abs(value))}`;
}
