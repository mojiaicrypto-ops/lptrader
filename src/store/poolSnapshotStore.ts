/**
 * Pool time-series store (architecture §3.3).
 *
 * ## Why this table exists, and why it is not optional
 * Baseline §59 asks for "TVL dropped more than 50% in 24h". A **rate of change needs two points in
 * time**, and the free market-data APIs return only the *current* value — GeckoTerminal and DexPaprika
 * both report "TVL now", never "TVL 24 hours ago". So the history has to be recorded as it passes.
 *
 * Measured consequence of not having it: `evaluateTvlCollapse` (correctly written, fully tested) could
 * only ever return `insufficient-data`, because no caller could assemble a 24h series. The rule existed
 * and could not fire — which is worse than not having the rule, because it reads as covered.
 *
 * ## What is stored, and what deliberately is not
 * One row per (pool, sampling instant) with the **market facts** module 1 owns: TVL, volume, the locally
 * computed APRs, pool age, and the provenance of each figure.
 *
 * Deliberately NOT stored here: `tick`, `liquidity`, balances, anything requiring a chain call. Module 1
 * is HTTP-only (architecture §3), and a table that mixed in on-chain values would tempt a later reader
 * into thinking this layer is authoritative for them.
 *
 * ## Provenance is a column, not a footnote
 * `source` and `stale` are stored per row. A series built from a degraded source is not the same evidence
 * as one built from a healthy source, and §96 forbids treating them alike — so the distinction is kept
 * where the history is read, not reconstructed later from logs that may not exist.
 */
import { registerMigration, type Database, type SqlRow, type SqlValue } from './db.ts';
import type { DataSource } from '../types/market.ts';
import type { IsoTimestamp, PoolId } from '../types/primitives.ts';

/** Which figure a row is carrying, so a partially-degraded sample is still recorded honestly. */
export interface PoolSnapshotRow {
  readonly poolId: PoolId;
  readonly sampledAt: IsoTimestamp;
  readonly tvlUsd: number | null;
  readonly volume24hUsd: number | null;
  readonly volume7dUsd: number | null;
  /** Locally computed (§17–§18). `null` when the inputs were unavailable. */
  readonly apr24h: number | null;
  readonly apr7d: number | null;
  readonly poolAgeDays: number | null;
  readonly source: DataSource;
  /** True when the source could not be read or returned a placeholder — the sample is not evidence. */
  readonly stale: boolean;
}

/** One point in a pool's TVL history, as §59 needs it. */
export interface TvlPoint {
  readonly asOf: IsoTimestamp;
  readonly tvlUsd: number;
}

registerMigration({
  // 6 continues the store layer's 1..5 sequence (see `stateStore`/`txStore`).
  version: 6,
  id: 'pool_snapshots',
  up: (db) => {
    db.exec(`
      CREATE TABLE pool_snapshots (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        pool_id        TEXT    NOT NULL,
        sampled_at     TEXT    NOT NULL,
        tvl_usd        REAL,
        volume_24h_usd REAL,
        volume_7d_usd  REAL,
        apr_24h        REAL,
        apr_7d         REAL,
        pool_age_days  REAL,
        source         TEXT    NOT NULL,
        stale          INTEGER NOT NULL
      );
    `);
    // The read pattern is always "one pool, most recent first" and "one pool, within a window", so the
    // index is on (pool_id, sampled_at) rather than on either column alone.
    db.exec(`CREATE INDEX idx_pool_snapshots_pool_time ON pool_snapshots (pool_id, sampled_at DESC);`);
    // A retried scan must not duplicate a sample at the same instant; this also makes a replay idempotent.
    db.exec(
      `CREATE UNIQUE INDEX idx_pool_snapshots_unique ON pool_snapshots (pool_id, sampled_at, source);`,
    );
  },
});

export class PoolSnapshotStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Record one sample.
   *
   * A duplicate (same pool, instant, source) is ignored rather than overwritten: the instant already has
   * a recorded observation, and replacing it would rewrite history to match the latest read — the exact
   * thing a time series must not do.
   */
  record(row: PoolSnapshotRow): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO pool_snapshots (
           pool_id, sampled_at, tvl_usd, volume_24h_usd, volume_7d_usd,
           apr_24h, apr_7d, pool_age_days, source, stale
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.poolId,
        row.sampledAt,
        row.tvlUsd,
        row.volume24hUsd,
        row.volume7dUsd,
        row.apr24h,
        row.apr7d,
        row.poolAgeDays,
        row.source,
        row.stale ? 1 : 0,
      );
  }

  /** Record a whole scan's worth of samples in one transaction. */
  recordMany(rows: readonly PoolSnapshotRow[]): number {
    let written = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        this.record(row);
        written += 1;
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return written;
  }

  /**
   * TVL observations for one pool, oldest first — the shape `evaluateTvlCollapse` consumes.
   *
   * `stale` samples are EXCLUDED by default. A degraded read is not evidence of a TVL drop, and feeding
   * it to §59 would manufacture exactly the false alarm the rule is meant to avoid (or, worse, mask a
   * real drop by inserting a bogus baseline). Callers that want raw history for diagnostics can ask for it.
   */
  tvlSeries(poolId: PoolId, options: { readonly includeStale?: boolean; readonly since?: IsoTimestamp } = {}): readonly TvlPoint[] {
    const clauses = ['pool_id = ?'];
    const params: unknown[] = [poolId];
    if (options.includeStale !== true) {
      clauses.push('stale = 0');
    }
    if (options.since !== undefined) {
      clauses.push('sampled_at >= ?');
      params.push(options.since);
    }
    const rows = this.db
      .prepare(
        `SELECT sampled_at, tvl_usd FROM pool_snapshots
         WHERE ${clauses.join(' AND ')} AND tvl_usd IS NOT NULL
         ORDER BY sampled_at ASC`,
      )
      .all(...(params as readonly SqlValue[])) as readonly SqlRow[];
    return rows.map((row) => ({ asOf: String(row['sampled_at']), tvlUsd: Number(row['tvl_usd']) }));
  }

  /** The most recent sample for a pool, or `null`. Used by reports and by the screener's cross-check. */
  latest(poolId: PoolId): PoolSnapshotRow | null {
    const row = this.db
      .prepare('SELECT * FROM pool_snapshots WHERE pool_id = ? ORDER BY sampled_at DESC LIMIT 1')
      .get(poolId) as Record<string, unknown> | undefined;
    return row === undefined ? null : mapRow(row);
  }

  /**
   * Delete samples older than the retention window (§3.3: keep at least 30 days).
   *
   * Bounded on purpose: an unbounded append-only table is a slow-motion outage, and the longest window any
   * §59/§90 calculation needs is 30 days.
   */
  pruneBefore(cutoff: IsoTimestamp): number {
    const before = this.db
      .prepare('SELECT COUNT(*) AS n FROM pool_snapshots WHERE sampled_at < ?')
      .get(cutoff) as { n: number };
    this.db.prepare('DELETE FROM pool_snapshots WHERE sampled_at < ?').run(cutoff);
    return before.n;
  }

  /** Number of samples for a pool — used by tests and by the "is there enough history?" checks. */
  count(poolId: PoolId): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM pool_snapshots WHERE pool_id = ?')
      .get(poolId) as { n: number };
    return row.n;
  }
}

function mapRow(row: Record<string, unknown>): PoolSnapshotRow {
  const num = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  return {
    poolId: String(row['pool_id']),
    sampledAt: String(row['sampled_at']),
    tvlUsd: num(row['tvl_usd']),
    volume24hUsd: num(row['volume_24h_usd']),
    volume7dUsd: num(row['volume_7d_usd']),
    apr24h: num(row['apr_24h']),
    apr7d: num(row['apr_7d']),
    poolAgeDays: num(row['pool_age_days']),
    source: String(row['source']) as DataSource,
    stale: row['stale'] === 1,
  };
}
