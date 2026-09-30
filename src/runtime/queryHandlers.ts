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
 * and, for NAV, as a catastrophic one. This is the same fail-closed discipline the rest of the system
 * uses, applied to the operator's view.
 */
import type { QueryHandlers } from '../notify/telegram.ts';
import type { QueryCache, PoolView } from './queryCache.ts';

/** Human-readable age, so freshness is legible rather than a timestamp to compute in one's head. */
function ageLabel(at: string, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - Date.parse(at)) / 1000));
  if (seconds < 90) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

function usd(value: number): string {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

/**
 * How many pools to list.
 *
 * `/pools` is read on a phone. Every candidate with the full reason text is unreadable at ten pools, which
 * is the observed size — so the admitted ones are always shown in full and the rejected ones are counted,
 * with their reasons available on request via `/pools all`.
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
    `${what}: not measured yet.\n\nThe first ${firstBeat} has not completed. A full scan takes ~4 minutes ` +
    'on a cold start (the data source rate-limits), so this is expected right after startup.';

  return {
    status: () => {
      const observed = cache.status;
      if (observed === null) return notMeasured('Status', 'startup check');
      const s = observed.value;
      const position = cache.position;
      const lines = [
        `state          : ${s.state}`,
        `mode           : ${s.readOnly ? 'READ-ONLY (no signer — cannot build or exit)' : 'LIVE'}`,
        `dry-run        : ${s.dryRun ? 'yes (transactions are refused before broadcast)' : 'NO — transactions will be signed'}`,
        `telegram       : ${s.telegramEnabled ? 'enabled' : 'DISABLED — no build or switch can be approved'}`,
        `approvals      : ${s.approvals}`,
        `cadences       : ${s.cadences.map((c) => `${c.name}=${c.intervalMinutes}m`).join(' ')}`,
      ];
      if (position === null) {
        lines.push(
          cache.positionObservedAt === null
            ? 'position       : not read yet'
            : 'position       : none (flat)',
        );
      } else {
        lines.push(`position       : ${position.value.poolId} (tokenId ${position.value.positionTokenId})`);
      }
      lines.push('', `observed ${ageLabel(observed.at, nowMs())}`);
      return lines.join('\n');
    },

    position: () => {
      if (cache.positionObservedAt === null) {
        return notMeasured('Position', 'portfolio beat');
      }
      const observed = cache.position;
      if (observed === null) {
        return (
          'No open position — the bot is flat.\n\n' +
          'This is a real reading, not missing data: the last portfolio beat looked and found none.\n' +
          'Send /start to build one.'
        );
      }
      const p = observed.value;
      const lines = [
        `pool           : ${p.poolId}`,
        `dex            : ${p.dex}`,
        `tokenId        : ${p.positionTokenId}`,
        `liquidity (raw): ${p.liquidityRaw}`,
        `range progress : ${pct(p.rangeProgress)}  (§49: 0% at the lower bound, 100% at the upper)`,
        `unclaimed fees : ${usd(p.unclaimedFeesUsd)}`,
        `opened at      : ${p.openedAt}`,
        '',
        `observed ${ageLabel(observed.at, nowMs())}`,
      ];
      return lines.join('\n');
    },

    pools: (args) => {
      const observed = cache.pools;
      if (observed === null) return notMeasured('Pools', 'scan beat');

      const showAll = args.trim().toLowerCase() === 'all';
      const pools = observed.value;
      const admitted = pools.filter((p) => p.admitted);
      const indeterminate = pools.filter((p) => !p.admitted && p.indeterminate);
      const rejected = pools.filter((p) => !p.admitted && !p.indeterminate);

      const lines = [
        `${pools.length} candidate pool(s) from the last scan.`,
        `  admitted            : ${admitted.length}`,
        `  rejected on merits  : ${rejected.length}`,
        `  NOT JUDGED (no data): ${indeterminate.length}`,
      ];

      if (admitted.length > 0) {
        lines.push('', `ADMITTED (${admitted.length} passed the HTTP-measurable §16 gates):`);
        for (const pool of admitted.slice(0, POOL_LIST_LIMIT)) {
          lines.push(`  ${describePool(pool)}`);
        }
        if (admitted.length > POOL_LIST_LIMIT) {
          lines.push(`  … and ${admitted.length - POOL_LIST_LIMIT} more`);
        }
        lines.push(
          '',
          'These have NOT been verified on chain. Module 2 reads tick/liquidity/fee and judges §16',
          'impact and §34 tick alignment immediately before a build, and only the first pool that',
          'passes is used.',
        );
      } else {
        lines.push('', 'No pool is currently admitted. Send /pools all to see why each was refused.');
      }

      if (indeterminate.length > 0) {
        // Separated deliberately: these are a DATA problem, and calling them "rejected" would send the
        // operator looking for a pool problem that does not exist.
        lines.push(
          '',
          `${indeterminate.length} pool(s) could not be judged because a figure was unreadable:`,
        );
        for (const pool of indeterminate.slice(0, POOL_LIST_LIMIT)) {
          lines.push(`  ${pool.poolId}: ${pool.reasons[0] ?? 'unavailable'}`);
        }
      }

      if (showAll && rejected.length > 0) {
        lines.push('', 'REJECTED:');
        for (const pool of rejected) {
          lines.push(`  ${describePool(pool)}`);
          for (const reason of pool.reasons.slice(0, 3)) lines.push(`      ${reason}`);
        }
      } else if (rejected.length > 0) {
        lines.push('', `(${rejected.length} rejected on their merits — send /pools all to list them)`);
      }

      lines.push('', `observed ${ageLabel(observed.at, nowMs())}`);
      return lines.join('\n');
    },

    nav: () => {
      const observed = cache.nav;
      if (observed === null) return notMeasured('NAV', 'portfolio beat');
      const n = observed.value;
      const lines = [
        `total NAV      : ${usd(n.totalNavUsd)}`,
        `  wallet       : ${usd(n.walletUsd)}`,
        `  stablecoins  : ${usd(n.stablecoinUsd)}`,
        `  LP position  : ${usd(n.lpValueUsd)}`,
        `  unclaimed    : ${usd(n.unclaimedFeesUsd)}`,
        '',
        `reserve ratio  : ${pct(n.reserveRatio)}  (§60 floor)`,
        `LP ratio       : ${pct(n.lpRatio)}  (§3 ceiling)`,
        `drawdown       : ${pct(n.drawdown)}  (§66 line)`,
        '',
        'NAV = wallet + LP value + unclaimed fees. Realized fees are NOT added — they are already in the',
        'wallet, and adding them again would raise NAV and silently disable the §66 drawdown check.',
      ];

      const r = n.returns;
      if (r !== undefined) {
        lines.push('', '--- return on the money committed ---');
        if (r.returnRatio === null) {
          lines.push('  total return   : unknown — no entry equity was recorded for this position');
        } else {
          lines.push(
            `  total return   : ${r.returnUsd !== null && r.returnUsd >= 0 ? '+' : ''}${usd(r.returnUsd ?? 0)} ` +
              `(${r.returnRatio >= 0 ? '+' : ''}${pct(r.returnRatio)})`,
          );
        }
        if (r.marketContributionUsd !== null) {
          lines.push(`  of which market: ${r.marketContributionUsd >= 0 ? '+' : ''}${usd(r.marketContributionUsd)}`);
        }
        if (r.poolContributionUsd !== null) {
          const label = r.poolContributionUsd >= 0 ? 'earned' : 'cost us';
          lines.push(
            `  pool structure : ${r.poolContributionUsd >= 0 ? '+' : ''}${usd(r.poolContributionUsd)} (${label})`,
          );
        }
        if (r.incompleteReasons.length > 0) {
          lines.push('', '  The split between market move and pool cost is incomplete:');
          for (const reason of r.incompleteReasons) lines.push(`    ${reason}`);
        }
        lines.push(
          '',
          '  "market" is what the entry composition would have moved by if the stock had simply been held;',
          '  "pool structure" is what the position did beyond that. A negative pool structure means the',
          '  pool earned less than it cost — that is the number worth acting on, not the total alone.',
        );
      }

      lines.push('', `observed ${ageLabel(observed.at, nowMs())}`);
      return lines.join('\n');
    },

    risk: () => {
      const observed = cache.risk;
      if (observed === null) return notMeasured('Risk', 'portfolio or pool-health beat');
      const r = observed.value;
      const lines = [`action         : ${r.action}`, `severity       : ${r.severity}`];
      if (r.navUsd !== undefined) lines.push(`NAV at verdict : ${usd(r.navUsd)}`);
      if (r.valuationProblems !== undefined && r.valuationProblems.length > 0) {
        // No verdict was produced. Saying so is the point: an incomplete valuation must not read as "safe".
        lines.push('', 'NO VERDICT — the valuation was incomplete:');
        for (const problem of r.valuationProblems.slice(0, 5)) lines.push(`  ${problem}`);
      }
      if (r.reasons.length > 0) {
        lines.push('', 'Reasons (most severe first):');
        for (const reason of r.reasons.slice(0, 8)) lines.push(`  ${reason}`);
      }
      lines.push('', `observed ${ageLabel(observed.at, nowMs())}`);
      return lines.join('\n');
    },
  };
}

function describePool(pool: PoolView): string {
  const apr = pool.estimatedApr7d === null ? 'APR unavailable' : `APR7d ${pct(pool.estimatedApr7d)}`;
  return (
    `${pool.poolId}\n` +
    `      TVL ${usd(pool.tvlUsd)} · 7d vol ${usd(pool.avgDailyVolume7dUsd)}/day · ` +
    `age ${pool.poolAgeDays}d · ${apr}`
  );
}
