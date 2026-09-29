/**
 * §75-§77 persistence — `positions`, `swap_records`, `decision_logs`, plus §97 idempotency keys.
 *
 * UNIT RULES (identical to the frozen contracts, restated because a wrong column type here is a
 * silent money bug):
 * - Every token amount is an exact decimal **TEXT** column holding the RAW base-unit bigint
 *   (`TokenAmount.raw`) plus its `_ui`/`_ui_multiplier`/`_decimals` companions. TEXT, not INTEGER
 *   and never REAL: an 18-decimal balance exceeds `Number.MAX_SAFE_INTEGER`, and a float column
 *   would round the exact amount that was signed. Money is read back with `BigInt(text)`.
 * - `usd`/`apr`/`ratio`/`score` values are **REAL** — they are display/threshold doubles by
 *   contract (`UsdAmount`, `Ratio`) and are never converted back into a signed amount.
 * - `liquidity`/`lower_tick`/`upper_tick` are the CLMM integers (INTEGER is exact for a uint128
 *   `L`? No — `L` is stored as TEXT too, because uint128 exceeds a 64-bit SQLite INTEGER).
 *
 * IDEMPOTENCY (§97): every executing action carries an `idempotencyKey`
 * (`kind:chainId:poolId:nonce`, built by the executor). `insertSwapRecord` REJECTS a key that is
 * already recorded (returns `false`) instead of appending a second row, so a restart or an RPC
 * timeout can never be mistaken for a fresh operation.
 *
 * The store owns versions 1..4 of the shared migration registry (see `db.ts`). Other modules
 * register their own tables at version >= 100 and are never touched from here.
 */
import type { Position, SwapRecord, DecisionLog } from '../types/portfolio.ts';
import type { TokenAmount } from '../types/token.ts';
import type { SwapPurpose } from '../types/adapters.ts';
import { BOT_STATES, type BotState } from '../types/state.ts';
import type { Address, IsoTimestamp, PoolId, Ratio, Tick, TokenId, UsdAmount } from '../types/primitives.ts';
import {
  applyMigrations,
  assertIdentifier,
  bigintToText,
  errorMessage,
  execute,
  executeChanges,
  isConstraintViolation,
  optionalInteger,
  optionalNumber,
  optionalString,
  queryAll,
  queryOne,
  registerMigration,
  requiredBigint,
  requiredInteger,
  requiredNumber,
  requiredString,
  type Database,
  type SqlRow,
  type SqlValue,
  StoreError,
} from './db.ts';

/** `TokenAmount` columns are stored under a per-field prefix: `<prefix>_raw`, `<prefix>_ui`, … */
type AmountPrefix = string;

function amountColumns(prefix: AmountPrefix): readonly string[] {
  const p = assertIdentifier(prefix, 'amount prefix');
  return [`${p}_raw`, `${p}_ui`, `${p}_ui_multiplier`, `${p}_decimals`];
}

/** Rebuild a `TokenAmount` from its four columns; identity comes from the owning record. */
function readTokenAmount(
  row: SqlRow,
  prefix: AmountPrefix,
  tokenId: TokenId,
  address: Address,
): TokenAmount {
  const p = assertIdentifier(prefix, 'amount prefix');
  return {
    tokenId,
    address,
    decimals: requiredNumber(row, `${p}_decimals`),
    raw: requiredBigint(row, `${p}_raw`),
    ui: requiredBigint(row, `${p}_ui`),
    uiMultiplier: requiredBigint(row, `${p}_ui_multiplier`),
  };
}

function amountValues(prefix: AmountPrefix, amount: TokenAmount): readonly SqlValue[] {
  assertIdentifier(prefix, 'amount prefix');
  return [
    bigintToText(amount.raw),
    bigintToText(amount.ui),
    bigintToText(amount.uiMultiplier),
    amount.decimals,
  ];
}

function amountColumnList(prefix: AmountPrefix): string {
  return amountColumns(prefix).join(', ');
}

/** Queue the four `<prefix>_*` assignments of a `TokenAmount` into an UPDATE patch. */
function putAmountColumns(
  put: (column: string, value: SqlValue) => void,
  prefix: AmountPrefix,
  amount: TokenAmount,
): void {
  const columns = amountColumns(prefix);
  const values = amountValues(prefix, amount);
  for (const [index, column] of columns.entries()) {
    put(column, values[index] ?? null);
  }
}

function amountPlaceholders(prefix: AmountPrefix): string {
  return amountColumns(prefix)
    .map(() => '?')
    .join(', ');
}

/** Fail closed on a status value that is not a §44 state (a hand-edited DB must not be trusted). */
function toBotState(value: string, where: string): BotState {
  if (!Object.values(BOT_STATES).includes(value as BotState)) {
    throw new StoreError(`unknown bot state ${JSON.stringify(value)} in ${where} (§96 fail closed)`);
  }
  return value as BotState;
}

// ---------------------------------------------------------------------------------------------
// Migrations (versions 1..4 — the store layer's reserved range).
// ---------------------------------------------------------------------------------------------

registerMigration({
  version: 1,
  id: 'positions',
  up: (db) => {
    db.exec(`
      CREATE TABLE positions (
        id              TEXT PRIMARY KEY,
        chain_id        INTEGER NOT NULL,
        dex             TEXT    NOT NULL,
        pool_address    TEXT    NOT NULL,
        pool_id         TEXT    NOT NULL,
        token0          TEXT    NOT NULL,
        token1          TEXT    NOT NULL,
        token0_id       TEXT    NOT NULL,
        token1_id       TEXT    NOT NULL,
        opened_at       TEXT    NOT NULL,
        closed_at       TEXT,
        initial_nav     REAL    NOT NULL,
        entry_price     REAL    NOT NULL,
        lower_price     REAL    NOT NULL,
        upper_price     REAL    NOT NULL,
        lower_tick      INTEGER NOT NULL,
        upper_tick      INTEGER NOT NULL,
        ${amountColumnList('initial_token0')},
        ${amountColumnList('initial_token1')},
        liquidity       TEXT    NOT NULL,
        status          TEXT    NOT NULL,
        total_fees_usd  REAL    NOT NULL,
        realized_pnl    REAL    NOT NULL,
        unrealized_pnl  REAL    NOT NULL,
        benchmark_value REAL    NOT NULL,
        fee_il_ratio    REAL,
        min_holding_until TEXT,
        cooldown_until    TEXT,
        emergency_reason  TEXT
      );
    `);
    db.exec('CREATE INDEX idx_positions_status ON positions (status, opened_at DESC)');
    db.exec('CREATE UNIQUE INDEX idx_positions_open ON positions (chain_id, pool_address) WHERE closed_at IS NULL');
  },
});

registerMigration({
  version: 2,
  id: 'swap_records',
  up: (db) => {
    db.exec(`
      CREATE TABLE swap_records (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        tx_hash            TEXT    NOT NULL,
        timestamp          TEXT    NOT NULL,
        chain_id           INTEGER NOT NULL,
        pool_id            TEXT,
        token_in           TEXT    NOT NULL,
        token_out          TEXT    NOT NULL,
        token_in_id        TEXT    NOT NULL,
        token_out_id       TEXT    NOT NULL,
        ${amountColumnList('amount_in')},
        ${amountColumnList('amount_out')},
        ${amountColumnList('expected_amount_out')},
        slippage           REAL    NOT NULL,
        price_impact       REAL    NOT NULL,
        gas_cost_usd       REAL    NOT NULL,
        purpose            TEXT    NOT NULL,
        idempotency_key    TEXT    NOT NULL UNIQUE
      );
    `);
    db.exec('CREATE INDEX idx_swap_records_time ON swap_records (timestamp DESC)');
    db.exec('CREATE INDEX idx_swap_records_pool ON swap_records (pool_id, timestamp DESC)');
  },
});

registerMigration({
  version: 3,
  id: 'decision_logs',
  up: (db) => {
    // §77: must answer "why did the bot switch pool on day X", so the reason plus the inputs that
    // produced it are both stored — the numbers, not a rendered sentence.
    db.exec(`
      CREATE TABLE decision_logs (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp       TEXT    NOT NULL,
        state           TEXT    NOT NULL,
        action          TEXT    NOT NULL,
        reason          TEXT    NOT NULL,
        current_pool    TEXT,
        candidate_pool  TEXT,
        current_apr     REAL,
        candidate_apr   REAL,
        pool_score      REAL,
        token_deviation REAL,
        total_nav       REAL,
        switching_cost  REAL,
        break_even_days REAL,
        result          TEXT    NOT NULL,
        detail_json     TEXT
      );
    `);
    db.exec('CREATE INDEX idx_decision_logs_time ON decision_logs (timestamp DESC)');
    db.exec('CREATE INDEX idx_decision_logs_action ON decision_logs (action, timestamp DESC)');
  },
});

/** Rows the operator wants back out verbatim; never used for money. */
function jsonOrNull(detail: Readonly<Record<string, unknown>> | undefined): string | null {
  return detail === undefined ? null : JSON.stringify(detail);
}

function parseDetail(value: string | null): Readonly<Record<string, unknown>> | undefined {
  if (value === null) return undefined;
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new StoreError('decision_logs.detail_json does not hold a JSON object');
  }
  return parsed as Readonly<Record<string, unknown>>;
}

registerMigration({
  version: 4,
  id: 'runtime_state',
  up: (db) => {
    // Single-row key/value table for state that must survive a restart: the §44 bot state and the
    // epoch the operator last acted on. `singleton = 1` constraint keeps it single-row by force.
    db.exec(`
      CREATE TABLE runtime_state (
        singleton   INTEGER PRIMARY KEY CHECK (singleton = 1),
        bot_state   TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        reason      TEXT,
        epoch       INTEGER NOT NULL DEFAULT 0
      );
    `);
  },
});

export interface PositionQuery {
  readonly status?: BotState;
  /** Only positions that have not been closed (`closed_at IS NULL`). */
  readonly openOnly?: boolean;
  readonly chainId?: number;
  readonly limit?: number;
}

export interface SwapRecordQuery {
  readonly poolId?: PoolId;
  readonly purpose?: SwapPurpose;
  readonly since?: IsoTimestamp;
  readonly limit?: number;
}

export interface DecisionLogQuery {
  readonly action?: string;
  readonly result?: string;
  /** Inclusive lower bound — §77 "why did it switch on day X". */
  readonly since?: IsoTimestamp;
  readonly until?: IsoTimestamp;
  readonly limit?: number;
}

/** §77 write shape: identical to `DecisionLog` except `timestamp` may be omitted (defaults to now). */
export type DecisionLogInput = Omit<DecisionLog, 'timestamp'> & { readonly timestamp?: IsoTimestamp };

/**
 * Typed access to the §75-§77 tables. Every write goes through an explicit method so the column
 * mapping lives in exactly one place and callers can never hand-write SQL.
 */
export class StateStore {
  readonly #db: Database;

  /**
   * `applyMigrations` runs here as well as in `openDatabase`, and that redundancy is deliberate:
   * migrations are registered by *importing* their owning module, so a caller that opened the
   * database before importing the store would otherwise end up with a handle whose tables do not
   * exist yet. Re-running the migrator is a single `SELECT` on an up-to-date database.
   */
  constructor(db: Database) {
    applyMigrations(db);
    this.#db = db;
  }

  /** §75 — insert a newly opened position. Returns `false` when `id` already exists. */
  insertPosition(position: Position, closedAt: IsoTimestamp | null = null): boolean {
    try {
      return executeChanges(
        this.#db,
        `INSERT INTO positions (
           id, chain_id, dex, pool_address, pool_id, token0, token1, token0_id, token1_id,
           opened_at, closed_at, initial_nav, entry_price, lower_price, upper_price,
           lower_tick, upper_tick,
           ${amountColumnList('initial_token0')}, ${amountColumnList('initial_token1')},
           liquidity, status, total_fees_usd, realized_pnl, unrealized_pnl, benchmark_value,
           fee_il_ratio, min_holding_until, cooldown_until, emergency_reason
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
           ${amountPlaceholders('initial_token0')}, ${amountPlaceholders('initial_token1')},
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          position.id,
          position.chainId,
          position.dex,
          position.poolAddress,
          position.poolId,
          position.token0,
          position.token1,
          position.token0Id,
          position.token1Id,
          position.openedAt,
          closedAt,
          position.initialNAV,
          position.entryPrice,
          position.lowerPrice,
          position.upperPrice,
          position.lowerTick,
          position.upperTick,
          ...amountValues('initial_token0', position.initialToken0),
          ...amountValues('initial_token1', position.initialToken1),
          bigintToText(position.liquidity),
          position.status,
          position.totalFeesUSD,
          position.realizedPnL,
          position.unrealizedPnL,
          position.benchmarkValue,
          position.feeILRatio,
          position.minHoldingUntil ?? null,
          position.cooldownUntil ?? null,
          position.emergencyReason ?? null,
        ],
      ) > 0;
    } catch (error) {
      if (isConstraintViolation(error)) return false; // duplicate id, or a second open position on the pool
      throw error;
    }
  }

  getPosition(id: string): Position | null {
    const row = queryOne(this.#db, 'SELECT * FROM positions WHERE id = ?', [id]);
    return row === undefined ? null : mapPosition(row);
  }

  listPositions(query: PositionQuery = {}): readonly Position[] {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (query.status !== undefined) {
      where.push('status = ?');
      params.push(query.status);
    }
    if (query.openOnly === true) where.push('closed_at IS NULL');
    if (query.chainId !== undefined) {
      where.push('chain_id = ?');
      params.push(query.chainId);
    }
    params.push(query.limit ?? 200);
    return queryAll(
      this.#db,
      `SELECT * FROM positions ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`}
       ORDER BY opened_at DESC LIMIT ?`,
      params,
    ).map(mapPosition);
  }

  /** The position the bot is currently operating on, or `null` when flat. */
  openPosition(chainId?: number): Position | null {
    return this.listPositions({ openOnly: true, ...(chainId === undefined ? {} : { chainId }) })[0] ?? null;
  }

  /**
   * Partial update of a position (status, PnL, fees, gate timestamps).
   *
   * `undefined` means "leave alone"; `null` is only accepted for the nullable fields
   * (`feeILRatio`, `emergencyReason`) — an explicit `null` on a NOT NULL column throws rather
   * than silently writing garbage.
   */
  updatePosition(id: string, patch: PositionPatch, closedAt?: IsoTimestamp | null): void {
    const assignments: string[] = [];
    const params: SqlValue[] = [];
    const put = (column: string, value: SqlValue): void => {
      assignments.push(`${assertIdentifier(column, 'column')} = ?`);
      params.push(value);
    };
    if (patch.status !== undefined) put('status', toBotState(patch.status, 'updatePosition'));
    if (patch.initialNAV !== undefined) put('initial_nav', patch.initialNAV);
    if (patch.entryPrice !== undefined) put('entry_price', patch.entryPrice);
    if (patch.lowerPrice !== undefined) put('lower_price', patch.lowerPrice);
    if (patch.upperPrice !== undefined) put('upper_price', patch.upperPrice);
    if (patch.lowerTick !== undefined) put('lower_tick', patch.lowerTick);
    if (patch.upperTick !== undefined) put('upper_tick', patch.upperTick);
    if (patch.initialToken0 !== undefined) {
      putAmountColumns(put, 'initial_token0', patch.initialToken0);
    }
    if (patch.initialToken1 !== undefined) {
      putAmountColumns(put, 'initial_token1', patch.initialToken1);
    }
    if (patch.liquidity !== undefined) put('liquidity', bigintToText(patch.liquidity));
    if (patch.totalFeesUSD !== undefined) put('total_fees_usd', patch.totalFeesUSD);
    if (patch.realizedPnL !== undefined) put('realized_pnl', patch.realizedPnL);
    if (patch.unrealizedPnL !== undefined) put('unrealized_pnl', patch.unrealizedPnL);
    if (patch.benchmarkValue !== undefined) put('benchmark_value', patch.benchmarkValue);
    if (patch.feeILRatio !== undefined) put('fee_il_ratio', patch.feeILRatio);
    if (patch.minHoldingUntil !== undefined) put('min_holding_until', patch.minHoldingUntil);
    if (patch.cooldownUntil !== undefined) put('cooldown_until', patch.cooldownUntil);
    if (patch.emergencyReason !== undefined) put('emergency_reason', patch.emergencyReason);
    if (closedAt !== undefined) put('closed_at', closedAt);
    if (assignments.length === 0) return;

    params.push(id);
    const changes = executeChanges(this.#db, `UPDATE positions SET ${assignments.join(', ')} WHERE id = ?`, params);
    if (changes === 0) throw new StoreError(`position ${id} does not exist`);
  }

  /**
   * §76 + §97 — record a swap. A repeated `idempotencyKey` is REJECTED (returns `false`): the
   * caller must treat that as "already executed", never as a trigger to send again.
   */
  insertSwapRecord(record: SwapRecord): boolean {
    try {
      return this.#insertSwapRecord(record);
    } catch (error) {
      // A UNIQUE violation on `idempotency_key` IS the duplicate signal — surface it as `false`
      // rather than an exception, so a caller cannot mistake it for an unrelated DB failure.
      if (isConstraintViolation(error)) return false;
      throw error;
    }
  }

  #insertSwapRecord(record: SwapRecord): boolean {
    return (
      executeChanges(
        this.#db,
        `INSERT INTO swap_records (
           tx_hash, timestamp, chain_id, pool_id, token_in, token_out, token_in_id, token_out_id,
           ${amountColumnList('amount_in')}, ${amountColumnList('amount_out')},
           ${amountColumnList('expected_amount_out')},
           slippage, price_impact, gas_cost_usd, purpose, idempotency_key
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?,
           ${amountPlaceholders('amount_in')}, ${amountPlaceholders('amount_out')},
           ${amountPlaceholders('expected_amount_out')},
           ?, ?, ?, ?, ?)`,
        [
          record.txHash,
          record.timestamp,
          record.chainId,
          record.poolId ?? null,
          record.tokenIn,
          record.tokenOut,
          record.tokenInId,
          record.tokenOutId,
          ...amountValues('amount_in', record.amountIn),
          ...amountValues('amount_out', record.amountOut),
          ...amountValues('expected_amount_out', record.expectedAmountOut),
          record.slippage,
          record.priceImpact,
          record.gasCostUSD,
          record.purpose,
          record.idempotencyKey,
        ],
      ) > 0
    );
  }

  /** §97 — has this intended operation already been executed (or at least recorded)? */
  hasIdempotencyKey(idempotencyKey: string): boolean {
    return queryOne(this.#db, 'SELECT 1 AS present FROM swap_records WHERE idempotency_key = ?', [
      idempotencyKey,
    ]) !== undefined;
  }

  getSwapRecordByKey(idempotencyKey: string): SwapRecord | null {
    const row = queryOne(this.#db, 'SELECT * FROM swap_records WHERE idempotency_key = ?', [
      idempotencyKey,
    ]);
    return row === undefined ? null : mapSwapRecord(row);
  }

  listSwapRecords(query: SwapRecordQuery = {}): readonly SwapRecord[] {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (query.poolId !== undefined) {
      where.push('pool_id = ?');
      params.push(query.poolId);
    }
    if (query.purpose !== undefined) {
      where.push('purpose = ?');
      params.push(query.purpose);
    }
    if (query.since !== undefined) {
      where.push('timestamp >= ?');
      params.push(query.since);
    }
    params.push(query.limit ?? 200);
    return queryAll(
      this.#db,
      `SELECT * FROM swap_records ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`}
       ORDER BY timestamp DESC, id DESC LIMIT ?`,
      params,
    ).map(mapSwapRecord);
  }

  /**
   * §77 — append a decision. `state` is validated against §44 before it reaches disk, so a log
   * row can always be replayed against the state machine. `timestamp` defaults to now.
   */
  appendDecisionLog(log: DecisionLogInput): void {
    execute(
      this.#db,
      `INSERT INTO decision_logs (
         timestamp, state, action, reason, current_pool, candidate_pool, current_apr, candidate_apr,
         pool_score, token_deviation, total_nav, switching_cost, break_even_days, result, detail_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        log.timestamp ?? new Date().toISOString(),
        toBotState(log.state, 'appendDecisionLog'),
        log.action,
        log.reason,
        log.currentPool ?? null,
        log.candidatePool ?? null,
        log.currentAPR ?? null,
        log.candidateAPR ?? null,
        log.poolScore ?? null,
        log.tokenDeviation ?? null,
        log.totalNAV ?? null,
        log.switchingCost ?? null,
        log.breakEvenDays ?? null,
        log.result,
        jsonOrNull(log.detail),
      ],
    );
  }

  listDecisionLogs(query: DecisionLogQuery = {}): readonly DecisionLog[] {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (query.action !== undefined) {
      where.push('action = ?');
      params.push(query.action);
    }
    if (query.result !== undefined) {
      where.push('result = ?');
      params.push(query.result);
    }
    if (query.since !== undefined) {
      where.push('timestamp >= ?');
      params.push(query.since);
    }
    if (query.until !== undefined) {
      where.push('timestamp <= ?');
      params.push(query.until);
    }
    params.push(query.limit ?? 200);
    return queryAll(
      this.#db,
      `SELECT * FROM decision_logs ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`}
       ORDER BY timestamp DESC, id DESC LIMIT ?`,
      params,
    ).map(mapDecisionLog);
  }
}

/** Explicit, `undefined`-means-unchanged patch for `updatePosition`. */
export interface PositionPatch {
  readonly status?: BotState;
  readonly initialNAV?: UsdAmount;
  readonly entryPrice?: UsdAmount;
  readonly lowerPrice?: UsdAmount;
  readonly upperPrice?: UsdAmount;
  readonly lowerTick?: Tick;
  readonly upperTick?: Tick;
  readonly initialToken0?: TokenAmount;
  readonly initialToken1?: TokenAmount;
  readonly liquidity?: bigint;
  readonly totalFeesUSD?: UsdAmount;
  readonly realizedPnL?: UsdAmount;
  readonly unrealizedPnL?: UsdAmount;
  readonly benchmarkValue?: UsdAmount;
  readonly feeILRatio?: Ratio | null;
  readonly minHoldingUntil?: IsoTimestamp | null;
  readonly cooldownUntil?: IsoTimestamp | null;
  readonly emergencyReason?: string | null;
}

function mapPosition(row: SqlRow): Position {
  const token0Id = requiredString(row, 'token0_id');
  const token1Id = requiredString(row, 'token1_id');
  return {
    id: requiredString(row, 'id'),
    chainId: requiredNumber(row, 'chain_id'),
    dex: requiredString(row, 'dex'),
    poolAddress: requiredString(row, 'pool_address') as Address,
    poolId: requiredString(row, 'pool_id'),
    token0: requiredString(row, 'token0') as Address,
    token1: requiredString(row, 'token1') as Address,
    token0Id,
    token1Id,
    openedAt: requiredString(row, 'opened_at'),
    initialNAV: requiredNumber(row, 'initial_nav'),
    entryPrice: requiredNumber(row, 'entry_price'),
    lowerPrice: requiredNumber(row, 'lower_price'),
    upperPrice: requiredNumber(row, 'upper_price'),
    lowerTick: requiredNumber(row, 'lower_tick'),
    upperTick: requiredNumber(row, 'upper_tick'),
    // The TokenAmount's own `tokenId`/`address` are the position's token columns, by definition.
    initialToken0: readTokenAmount(row, 'initial_token0', token0Id, requiredString(row, 'token0') as Address),
    initialToken1: readTokenAmount(row, 'initial_token1', token1Id, requiredString(row, 'token1') as Address),
    liquidity: requiredBigint(row, 'liquidity'),
    status: toBotState(requiredString(row, 'status'), 'positions.status'),
    totalFeesUSD: requiredNumber(row, 'total_fees_usd'),
    realizedPnL: requiredNumber(row, 'realized_pnl'),
    unrealizedPnL: requiredNumber(row, 'unrealized_pnl'),
    benchmarkValue: requiredNumber(row, 'benchmark_value'),
    feeILRatio: optionalNumber(row, 'fee_il_ratio'),
    ...nullable('minHoldingUntil', optionalString(row, 'min_holding_until')),
    ...nullable('cooldownUntil', optionalString(row, 'cooldown_until')),
    ...nullable('emergencyReason', optionalString(row, 'emergency_reason')),
  };
}

/** Spread helper so an optional field is absent (not `undefined`) when the column is NULL. */
function nullable<K extends string, V>(key: K, value: V | null): Partial<Record<K, V>> {
  return value === null ? {} : ({ [key]: value } as Record<K, V>);
}

function mapSwapRecord(row: SqlRow): SwapRecord {
  const tokenInId = requiredString(row, 'token_in_id');
  const tokenOutId = requiredString(row, 'token_out_id');
  const poolId = optionalString(row, 'pool_id');
  return {
    txHash: requiredString(row, 'tx_hash'),
    timestamp: requiredString(row, 'timestamp'),
    chainId: requiredNumber(row, 'chain_id'),
    ...nullable('poolId', poolId),
    tokenIn: requiredString(row, 'token_in') as Address,
    tokenOut: requiredString(row, 'token_out') as Address,
    tokenInId,
    tokenOutId,
    amountIn: readTokenAmount(row, 'amount_in', tokenInId, requiredString(row, 'token_in') as Address),
    amountOut: readTokenAmount(row, 'amount_out', tokenOutId, requiredString(row, 'token_out') as Address),
    expectedAmountOut: readTokenAmount(
      row,
      'expected_amount_out',
      tokenOutId,
      requiredString(row, 'token_out') as Address,
    ),
    slippage: requiredNumber(row, 'slippage'),
    priceImpact: requiredNumber(row, 'price_impact'),
    gasCostUSD: requiredNumber(row, 'gas_cost_usd'),
    purpose: requiredString(row, 'purpose') as SwapPurpose,
    idempotencyKey: requiredString(row, 'idempotency_key'),
  };
}

function mapDecisionLog(row: SqlRow): DecisionLog {
  const detail = parseDetail(optionalString(row, 'detail_json'));
  return {
    timestamp: requiredString(row, 'timestamp'),
    state: toBotState(requiredString(row, 'state'), 'decision_logs.state'),
    action: requiredString(row, 'action'),
    reason: requiredString(row, 'reason'),
    ...optionalField('currentPool', optionalString(row, 'current_pool')),
    ...optionalField('candidatePool', optionalString(row, 'candidate_pool')),
    ...optionalField('currentAPR', optionalNumber(row, 'current_apr')),
    ...optionalField('candidateAPR', optionalNumber(row, 'candidate_apr')),
    ...optionalField('poolScore', optionalNumber(row, 'pool_score')),
    ...optionalField('tokenDeviation', optionalNumber(row, 'token_deviation')),
    ...optionalField('totalNAV', optionalNumber(row, 'total_nav')),
    ...optionalField('switchingCost', optionalNumber(row, 'switching_cost')),
    ...optionalField('breakEvenDays', optionalInteger(row, 'break_even_days')),
    result: requiredString(row, 'result'),
    ...(detail === undefined ? {} : { detail }),
  };
}

function optionalField<K extends string, V>(key: K, value: V | null): Partial<Record<K, V>> {
  return value === null ? {} : ({ [key]: value } as Record<K, V>);
}

/** The persisted §44 state of the running process (table `runtime_state`, migration 4). */
export interface RuntimeStateRow {
  readonly botState: BotState;
  readonly updatedAt: IsoTimestamp;
  readonly reason?: string;
  /** Bumped on every operator action that changes control (pause/resume/emergency clear). */
  readonly epoch: number;
}

/**
 * Single-row accessor for the state machine's durable state.
 *
 * Kept separate from `StateStore` because it is one row updated in place rather than an auditable
 * log, and because the state machine has to load it before any other store call is meaningful.
 */
export class RuntimeStateStore {
  readonly #db: Database;

  /** See `StateStore`: re-running the migrator is what makes import order irrelevant. */
  constructor(db: Database) {
    applyMigrations(db);
    this.#db = db;
  }

  /** `null` on a virgin database — the caller must then decide the §44 start state. */
  get(): RuntimeStateRow | null {
    const row = queryOne(this.#db, 'SELECT bot_state, updated_at, reason, epoch FROM runtime_state WHERE singleton = 1');
    if (row === undefined) return null;
    const reason = optionalString(row, 'reason');
    return {
      botState: toBotState(requiredString(row, 'bot_state'), 'runtime_state.bot_state'),
      updatedAt: requiredString(row, 'updated_at'),
      epoch: requiredInteger(row, 'epoch'),
      ...(reason === null ? {} : { reason }),
    };
  }

  /** Upsert the current state; `epoch` carries over unless explicitly supplied. */
  set(next: { readonly botState: BotState; readonly reason?: string | null; readonly epoch?: number }, at: IsoTimestamp = new Date().toISOString()): RuntimeStateRow {
    const epoch = next.epoch ?? this.get()?.epoch ?? 0;
    execute(
      this.#db,
      `INSERT INTO runtime_state (singleton, bot_state, updated_at, reason, epoch)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT (singleton) DO UPDATE SET
         bot_state = excluded.bot_state,
         updated_at = excluded.updated_at,
         reason = excluded.reason,
         epoch = excluded.epoch`,
      [next.botState, at, next.reason ?? null, epoch],
    );
    return { botState: next.botState, updatedAt: at, epoch, ...(next.reason == null ? {} : { reason: next.reason }) };
  }
}

/** Re-exported so peers do not have to import two modules to see the error type. */
export { StoreError, errorMessage };
