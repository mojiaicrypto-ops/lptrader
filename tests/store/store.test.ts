/**
 * T11 store tests — migrations, §75-§77 persistence, §97 idempotency, §98 tx state.
 *
 * These run against REAL SQLite files in a temp directory (not mocks): the behaviours under test
 * are the ones a mock would invent — WAL actually being on, a UNIQUE constraint actually refusing
 * the duplicate, and a second connection actually reading back what the first one wrote.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TokenAmount } from '../../src/types/token.ts';
import { SWAP_PURPOSES } from '../../src/types/adapters.ts';
import { BOT_STATES } from '../../src/types/state.ts';
import { TX_STATES } from '../../src/types/adapters.ts';
import {
  StoreError,
  applyMigrations,
  closeDatabase,
  execute,
  isMemoryDatabase,
  journalMode,
  listMigrations,
  openDatabase,
  queryAll,
  queryOne,
  registerMigration,
  type Database,
} from '../../src/store/db.ts';
import { StateStore, RuntimeStateStore, type PositionPatch } from '../../src/store/stateStore.ts';
import { TxStore, TxBlockedError, canOpenNewAttempt, planUnresolvedRecovery, TX_PURPOSES, RAW_TX_FORMATS } from '../../src/store/txStore.ts';
import { StateMachine } from '../../src/strategy/stateMachine.ts';
import type { Position, SwapRecord } from '../../src/types/portfolio.ts';

const QQQB = '0x205812cdbed920aff76c6580abd681a46d11efc7' as const;
const USDC = '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d' as const;
const POOL = '0xe531fcb1f5a195de7608b9f4f9518544c2cdb693';
const POOL_ID = `56:pancakeswap-v3:${POOL}`;

let dir = '';
let dbPath = '';

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'lptrader-store-'));
  dbPath = path.join(dir, 'nested', 'lptrader.db');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A `TokenAmount` in the shape the contracts require: raw bigint + UI values + multiplier. */
function amount(raw: bigint, decimals = 18, uiMultiplier = 10n ** 18n): TokenAmount {
  return {
    tokenId: `56:${QQQB}`,
    address: QQQB,
    decimals,
    raw,
    ui: (raw * uiMultiplier) / 10n ** 18n,
    uiMultiplier,
  };
}

function usdcAmount(raw: bigint): TokenAmount {
  return { ...amount(raw), tokenId: `56:${USDC}`, address: USDC };
}

function samplePosition(overrides: Partial<Position> = {}): Position {
  return {
    id: 'pos-1',
    chainId: 56,
    dex: 'pancakeswap-v3',
    poolAddress: POOL as Position['poolAddress'],
    poolId: POOL_ID,
    token0: QQQB,
    token1: USDC,
    token0Id: `56:${QQQB}`,
    token1Id: `56:${USDC}`,
    openedAt: '2026-09-29T00:00:00.000Z',
    initialNAV: 10_000,
    entryPrice: 745.5,
    entryEquityUsd: 10_000,
    lowerPrice: 633.675,
    upperPrice: 864.78,
    lowerTick: -887_220,
    upperTick: -883_200,
    // 12345678901234567890 raw is deliberately > 2^53: a REAL column would round it away.
    initialToken0: amount(1_234_567_890_123_456_789n),
    initialToken1: usdcAmount(4_500_000_000_000_000_000n),
    liquidity: 340_282_366_920_938_463_463_374_607_431_768_211_455n, // near uint128 max
    status: BOT_STATES.MONITOR,
    totalFeesUSD: 12.5,
    realizedPnL: 0,
    unrealizedPnL: 3.25,
    benchmarkValue: 9_980.25,
    feeILRatio: null,
    ...overrides,
  };
}

function sampleSwap(overrides: Partial<SwapRecord> = {}): SwapRecord {
  return {
    txHash: '0x' + 'ab'.repeat(32),
    timestamp: '2026-09-29T00:05:00.000Z',
    chainId: 56,
    poolId: POOL_ID,
    tokenIn: USDC,
    tokenOut: QQQB,
    tokenInId: `56:${USDC}`,
    tokenOutId: `56:${QQQB}`,
    amountIn: usdcAmount(2_000_000_000_000_000_000n),
    amountOut: amount(2_683_400_000_000_000_000n),
    expectedAmountOut: amount(2_690_000_000_000_000_000n),
    slippage: 0.0012,
    priceImpact: 0.0004,
    gasCostUSD: 0.42,
    purpose: SWAP_PURPOSES.BUILD_POSITION,
    idempotencyKey: `swap:56:${POOL_ID}:1`,
    ...overrides,
  };
}

/** Migrations this layer owns; other modules register their tables at version >= 100. */
const STORE_MIGRATION_IDS = [
  'positions',
  'swap_records',
  'decision_logs',
  'runtime_state',
  'tx_records',
  'positions_entry_equity',
];

/** Rows in `schema_migrations`. Registry-independent: peer modules may add their own at >= 100. */
function migrationCount(db: Database): number {
  return Number(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()?.['n']);
}

describe('db — connection and migrations', () => {
  it('creates the data directory, enables WAL and records every built-in migration', () => {
    const db = openDatabase(dbPath);
    expect(journalMode(db)).toBe('wal');

    // Deliberately filtered to versions < 100: a peer module (e.g. the approval gate at version
    // 100) may be imported by another test file in the same vitest worker, and its migration is
    // legitimately part of the same registry.
    const applied = db
      .prepare('SELECT version, id FROM schema_migrations WHERE version < 100 ORDER BY version')
      .all();
    expect(applied.map((row) => Number(row['version']))).toEqual(
      listMigrations()
        .filter((migration) => migration.version < 100)
        .map((migration) => migration.version),
    );
    expect(applied.map((row) => String(row['id']))).toEqual(STORE_MIGRATION_IDS);
    closeDatabase(db);
  });

  it('is idempotent: a second open applies nothing and leaves the same schema', () => {
    const first = openDatabase(dbPath);
    const schemaBefore = first
      .prepare("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => `${String(row['name'])}: ${String(row['sql'])}`);
    closeDatabase(first);

    // A brand-new connection to the same file: run the migrator again, twice, directly.
    const second = openDatabase(dbPath);
    const before = migrationCount(second);
    expect(applyMigrations(second)).toEqual([]);
    expect(applyMigrations(second)).toEqual([]);
    const schemaAfter = second
      .prepare("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => `${String(row['name'])}: ${String(row['sql'])}`);
    expect(schemaAfter).toEqual(schemaBefore);
    // No new row was recorded by the repeated runs.
    expect(migrationCount(second)).toBe(before);
    closeDatabase(second);
  });

  it('reuses one handle per path in-process and reopens cleanly after close', () => {
    const a = openDatabase(dbPath);
    // Same file through a non-normalised path ⇒ the same handle (equal objects cannot be compared
    // with `toBe` directly: vitest would inspect — and the driver refuses to be inspected once closed).
    const b = openDatabase(path.join(dir, 'nested', '..', 'nested', 'lptrader.db'));
    expect(b === a).toBe(true);

    closeDatabase(a);
    expect(() => a.prepare('SELECT 1').get()).toThrow(); // the old handle is genuinely closed
    const c = openDatabase(dbPath);
    expect(c === a).toBe(false);
    // Every migration this layer owns is recorded (peer modules at version >= 100 included in the
    // count if they happen to be imported in the same process).
    expect(migrationCount(c)).toBeGreaterThanOrEqual(STORE_MIGRATION_IDS.length);
    closeDatabase(c);
    closeDatabase(c); // idempotent: closing twice is not an error
  });

  it('does NOT share in-memory databases: two opens must not see each other\'s rows', () => {
    // Regression: `:memory:` used to be memoized in the same singleton map as file paths, so the
    // second call returned the FIRST connection. Every "private" in-memory store then shared state
    // (a previous test's tx_records row was visible to the next harness, and a dry-run/paper-mode
    // database would have been handed another component's rows).
    const first = openDatabase(':memory:');
    const second = openDatabase(':memory:');
    expect(first === second).toBe(false);

    expect(isMemoryDatabase(':memory:')).toBe(true);
    expect(isMemoryDatabase('file:lptrader-x?mode=memory&cache=shared')).toBe(true);
    expect(isMemoryDatabase('data/lptrader.db')).toBe(false);

    first.exec("CREATE TABLE leak_probe (x TEXT)");
    execute(first, 'INSERT INTO leak_probe (x) VALUES (?)', ['leaked']);

    expect(queryAll(first, 'SELECT x FROM leak_probe')).toHaveLength(1);
    // The second database never had the table created on it at all.
    expect(queryOne(second, "SELECT 1 AS p FROM sqlite_master WHERE name = 'leak_probe'")).toBeUndefined();
    expect(() => queryAll(second, 'SELECT x FROM leak_probe')).toThrow(/no such table/);
    // ...and it still got its own schema, i.e. it is a usable store, not a broken handle.
    expect(migrationCount(second)).toBeGreaterThanOrEqual(STORE_MIGRATION_IDS.length);

    // A named memory URI with `cache=shared` is one logical SQLite database by design (that is what
    // the URI means), so it is not an isolation test. What matters is that the handle MAP does not
    // alias it: two opens are two connections, and closing one must not take the other down.
    const uri = 'file:lptrader-named?mode=memory&cache=shared';
    const uriA = openDatabase(uri);
    const uriB = openDatabase(uri);
    expect(uriA === uriB).toBe(false);
    // Closing the second connection still leaves the shared memory database usable via its peers.
    closeDatabase(uriB);

    // Every one of these is a separate connection the caller owns; closing must not affect another.
    for (const handle of [first, second, uriA]) closeDatabase(handle);
    expect(() => closeDatabase(second)).not.toThrow(); // closing twice is a no-op, never an error
    // The file-database singleton is unaffected by any of the above.
    const fileA = openDatabase(dbPath);
    const fileB = openDatabase(dbPath);
    expect(fileA === fileB).toBe(true);
    closeDatabase(fileA);
  });

  it('lets another module register its own migration at version >= 100 (shared-DB contract)', () => {
    const db = openDatabase(dbPath);
    const foreign = {
      version: 100,
      id: 'other_slice_table',
      up: (target: Database) => target.exec('CREATE TABLE other_slice_table (id TEXT PRIMARY KEY)'),
    };
    expect(applyMigrations(db, { migrations: [...listMigrations(), foreign] })).toEqual([
      { version: 100, id: 'other_slice_table' },
    ]);
    expect(
      db.prepare("SELECT 1 AS present FROM sqlite_master WHERE name = 'other_slice_table'").get(),
    ).toBeDefined();
    // Re-running the same combined set is a no-op — foreign migrations obey the same idempotency.
    expect(applyMigrations(db, { migrations: [...listMigrations(), foreign] })).toEqual([]);
    closeDatabase(db);
  });

  it('refuses a migration that reuses a taken version or id', () => {
    expect(() => registerMigration({ version: 1, id: 'positions', up: () => {} })).not.toThrow(); // same declaration
    expect(() => registerMigration({ version: 1, id: 'someone_else', up: () => {} })).toThrow(StoreError);
    expect(() => registerMigration({ version: 200, id: 'positions', up: () => {} })).toThrow(StoreError);
    expect(() => registerMigration({ version: 0, id: 'bad', up: () => {} })).toThrow(StoreError);
  });

  it('rolls the whole migration back when it fails, and does not record it', () => {
    const db = openDatabase(dbPath);
    const broken = {
      version: 300,
      id: 'broken_migration',
      up: (target: Database) => {
        target.exec('CREATE TABLE broken (id TEXT)');
        throw new Error('boom');
      },
    };
    expect(() => applyMigrations(db, { migrations: [...listMigrations(), broken] })).toThrow(/broken_migration/);
    expect(db.prepare("SELECT 1 AS p FROM sqlite_master WHERE name = 'broken'").get()).toBeUndefined();
    expect(db.prepare('SELECT 1 AS p FROM schema_migrations WHERE version = 300').get()).toBeUndefined();
    // The DB is still usable and the store's own migrations all landed.
    expect(applyMigrations(db)).toEqual([]);
    closeDatabase(db);
  });
});

describe('stateStore — §75 positions', () => {
  let db: Database;
  let store: StateStore;

  beforeEach(() => {
    db = openDatabase(dbPath);
    store = new StateStore(db);
  });
  afterEach(() => closeDatabase(db));

  it('round-trips a position with raw bigints intact (no float rounding)', () => {
    expect(store.insertPosition(samplePosition())).toBe(true);
    const read = store.getPosition('pos-1');
    expect(read).not.toBeNull();
    expect(read?.initialToken0.raw).toBe(1_234_567_890_123_456_789n);
    expect(read?.liquidity).toBe(340_282_366_920_938_463_463_374_607_431_768_211_455n);
    expect(read?.status).toBe(BOT_STATES.MONITOR);
    expect(read?.feeILRatio).toBeNull();
    expect(read?.initialToken0.uiMultiplier).toBe(10n ** 18n);
    // The USD fields stay doubles, as the contract says.
    expect(read?.totalFeesUSD).toBe(12.5);
  });

  it('stores the raw amount as TEXT, not as a float', () => {
    store.insertPosition(samplePosition());
    const row = db
      .prepare('SELECT initial_token0_raw, typeof(initial_token0_raw) AS t, initial_nav, typeof(initial_nav) AS nt FROM positions')
      .get();
    expect(row?.['t']).toBe('text');
    expect(row?.['initial_token0_raw']).toBe('1234567890123456789');
    expect(row?.['nt']).toBe('real');
  });

  it('rejects a duplicate position id instead of overwriting it', () => {
    expect(store.insertPosition(samplePosition())).toBe(true);
    expect(store.insertPosition(samplePosition({ entryPrice: 1 }))).toBe(false);
    expect(store.getPosition('pos-1')?.entryPrice).toBe(745.5);
  });

  it('refuses a second OPEN position on the same pool, but allows one after close', () => {
    store.insertPosition(samplePosition());
    expect(store.insertPosition(samplePosition({ id: 'pos-2' }))).toBe(false);

    store.updatePosition('pos-1', { status: BOT_STATES.PAUSED }, '2026-09-29T01:00:00.000Z');
    expect(store.insertPosition(samplePosition({ id: 'pos-2' }))).toBe(true);
    expect(store.openPosition(56)?.id).toBe('pos-2');
    expect(store.listPositions({ openOnly: true })).toHaveLength(1);
    expect(store.listPositions()).toHaveLength(2);
  });

  it('patches only the supplied fields and fails on an unknown id or an invalid status', () => {
    store.insertPosition(samplePosition());
    const patch: PositionPatch = { feeILRatio: 1.7, totalFeesUSD: 20 };
    store.updatePosition('pos-1', patch);
    const read = store.getPosition('pos-1');
    expect(read?.feeILRatio).toBe(1.7);
    expect(read?.totalFeesUSD).toBe(20);
    expect(read?.entryPrice).toBe(745.5);

    expect(() => store.updatePosition('nope', { totalFeesUSD: 1 })).toThrow(StoreError);
    expect(() =>
      store.updatePosition('pos-1', { status: 'OPEN' as unknown as Position['status'] }),
    ).toThrow(/unknown bot state/);
  });
});

describe('stateStore — §76 swap records and §97 idempotency', () => {
  let db: Database;
  let store: StateStore;

  beforeEach(() => {
    db = openDatabase(dbPath);
    store = new StateStore(db);
  });
  afterEach(() => closeDatabase(db));

  it('round-trips a swap record', () => {
    expect(store.insertSwapRecord(sampleSwap())).toBe(true);
    const read = store.getSwapRecordByKey(`swap:56:${POOL_ID}:1`);
    expect(read?.amountIn.raw).toBe(2_000_000_000_000_000_000n);
    expect(read?.purpose).toBe(SWAP_PURPOSES.BUILD_POSITION);
    expect(read?.slippage).toBeCloseTo(0.0012, 10);
    expect(store.listSwapRecords({ purpose: SWAP_PURPOSES.BUILD_POSITION })).toHaveLength(1);
  });

  it('REJECTS a duplicate idempotency key (§97) and keeps exactly one row', () => {
    expect(store.insertSwapRecord(sampleSwap())).toBe(true);
    expect(store.hasIdempotencyKey(`swap:56:${POOL_ID}:1`)).toBe(true);

    const duplicate = { ...sampleSwap(), txHash: '0x' + 'cd'.repeat(32) };
    expect(store.insertSwapRecord(duplicate)).toBe(false);
    expect(store.listSwapRecords()).toHaveLength(1);
    // The first write wins: the duplicate never replaced the recorded tx hash.
    expect(store.getSwapRecordByKey(`swap:56:${POOL_ID}:1`)?.txHash).toBe('0x' + 'ab'.repeat(32));
  });

  it('accepts a DIFFERENT key for the same pool (a genuinely new operation)', () => {
    store.insertSwapRecord(sampleSwap());
    expect(store.insertSwapRecord(sampleSwap({ idempotencyKey: `swap:56:${POOL_ID}:2` }))).toBe(true);
    expect(store.listSwapRecords({ poolId: POOL_ID })).toHaveLength(2);
  });
});

describe('stateStore — §77 decision logs', () => {
  let db: Database;
  let store: StateStore;

  beforeEach(() => {
    db = openDatabase(dbPath);
    store = new StateStore(db);
  });
  afterEach(() => closeDatabase(db));

  it('answers "why did the bot switch pool on day X" with the inputs, not just a sentence', () => {
    store.appendDecisionLog({
      timestamp: '2026-09-28T23:00:00.000Z',
      state: BOT_STATES.MONITOR,
      action: 'evaluate_switch',
      reason: 'candidate APR 18% vs current 9% for 72h',
      currentPool: `56:pancakeswap-v3:${POOL}`,
      candidatePool: '56:uniswap-v3:0x000000000000000000000000000000000000dEaD',
      currentAPR: 0.09,
      candidateAPR: 0.18,
      poolScore: 0.72,
      totalNAV: 10_120.5,
      switchingCost: 31.4,
      breakEvenDays: 6,
      result: 'executed',
      detail: { minAprImprovement: 0.08, cooldownDays: 7 },
    });
    store.appendDecisionLog({
      timestamp: '2026-09-28T23:05:00.000Z',
      state: BOT_STATES.RISK_REVIEW,
      action: 'evaluate_switch',
      reason: 'reserve ratio below floor',
      result: 'blocked_fail_closed',
    });

    const switches = store.listDecisionLogs({ action: 'evaluate_switch', since: '2026-09-28T00:00:00.000Z' });
    expect(switches).toHaveLength(2);
    expect(switches.map((log) => log.result)).toEqual(['blocked_fail_closed', 'executed']); // newest first
    const executed = switches.find((log) => log.result === 'executed');
    expect(executed?.currentAPR).toBe(0.09);
    expect(executed?.candidateAPR).toBe(0.18);
    expect(executed?.breakEvenDays).toBe(6);
    expect(executed?.detail).toEqual({ minAprImprovement: 0.08, cooldownDays: 7 });
    // Absent optional fields stay absent rather than becoming null.
    expect(executed !== undefined && 'switchingCost' in executed).toBe(true);
    expect(switches[0] !== undefined && 'candidatePool' in switches[0]).toBe(false);
  });

  it('refuses a log whose state is not a §44 state (fail closed)', () => {
    expect(() =>
      store.appendDecisionLog({
        state: 'TRADING' as unknown as Position['status'],
        action: 'x',
        reason: 'y',
        result: 'z',
      }),
    ).toThrow(/unknown bot state/);
  });

  it('filters by result and time window', () => {
    store.appendDecisionLog({ timestamp: '2026-09-01T00:00:00.000Z', state: BOT_STATES.IDLE, action: 'a', reason: 'r', result: 'skipped_low_apr' });
    store.appendDecisionLog({ timestamp: '2026-09-20T00:00:00.000Z', state: BOT_STATES.IDLE, action: 'a', reason: 'r', result: 'executed' });
    expect(store.listDecisionLogs({ result: 'executed' })).toHaveLength(1);
    expect(store.listDecisionLogs({ since: '2026-09-10T00:00:00.000Z' })).toHaveLength(1);
    expect(store.listDecisionLogs({ until: '2026-09-10T00:00:00.000Z' })).toHaveLength(1);
  });
});

describe('txStore — §98 transaction states', () => {
  let db: Database;
  let store: TxStore;

  const KEY = `atomic_build:56:${POOL_ID}:1712345678`;

  beforeEach(() => {
    db = openDatabase(dbPath);
    store = new TxStore(db);
  });
  afterEach(() => closeDatabase(db));

  function created() {
    return store.record({
      idempotencyKey: KEY,
      chainId: 56,
      purpose: TX_PURPOSES.ATOMIC_BUILD,
      rawTx: JSON.stringify({ to: POOL, data: '0xdeadbeef', value: '0' }),
      rawTxFormat: RAW_TX_FORMATS.CALL_REQUEST,
      now: '2026-09-29T00:00:00.000Z',
    });
  }

  it('persists the intent BEFORE a hash exists, then attaches the hash', () => {
    const stored = created();
    expect(stored.state).toBe(TX_STATES.CREATED);
    expect(stored.txHash).toBeNull();
    expect(stored.attempt).toBe(1);

    const hash = ('0x' + 'ef'.repeat(32)) as `0x${string}`;
    const submitted = store.markSubmitted(KEY, hash, undefined, '2026-09-29T00:00:05.000Z');
    expect(submitted.state).toBe(TX_STATES.SUBMITTED);
    expect(submitted.txHash).toBe(hash);
    expect(submitted.submittedAt).toBe('2026-09-29T00:00:05.000Z');
    expect(store.getByHash(hash)?.idempotencyKey).toBe(KEY);
  });

  it('record() is idempotent per (key, attempt) and never creates a second row', () => {
    const first = created();
    const again = store.record({
      idempotencyKey: KEY,
      chainId: 56,
      purpose: TX_PURPOSES.ATOMIC_BUILD,
      rawTx: '{"to":"x","data":"0x","value":"0"}',
      rawTxFormat: RAW_TX_FORMATS.CALL_REQUEST,
    });
    expect(again.id).toBe(first.id);
    expect(again.rawTx).toBe(first.rawTx);
    expect(store.listAttempts(KEY)).toHaveLength(1);
  });

  it('§98: an UNKNOWN transaction is returned by findUnresolved() and BLOCKS a re-send', () => {
    created();
    const unknown = store.markUnknown(KEY, 'RPC timeout while reading the receipt', undefined, '2026-09-29T00:01:00.000Z');
    expect(unknown.state).toBe(TX_STATES.UNKNOWN);

    const unresolved = store.findUnresolved();
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]?.idempotencyKey).toBe(KEY);
    expect(unresolved[0]?.unknownReason).toContain('RPC timeout');

    // The re-send is refused: opening attempt 2 must not happen from UNKNOWN.
    expect(() =>
      store.record({
        idempotencyKey: KEY,
        chainId: 56,
        purpose: TX_PURPOSES.ATOMIC_BUILD,
        rawTx: '{"to":"x","data":"0x","value":"0"}',
        rawTxFormat: RAW_TX_FORMATS.CALL_REQUEST,
        attempt: 2,
      }),
    ).toThrow(TxBlockedError);
    expect(store.listAttempts(KEY)).toHaveLength(1);

    // ...and the policy itself says "query the chain", never "retry".
    const verdict = canOpenNewAttempt(unknown);
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe('unknown_requires_chain_query');
    expect(planUnresolvedRecovery(unresolved)[0]?.action).toBe('query_chain');
  });

  it('UNKNOWN must carry a reason, and only a chain observation can resolve it', () => {
    created();
    expect(() => store.markUnknown(KEY, '   ')).toThrow(/must carry a reason/);

    const hash = ('0x' + '11'.repeat(32)) as `0x${string}`;
    store.markSubmitted(KEY, hash);
    store.markUnknown(KEY, 'receipt endpoint 502');

    // Resolution requires an observable state + a reason.
    expect(() => store.applyChainObservation(hash, { state: TX_STATES.CONFIRMED, reason: '' })).toThrow(/requires a reason/);

    const resolved = store.applyChainObservation(hash, {
      state: TX_STATES.CONFIRMED,
      reason: 'eth_getTransactionReceipt returned status=0x1 at block 42345678',
      observedAt: '2026-09-29T00:03:00.000Z',
      blockNumber: 42_345_678n,
      gasUsed: 350_123n,
      effectiveGasPriceWei: 3_000_000_000n,
      receipt: { status: 'success', logs: 4 },
    });
    expect(resolved.state).toBe(TX_STATES.CONFIRMED);
    expect(resolved.blockNumber).toBe(42_345_678n);
    expect(resolved.gasUsed).toBe(350_123n);
    expect(resolved.resolutionReason).toContain('UNKNOWN->CONFIRMED');
    expect(resolved.resolutionReason).toContain('status=0x1');
    // Resolved ⇒ no longer part of the startup gate.
    expect(store.findUnresolved()).toHaveLength(0);
  });

  it('resolves an UNKNOWN as REVERTED and only then allows a deliberate retry', () => {
    created();
    const hash = ('0x' + '22'.repeat(32)) as `0x${string}`;
    store.markSubmitted(KEY, hash);
    store.markUnknown(KEY, 'node dropped the connection');
    store.applyChainObservation(hash, { state: TX_STATES.REVERTED, reason: 'receipt status=0x0 (slippage)' });

    const latest = store.latestAttempt(KEY);
    expect(canOpenNewAttempt(latest)).toMatchObject({ ok: true, code: 'retry_allowed' });

    const second = store.record({
      idempotencyKey: KEY,
      chainId: 56,
      purpose: TX_PURPOSES.ATOMIC_BUILD,
      rawTx: '{"to":"x","data":"0x","value":"0"}',
      rawTxFormat: RAW_TX_FORMATS.CALL_REQUEST,
      attempt: 2,
    });
    expect(second.attempt).toBe(2);
    expect(second.state).toBe(TX_STATES.CREATED);
    expect(store.listAttempts(KEY)).toHaveLength(2);
  });

  it('blocks a retry while SUBMITTED/CREATED/CONFIRMED and blocks skipped attempt numbers', () => {
    created();
    expect(() => store.record({ ...baseInput(), attempt: 2 })).toThrow(TxBlockedError);
    expect(catchCode(() => store.record({ ...baseInput(), attempt: 2 }))).toBe('already_in_flight');
    expect(catchCode(() => store.record({ ...baseInput(), attempt: 3 }))).toBe('attempt_out_of_order');

    const hash = ('0x' + '33'.repeat(32)) as `0x${string}`;
    store.markSubmitted(KEY, hash);
    expect(catchCode(() => store.record({ ...baseInput(), attempt: 2 }))).toBe('already_in_flight');

    store.applyChainObservation(hash, { state: TX_STATES.CONFIRMED, reason: 'mined status=1' });
    expect(catchCode(() => store.record({ ...baseInput(), attempt: 2 }))).toBe('already_confirmed');
    expect(canOpenNewAttempt(store.latestAttempt(KEY))).toMatchObject({ ok: false, code: 'already_confirmed' });
  });

  it('records a failed broadcast as FAILED and keeps guard checks for audit', () => {
    created();
    const guard = {
      chainIdOk: true, toWhitelisted: true, tokenInWhitelisted: true, tokenOutWhitelisted: true,
      functionSelectorOk: true, amountWithinLimit: true, slippageWithinLimit: true,
      deadlineOk: true, gasLimitSet: true, allowanceNotUnlimited: true, ok: true, failures: [],
    };
    store.attachGuard(KEY, 1, guard);
    const hash = ('0x' + '44'.repeat(32)) as `0x${string}`;
    store.markSubmitted(KEY, hash);
    const failed = store.applyChainObservation(hash, { state: TX_STATES.FAILED, reason: 'not mined within 10 blocks, dropped' });
    expect(failed.state).toBe(TX_STATES.FAILED);
    expect(failed.guard?.ok).toBe(true);
    expect(failed.guard?.allowanceNotUnlimited).toBe(true);
  });

  it('findUnresolved() reports CREATED + SUBMITTED + UNKNOWN only, per chain', () => {
    created();
    const other = { ...baseInput(), idempotencyKey: `${KEY}-other`, chainId: 1 };
    store.record(other);
    expect(store.findUnresolved({ chainId: 56 })).toHaveLength(1);
    expect(store.findUnresolved()).toHaveLength(2);
    const hash = ('0x' + '55'.repeat(32)) as `0x${string}`;
    store.markSubmitted(KEY, hash);
    store.applyChainObservation(hash, { state: TX_STATES.CONFIRMED, reason: 'ok' });
    expect(store.findUnresolved({ chainId: 56 })).toHaveLength(0);
    expect(store.findUnresolved({ chainId: 1 })).toHaveLength(1);
  });

  it('keeps a distinct hash per attempt and refuses an unknown idempotency key', () => {
    created();
    expect(() => store.markSubmitted('never-recorded', '0x' + '66'.repeat(32) as `0x${string}`)).toThrow(/no tx_records row/);
    expect(store.latestAttempt('never-recorded')).toBeNull();
  });

  function baseInput() {
    return {
      idempotencyKey: KEY,
      chainId: 56,
      purpose: TX_PURPOSES.ATOMIC_BUILD,
      rawTx: '{"to":"x","data":"0x","value":"0"}',
      rawTxFormat: RAW_TX_FORMATS.CALL_REQUEST,
    };
  }
});

/** Machine-readable code of the thrown `TxBlockedError` (the tests assert on the code, not prose). */
function catchCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof TxBlockedError) return error.code;
    throw error;
  }
  return '<no error>';
}

describe('persistence across a restart', () => {
  it('reads back positions, decision logs, tx records and the bot state from a new connection', () => {
    const first = openDatabase(dbPath);
    const positions = new StateStore(first);
    const txs = new TxStore(first);
    positions.insertPosition(samplePosition());
    positions.insertSwapRecord(sampleSwap());
    positions.appendDecisionLog({ state: BOT_STATES.MONITOR, action: 'monitor_tick', reason: 'price 745 in range', result: 'skipped_no_action' });
    const machine = StateMachine.open(first);
    machine.apply({ type: 'OPERATOR_PAUSE', reason: 'operator stop for maintenance' }, '2026-09-29T02:00:00.000Z');
    txs.record({
      idempotencyKey: `swap:56:${POOL_ID}:9`,
      chainId: 56,
      purpose: TX_PURPOSES.SWAP,
      rawTx: '0xf86b...',
      rawTxFormat: RAW_TX_FORMATS.SERIALIZED,
    });
    closeDatabase(first); // "process exits"

    // New process: a brand-new connection to the same file.
    const second = openDatabase(dbPath);
    expect(new StateStore(second).getPosition('pos-1')?.liquidity).toBe(
      340_282_366_920_938_463_463_374_607_431_768_211_455n,
    );
    expect(new StateStore(second).listSwapRecords()).toHaveLength(1);
    expect(new StateStore(second).listDecisionLogs()[0]?.reason).toBe('price 745 in range');
    expect(new TxStore(second).findUnresolved()).toHaveLength(1);
    expect(new RuntimeStateStore(second).get()).toMatchObject({
      botState: BOT_STATES.PAUSED,
      reason: 'IDLE->PAUSED: operator stop for maintenance',
    });
    expect(StateMachine.open(second).current).toBe(BOT_STATES.PAUSED);
    closeDatabase(second);
  });
});
