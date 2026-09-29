/**
 * §74 Persistence — SQLite connection, migration registry and raw statement helpers.
 *
 * DRIVER: the Node **built-in** `node:sqlite` (`DatabaseSync`) is used instead of
 * `better-sqlite3`. Reasons, in order:
 *   1. No new dependency. `better-sqlite3` is a native addon (node-gyp/prebuilds), i.e. a
 *      supply-chain surface and a build-toolchain requirement for a program whose whole job is
 *      to be auditable; the engine floor (`node >= 22.6`) already ships SQLite.
 *   2. The engine only needs synchronous, single-process, single-writer access — precisely the
 *      subset `node:sqlite` implements. Nothing here needs user-defined collations, async
 *      streaming or extension loading.
 *   3. The API actually used is limited to what exists since v22.5 (`DatabaseSync`, `exec`,
 *      `prepare`, `StatementSync.run/get/all/iterate`, `setReadBigInts`). `PRAGMA` statements
 *      are used for `journal_mode`/`busy_timeout`/`foreign_keys` instead of the newer
 *      `DatabaseSyncOptions` fields (`timeout` is v24.0, `enableForeignKeyConstraints` is
 *      v22.10) so the declared floor is genuinely satisfied.
 * Caveat: `node:sqlite` is marked experimental and prints one `ExperimentalWarning` on first use.
 * It is the only runtime dependency of this layer; the store's own tests assert the behaviour
 * (WAL, constraints, idempotency), so a future swap to `better-sqlite3` is a driver change inside
 * this file, not a schema change.
 *
 * ---------------------------------------------------------------------------------------------
 * SHARED DATABASE / MIGRATION CONTRACT (read before adding a table).
 *
 * - The file is `data/lptrader.db` (repo root, gitignored). WAL is on, so the main file plus
 *   `-wal`/`-shm` sidecars are the durable state.
 * - `schema_migrations` is append-only and ordered by `version`. Migrations are **idempotent**
 *   (guarded by that table) and **additive** (never `DROP`/rewrite a table this module does not
 *   own).
 * - Version ranges: **1..99 = the store layer** (`src/store/db.ts`). Every other module MUST use
 *   `version >= 100` for its own tables — e.g. the Telegram approval gate registers
 *   `{ version: 100, id: 'approval_requests' }`. Registering a version that is already taken
 *   throws, so two slices can never silently collide.
 * - Registration happens at module load:
 *
 *       registerMigration({ version: 100, id: 'approval_requests', up: (db) => { db.exec(`...) } });
 *
 *   then the owner just calls `openDatabase()` (or `applyMigrations(db)` on a handle it already
 *   has; both are safe to call repeatedly).
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Database = DatabaseSync;

/** A single bound parameter. `bigint` is only used for integer columns, never for money. */
export type SqlValue = null | number | bigint | string | Uint8Array;

/** One row as returned by the driver. Values are never `undefined` inside a returned row. */
export type SqlRow = Record<string, null | number | bigint | string | Uint8Array>;

/** An ordered, idempotent schema step. `up` must be safe to re-run conceptually (it is guarded). */
export interface Migration {
  /** Globally unique ordering key. 1..99 = store layer, >= 100 = other modules. */
  readonly version: number;
  /** Stable name recorded in `schema_migrations.id` (UNIQUE) so a version cannot be reused. */
  readonly id: string;
  readonly up: (db: Database) => void;
}

export interface AppliedMigration {
  readonly version: number;
  readonly id: string;
}

/** Default DB location. `data/` is gitignored; relative paths resolve against the process cwd. */
export const DEFAULT_DB_PATH = 'data/lptrader.db';

const migrations: Migration[] = [];
let migrationsSorted = false;

/**
 * Register a migration. Call once at module scope of the owning slice.
 *
 * Idempotent for the same `{version, id}` pair and throws on a genuine conflict (a different
 * migration already owns that version, or that id is already used by another version). Failing
 * loudly is deliberate: a silent overwrite would leave the database on a schema nobody declared.
 */
export function registerMigration(migration: Migration): void {
  if (!Number.isInteger(migration.version) || migration.version < 1) {
    throw new StoreError(`migration version must be a positive integer: ${String(migration.version)}`);
  }
  if (migration.id.trim().length === 0) {
    throw new StoreError(`migration ${migration.version} has an empty id`);
  }
  const sameVersion = migrations.find((entry) => entry.version === migration.version);
  if (sameVersion !== undefined) {
    if (sameVersion.id === migration.id) return; // same declaration registered twice — fine
    throw new StoreError(
      `migration version ${migration.version} is already owned by '${sameVersion.id}' ` +
        `(attempted '${migration.id}'). Modules outside src/store must use version >= 100.`,
    );
  }
  const sameId = migrations.find((entry) => entry.id === migration.id);
  if (sameId !== undefined) {
    throw new StoreError(
      `migration id '${migration.id}' is already registered at version ${sameId.version}`,
    );
  }
  migrations.push(migration);
  migrationsSorted = false;
}

/** Registered migrations, ascending by version. Exposed for tests and diagnostics. */
export function listMigrations(): readonly Migration[] {
  if (!migrationsSorted) {
    migrations.sort((a, b) => a.version - b.version);
    migrationsSorted = true;
  }
  return migrations;
}

/** Error type for every failure this layer raises deliberately. */
export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreError';
  }
}

/**
 * `true` when the error is a SQLite constraint violation (UNIQUE / CHECK / FOREIGN KEY).
 *
 * Both checks are needed: `code` is present on the driver error, `errcode`/`errstr` on the
 * wrapped native error. Callers use this to turn "duplicate idempotency key" into a refusal
 * instead of an unhandled crash.
 */
export function isConstraintViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; errcode?: unknown; message?: unknown };
  if (candidate.code === 'ERR_SQLITE_ERROR') {
    if (typeof candidate.errcode === 'number') return (candidate.errcode & 0xff) === 19; // SQLITE_CONSTRAINT
    if (typeof candidate.message === 'string' && candidate.message.includes('constraint failed')) {
      return true;
    }
  }
  return false;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A conservative identifier check for anything interpolated into DDL (table/column names). */
export function assertIdentifier(name: string, what: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new StoreError(`${what} is not a plain lowercase identifier: ${JSON.stringify(name)}`);
  }
  return name;
}

/**
 * Create (or reuse) the table that records applied migrations.
 *
 * Kept identical in shape to what `applyMigrations` expects, and created with
 * `IF NOT EXISTS` so it can never be the reason two handles disagree.
 */
function ensureMigrationTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      id         TEXT    NOT NULL UNIQUE,
      applied_at TEXT    NOT NULL
    );
  `);
}

/** Options for `applyMigrations`; the defaults are what production uses. */
export interface ApplyMigrationsOptions {
  /** Timestamp source for `schema_migrations.applied_at` (injectable for tests/replay). */
  readonly now?: () => string;
  /** Override the registry. Only tests/migration tooling pass this. */
  readonly migrations?: readonly Migration[];
}

/**
 * Apply every registered migration whose version is not yet recorded.
 *
 * Each migration runs inside its own `BEGIN IMMEDIATE` transaction together with the row that
 * records it, so a crash mid-migration leaves neither the schema nor the bookkeeping half done.
 * Re-running is a no-op (this is the idempotency the acceptance test asserts by running twice).
 */
export function applyMigrations(db: Database, options: ApplyMigrationsOptions = {}): readonly AppliedMigration[] {
  const now = options.now ?? (() => new Date().toISOString());
  const pending = [...(options.migrations ?? listMigrations())].sort((a, b) => a.version - b.version);
  ensureMigrationTable(db);
  const recorded = new Set<number>();
  for (const row of db.prepare('SELECT version FROM schema_migrations').all()) {
    recorded.add(Number(row['version']));
  }

  const applied: AppliedMigration[] = [];
  for (const migration of pending) {
    if (recorded.has(migration.version)) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations (version, id, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.id,
        now(),
      );
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // The transaction may already be gone (e.g. the driver aborted it); the original error wins.
      }
      throw new StoreError(
        `migration ${migration.version} ('${migration.id}') failed: ${errorMessage(error)}`,
      );
    }
    applied.push({ version: migration.version, id: migration.id });
  }
  return applied;
}

const openHandles = new Map<string, Database>();

/**
 * Open (or reuse) the shared database handle and bring the schema up to date.
 *
 * - `data/` is created if missing (recursively).
 * - `journal_mode=WAL` is set before anything else; `busy_timeout` (5s) and `foreign_keys=ON`
 *   are applied per connection, since both are connection-scoped.
 * - Reusing the handle inside one process matters for a FILE database: two handles to the same WAL
 *   file would both pretend to be the writer. Callers outside this process still work (SQLite
 *   handles the file lock) but the in-process singleton is the intended path.
 * - An IN-MEMORY database has no identity, so it is never memoized: every call returns a brand-new
 *   connection the caller owns, and two in-memory opens can never see each other's rows. Memoizing
 *   them (the previous behaviour) silently shared state between callers that each believed they had
 *   a private database — a dry-run/paper-mode harness was handed another component's rows.
 */
export function openDatabase(dbPath: string = DEFAULT_DB_PATH, options: { readonly migrations?: boolean } = {}): Database {
  // A SQLite URI (`:memory:` / `file:...`) is not a filename: resolving it would create a file
  // literally named ':memory:' in the cwd, and keying the singleton map on it would alias every
  // in-memory database in the process onto one connection.
  const inMemory = isMemoryDatabase(dbPath);
  const resolved = inMemory ? null : path.resolve(dbPath);
  if (resolved !== null) {
    const existing = openHandles.get(resolved);
    if (existing !== undefined) {
      if (options.migrations !== false) applyMigrations(existing);
      return existing;
    }
    mkdirSync(path.dirname(resolved), { recursive: true });
  }
  const db = new DatabaseSync(inMemory ? dbPath : (resolved as string));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  if (resolved !== null) openHandles.set(resolved, db);
  if (options.migrations !== false) applyMigrations(db);
  return db;
}

/**
 * True for a throwaway in-memory database (plain `:memory:`, or a `file:` URI with `mode=memory`).
 * Those are never shared between calls, so they are excluded from the handle map entirely.
 */
export function isMemoryDatabase(dbPath: string): boolean {
  if (dbPath === ':memory:') return true;
  if (!dbPath.startsWith('file:')) return false;
  return /[?&]mode=memory(&|$)/.test(dbPath);
}

/**
 * Close a handle opened by `openDatabase` and forget it, so the next call reopens cleanly.
 * Used by tests that assert persistence across a restart.
 *
 * Idempotent and never throws: a memoized handle is removed from the map and closed; an in-memory
 * handle is invisible to the map, so a second call is a no-op *and is not detectable* — hence the
 * "never throws" guarantee rather than a double-close error. `DatabaseSync.isOpen` is deliberately
 * not used to decide this: it only exists since v22.15, above the declared engine floor.
 */
export function closeDatabase(db: Database): void {
  let known = false;
  for (const [key, handle] of openHandles) {
    if (handle === db) {
      openHandles.delete(key);
      known = true;
    }
  }
  if (!known) return;
  try {
    db.close();
  } catch {
    // Already closed outside this module; the map entry is gone, which is what matters.
  }
}

/** True when the database file uses WAL (asserted by the store tests). */
export function journalMode(db: Database): string {
  const row = db.prepare('PRAGMA journal_mode').get();
  return String(row?.['journal_mode'] ?? '');
}

// ---------------------------------------------------------------------------------------------
// Raw statement helpers.
//
// `node:sqlite` binds anonymous parameters only; every helper below therefore takes positional
// values and runs the statement in `all` mode (which handles plain reads and
// `RETURNING`/`PRAGMA` writes alike).
// ---------------------------------------------------------------------------------------------

export function queryAll(db: Database, sql: string, params: readonly SqlValue[] = []): readonly SqlRow[] {
  return db.prepare(sql).all(...params) as readonly SqlRow[];
}

export function queryOne(db: Database, sql: string, params: readonly SqlValue[] = []): SqlRow | undefined {
  return db.prepare(sql).get(...params) as SqlRow | undefined;
}

/** Execute a statement that returns no rows (INSERT/UPDATE/DELETE/DDL). */
export function execute(db: Database, sql: string, params: readonly SqlValue[] = []): void {
  db.prepare(sql).run(...params);
}

/**
 * Execute an INSERT/UPDATE and return the number of affected rows.
 *
 * `changes` is what makes "duplicate idempotency key" observable: an
 * `INSERT ... ON CONFLICT DO NOTHING` that changed nothing returns 0.
 */
export function executeChanges(db: Database, sql: string, params: readonly SqlValue[] = []): number {
  return Number(db.prepare(sql).run(...params).changes);
}

// ---------------------------------------------------------------------------------------------
// Value/row codecs. Money columns are TEXT (exact decimal, no float loss on the value that was
// signed) and USD/ratio columns are REAL; the helpers make that asymmetry explicit at each site.
// ---------------------------------------------------------------------------------------------

export function bigintToText(value: bigint): string {
  return value.toString(10);
}

export function requiredBigint(row: SqlRow, column: string): bigint {
  const value = row[column];
  if (typeof value !== 'string') {
    throw new StoreError(`column '${column}' is not TEXT (raw bigint): ${String(value)}`);
  }
  return BigInt(value);
}

export function optionalBigint(row: SqlRow, column: string): bigint | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  return requiredBigint(row, column);
}

export function requiredString(row: SqlRow, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') {
    throw new StoreError(`column '${column}' is not TEXT: ${String(value)}`);
  }
  return value;
}

export function optionalString(row: SqlRow, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new StoreError(`column '${column}' is not TEXT: ${String(value)}`);
  }
  return value;
}

export function requiredNumber(row: SqlRow, column: string): number {
  const value = row[column];
  if (typeof value !== 'number') {
    throw new StoreError(`column '${column}' is not REAL/INTEGER: ${String(value)}`);
  }
  return value;
}

export function optionalNumber(row: SqlRow, column: string): number | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  return requiredNumber(row, column);
}

export function optionalInteger(row: SqlRow, column: string): number | null {
  const value = optionalNumber(row, column);
  return value === null ? null : Math.trunc(value);
}

export function requiredInteger(row: SqlRow, column: string): number {
  const value = requiredNumber(row, column);
  if (!Number.isInteger(value)) {
    throw new StoreError(`column '${column}' is not an integer: ${String(value)}`);
  }
  return value;
}
