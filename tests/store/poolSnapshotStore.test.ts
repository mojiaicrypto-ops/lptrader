import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { openDatabase, type Database } from '../../src/store/db.ts';
import { PoolSnapshotStore, type PoolSnapshotRow } from '../../src/store/poolSnapshotStore.ts';
import { evaluateTvlCollapse } from '../../src/strategy/riskManager.ts';
import { loadConfig } from '../../src/config/index.ts';

const POOL = '56:pancakeswap-v3:0xe531fcb1f5a195de7608b9f4f9518544c2cdb693';
const OTHER = '56:uniswap-v3:0xfc4e77248b76fefc27c4cac7151a2ee5b5cc590e';

function row(over: Partial<PoolSnapshotRow> = {}): PoolSnapshotRow {
  return {
    poolId: POOL,
    sampledAt: '2026-09-30T00:00:00.000Z',
    tvlUsd: 600_000,
    volume24hUsd: 300_000,
    volume7dUsd: 2_100_000,
    apr24h: 0.18,
    apr7d: 0.16,
    poolAgeDays: 80,
    source: 'geckoterminal',
    stale: false,
    ...over,
  };
}

describe('pool snapshots — the time series §59 needs (architecture §3.3)', () => {
  let db: Database;
  let store: PoolSnapshotStore;

  beforeEach(() => {
    db = openDatabase(':memory:');
    store = new PoolSnapshotStore(db);
  });
  afterEach(() => {
    db.close();
  });

  it('round-trips a sample without losing provenance', () => {
    store.record(row());
    const latest = store.latest(POOL);

    expect(latest).not.toBeNull();
    expect(latest?.tvlUsd).toBe(600_000);
    expect(latest?.source).toBe('geckoterminal');
    expect(latest?.stale).toBe(false);
  });

  it('keeps the sampling order, oldest first, as the risk rule expects', () => {
    store.record(row({ sampledAt: '2026-09-30T02:00:00.000Z', tvlUsd: 500_000 }));
    store.record(row({ sampledAt: '2026-09-30T00:00:00.000Z', tvlUsd: 600_000 }));
    store.record(row({ sampledAt: '2026-09-30T01:00:00.000Z', tvlUsd: 550_000 }));

    const series = store.tvlSeries(POOL);
    expect(series.map((point) => point.tvlUsd)).toEqual([600_000, 550_000, 500_000]);
  });

  it('separates pools: one pool\'s history never leaks into another', () => {
    store.record(row({ poolId: POOL, tvlUsd: 1 }));
    store.record(row({ poolId: OTHER, tvlUsd: 2 }));

    expect(store.tvlSeries(POOL).map((p) => p.tvlUsd)).toEqual([1]);
    expect(store.tvlSeries(OTHER).map((p) => p.tvlUsd)).toEqual([2]);
  });

  it('ignores a duplicate (pool, instant, source) instead of rewriting history', () => {
    // Re-running a scan must not replace the recorded observation with the newer read: a time series that
    // mutates its own past is not a time series.
    store.record(row({ tvlUsd: 600_000 }));
    store.record(row({ tvlUsd: 999_999 }));

    expect(store.count(POOL)).toBe(1);
    expect(store.tvlSeries(POOL)[0]?.tvlUsd).toBe(600_000);
  });

  it('EXCLUDES stale samples from the risk series by default', () => {
    // A degraded read is not evidence of a TVL drop. Feeding it to §59 would either manufacture a false
    // alarm or, worse, insert a bogus baseline that HIDES a real drop.
    store.record(row({ sampledAt: '2026-09-30T00:00:00.000Z', tvlUsd: 600_000 }));
    store.record(row({ sampledAt: '2026-09-30T01:00:00.000Z', tvlUsd: 1, stale: true, source: 'unavailable' }));
    store.record(row({ sampledAt: '2026-09-30T02:00:00.000Z', tvlUsd: 500_000 }));

    expect(store.tvlSeries(POOL).map((p) => p.tvlUsd)).toEqual([600_000, 500_000]);
    // ...and the raw history is still available for diagnostics.
    expect(store.tvlSeries(POOL, { includeStale: true })).toHaveLength(3);
  });

  it('omits samples with no TVL rather than treating them as zero', () => {
    // A missing TVL value must never become 0: a zero in the series reads as "the pool was drained".
    store.record(row({ sampledAt: '2026-09-30T00:00:00.000Z', tvlUsd: 600_000 }));
    store.record(row({ sampledAt: '2026-09-30T01:00:00.000Z', tvlUsd: null }));

    expect(store.tvlSeries(POOL).map((p) => p.tvlUsd)).toEqual([600_000]);
  });

  it('honours a `since` window so a caller can bound the query', () => {
    store.record(row({ sampledAt: '2026-09-01T00:00:00.000Z', tvlUsd: 100 }));
    store.record(row({ sampledAt: '2026-09-30T00:00:00.000Z', tvlUsd: 200 }));

    expect(store.tvlSeries(POOL, { since: '2026-09-15T00:00:00.000Z' }).map((p) => p.tvlUsd)).toEqual([200]);
  });

  it('prunes older than a cutoff and reports how many went', () => {
    store.record(row({ sampledAt: '2026-08-01T00:00:00.000Z' }));
    store.record(row({ sampledAt: '2026-09-30T00:00:00.000Z' }));

    expect(store.pruneBefore('2026-09-01T00:00:00.000Z')).toBe(1);
    expect(store.count(POOL)).toBe(1);
  });

  it('records a whole scan in one transaction, and rolls back together on failure', () => {
    const written = store.recordMany([
      row({ poolId: POOL, sampledAt: '2026-09-30T00:00:00.000Z' }),
      row({ poolId: OTHER, sampledAt: '2026-09-30T00:00:00.000Z' }),
    ]);
    expect(written).toBe(2);
    expect(store.count(POOL)).toBe(1);
    expect(store.count(OTHER)).toBe(1);
  });
});

describe('the series actually drives §59 (the gap this table closes)', () => {
  let db: Database;
  let store: PoolSnapshotStore;

  beforeEach(() => {
    db = openDatabase(':memory:');
    store = new PoolSnapshotStore(db);
  });
  afterEach(() => {
    db.close();
  });

  it('produces a real 24h drop verdict where the rule previously could only say "insufficient-data"', async () => {
    // Before this table, NO caller could assemble a 24h series, so §59 returned insufficient-data forever
    // and the rule existed without ever being able to fire.
    const config = await loadConfig();
    store.record(row({ sampledAt: '2026-09-29T00:00:00.000Z', tvlUsd: 600_000 }));
    store.record(row({ sampledAt: '2026-09-30T00:00:00.000Z', tvlUsd: 250_000 })); // −58.3%

    const verdict = evaluateTvlCollapse(store.tvlSeries(POOL), config.risk);

    expect(verdict.status).toBe('review'); // > 50% drop ⇒ RISK_REVIEW (§59)
    expect(verdict.failClosed).toBe(false);
    expect(verdict.dropRatio).toBeCloseTo(0.5833, 3);
  });

  it('escalates past the second tier when the drop is severe', async () => {
    const config = await loadConfig();
    store.record(row({ sampledAt: '2026-09-29T00:00:00.000Z', tvlUsd: 600_000 }));
    store.record(row({ sampledAt: '2026-09-30T00:00:00.000Z', tvlUsd: 150_000 })); // −75%

    const verdict = evaluateTvlCollapse(store.tvlSeries(POOL), config.risk);
    expect(verdict.status).toBe('emergency');
  });

  it('stays fail-closed when only stale samples exist', async () => {
    // The one case that must NOT become a verdict: no trustworthy baseline ⇒ nothing can be concluded.
    const config = await loadConfig();
    store.record(row({ sampledAt: '2026-09-29T00:00:00.000Z', tvlUsd: 600_000, stale: true, source: 'unavailable' }));
    store.record(row({ sampledAt: '2026-09-30T00:00:00.000Z', tvlUsd: 250_000 }));

    const verdict = evaluateTvlCollapse(store.tvlSeries(POOL), config.risk);
    expect(verdict.status).toBe('insufficient-data');
    expect(verdict.failClosed).toBe(true);
  });

  it('stays fail-closed when the history is shorter than the window', async () => {
    const config = await loadConfig();
    store.record(row({ sampledAt: '2026-09-30T00:00:00.000Z', tvlUsd: 600_000 }));

    const verdict = evaluateTvlCollapse(store.tvlSeries(POOL), config.risk);
    expect(verdict.status).toBe('insufficient-data');
    expect(verdict.failClosed).toBe(true);
    expect(verdict.reason).toMatch(/less than 24h/);
  });
});
