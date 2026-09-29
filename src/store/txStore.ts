/**
 * §98 Transaction state persistence + §97 idempotency + §96 fail-closed restart recovery.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THIS TABLE EXISTS AT ALL
 *
 * The dangerous failure mode is not "a transaction failed" — it is "we do not know whether it
 * happened". A process restart, an RPC timeout or a dropped receipt leaves the intent in flight
 * while the local view says nothing was sent; a naive retry then swaps twice. So the intent is
 * written BEFORE signing (`CREATED`), the hash is attached as soon as it exists (`SUBMITTED`), and
 * a transaction whose outcome cannot be read becomes `UNKNOWN` — a state that is *resolved by
 * querying the chain*, never by sending again (§96/§98).
 *
 * `TxStore` enforces that with code, not convention:
 *   - `record()` is idempotent per `(idempotencyKey, attempt)` — repeating it returns the stored
 *     row instead of inserting a second one (§97).
 *   - Opening a NEW attempt (`attempt + 1`) is REFUSED while the latest attempt is `CREATED`,
 *     `SUBMITTED`, `UNKNOWN` or `CONFIRMED`. Only `FAILED`/`REVERTED` may be retried, and only
 *     deliberately by an operator/caller action. A NULL-hash `UNKNOWN` (we may never have
 *     observed a hash) stays refused forever.
 *   - `findUnresolved()` is the startup gate: everything it returns must be resolved by a chain
 *     query (`applyChainObservation`), and `planUnresolvedRecovery` labels each record with the
 *     action allowed — `query_chain` for the unresolved ones, never `retry`.
 *
 * MONEY/UNIT TYPES: wei values (`block_number`, `gas_used`, `effective_gas_price_wei`, `nonce`)
 * are exact decimal TEXT — a wei quantity exceeds `Number.MAX_SAFE_INTEGER` routinely and rounding
 * it would corrupt the receipt. `raw_tx` is TEXT (hex payload or serialized signed tx).
 */
import { TX_STATES, type TxGuardChecks, type TxState } from '../types/adapters.ts';
import type { Address, ChainId, Hash, IsoTimestamp } from '../types/primitives.ts';
import { applyMigrations, bigintToText, executeChanges, isConstraintViolation, optionalBigint, optionalInteger, optionalString, queryAll, queryOne, registerMigration, requiredInteger, requiredString, type Database, type SqlRow, type SqlValue, StoreError } from './db.ts';

/**
 * What the transaction was for. Store-owned vocabulary (the frozen contracts only carry
 * `SwapPurpose`, which covers swaps): executors pass one of these so a recovery run can reason
 * about intent without importing the executor layer.
 */
export const TX_PURPOSES = {
  SWAP: 'swap',
  ADD_LIQUIDITY: 'add_liquidity',
  REMOVE_LIQUIDITY: 'remove_liquidity',
  COLLECT_FEES: 'collect_fees',
  APPROVE: 'approve',
  /** Swap + addLiquidity in one Pancake SmartRouter call (§42). */
  ATOMIC_BUILD: 'atomic_build',
} as const;
export type TxPurpose = (typeof TX_PURPOSES)[keyof typeof TX_PURPOSES];

/** How `raw_tx` is encoded, so a recovery run can re-verify what was signed. */
export const RAW_TX_FORMATS = {
  /** `{to,data,value}` request JSON — the guard-checked intent before signing. */
  CALL_REQUEST: 'call-request',
  /** RLP-serialized signed transaction, ready to rebroadcast verbatim. */
  SERIALIZED: 'serialized',
} as const;
export type RawTxFormat = (typeof RAW_TX_FORMATS)[keyof typeof RAW_TX_FORMATS];

registerMigration({
  version: 5,
  id: 'tx_records',
  up: (db) => {
    db.exec(`
      CREATE TABLE tx_records (
        id                     INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key        TEXT    NOT NULL,
        attempt                INTEGER NOT NULL,
        chain_id               INTEGER NOT NULL,
        purpose                TEXT    NOT NULL,
        state                  TEXT    NOT NULL,
        tx_hash                TEXT    UNIQUE,
        from_address           TEXT,
        to_address             TEXT,
        nonce                  INTEGER,
        raw_tx                 TEXT    NOT NULL,
        raw_tx_format          TEXT    NOT NULL,
        guard_json             TEXT,
        created_at             TEXT    NOT NULL,
        updated_at             TEXT    NOT NULL,
        submitted_at           TEXT,
        resolved_at            TEXT,
        block_number           TEXT,
        gas_used               TEXT,
        effective_gas_price_wei TEXT,
        receipt_json           TEXT,
        unknown_reason         TEXT,
        resolution_reason      TEXT,
        superseded_by          TEXT,
        UNIQUE (idempotency_key, attempt)
      );
    `);
    db.exec('CREATE INDEX idx_tx_records_state ON tx_records (state, updated_at DESC)');
    db.exec('CREATE INDEX idx_tx_records_intent ON tx_records (idempotency_key, attempt DESC)');
  },
});

/** Persisted transaction record. `receipt` is a summary, never the whole viem receipt object. */
export interface TxRecord {
  readonly id: number;
  readonly idempotencyKey: string;
  /** 1-based; a new attempt is only ever opened deliberately (see `record`). */
  readonly attempt: number;
  readonly chainId: ChainId;
  readonly purpose: TxPurpose;
  readonly state: TxState;
  /** `null` when the intent was persisted before signing. */
  readonly txHash: Hash | null;
  readonly from?: Address;
  readonly to?: Address;
  readonly nonce?: number;
  readonly rawTx: string;
  readonly rawTxFormat: RawTxFormat;
  readonly guard?: TxGuardChecks;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly submittedAt?: IsoTimestamp;
  readonly resolvedAt?: IsoTimestamp;
  readonly blockNumber?: bigint;
  readonly gasUsed?: bigint;
  readonly effectiveGasPriceWei?: bigint;
  readonly receipt?: Readonly<Record<string, unknown>>;
  /** §98: present on `UNKNOWN` so an operator sees why no retry happened. */
  readonly unknownReason?: string;
  /** Why the state left `UNKNOWN` (the chain query outcome). Audit trail for §96. */
  readonly resolutionReason?: string;
  /** Set when this attempt was replaced by another one (same nonce, new gas). */
  readonly supersededBy?: Hash;
}

export interface TxRecordInput {
  readonly idempotencyKey: string;
  readonly chainId: ChainId;
  readonly purpose: TxPurpose;
  /** `{to,data,value}` JSON or an RLP payload; stored verbatim for audit/rebroadcast. */
  readonly rawTx: string;
  readonly rawTxFormat: RawTxFormat;
  readonly state?: TxState;
  readonly txHash?: Hash;
  readonly from?: Address;
  readonly to?: Address;
  readonly nonce?: number;
  readonly guard?: TxGuardChecks;
  /** Defaults to 1; must equal the next attempt number to open a new one. */
  readonly attempt?: number;
  readonly unknownReason?: string;
  readonly now?: IsoTimestamp;
}

/** Outcome of a chain query for one transaction (§98 `UNKNOWN` resolution path). */
export interface ChainObservation {
  /** A resolved state. `UNKNOWN` is not an observation — it is the absence of one. */
  readonly state: Exclude<TxState, 'UNKNOWN'>;
  /** Required: an operator must be able to see what the observation was based on. */
  readonly reason: string;
  readonly observedAt?: IsoTimestamp;
  readonly blockNumber?: bigint | null;
  readonly gasUsed?: bigint | null;
  readonly effectiveGasPriceWei?: bigint | null;
  readonly receipt?: Readonly<Record<string, unknown>>;
}

export interface UnresolvedQuery {
  readonly chainId?: ChainId;
  readonly limit?: number;
}

/** What the startup recovery pass is allowed to do with a stored record. */
export interface RecoveryAction {
  readonly record: TxRecord;
  /** `query_chain` = call `applyChainObservation`; `retry` = operator decision; `none` = done. */
  readonly action: 'query_chain' | 'retry' | 'none';
  readonly reason: string;
}

/** States that are still in flight: they must be resolved by a chain query, never re-sent. */
export const UNRESOLVED_TX_STATES: readonly TxState[] = [TX_STATES.CREATED, TX_STATES.SUBMITTED, TX_STATES.UNKNOWN];

/** States from which a deliberate new attempt is permitted (a definite, observed failure). */
export const RETRYABLE_TX_STATES: readonly TxState[] = [TX_STATES.FAILED, TX_STATES.REVERTED];

/** Raised when a caller asks to re-send something that must not be re-sent (§96 fail closed). */
export class TxBlockedError extends StoreError {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'TxBlockedError';
    this.code = code;
  }
}

function toTxState(value: string, where: string): TxState {
  if (!Object.values(TX_STATES).includes(value as TxState)) {
    throw new StoreError(`unknown tx state ${JSON.stringify(value)} in ${where} (§98)`);
  }
  return value as TxState;
}

function toTxPurpose(value: string): TxPurpose {
  if (!Object.values(TX_PURPOSES).includes(value as TxPurpose)) {
    throw new StoreError(`unknown tx purpose ${JSON.stringify(value)}`);
  }
  return value as TxPurpose;
}

function toRawTxFormat(value: string): RawTxFormat {
  if (!Object.values(RAW_TX_FORMATS).includes(value as RawTxFormat)) {
    throw new StoreError(`unknown raw tx format ${JSON.stringify(value)}`);
  }
  return value as RawTxFormat;
}

function parseJsonObject(value: string | null, column: string): Readonly<Record<string, unknown>> | undefined {
  if (value === null) return undefined;
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new StoreError(`tx_records.${column} does not hold a JSON object`);
  }
  return parsed as Readonly<Record<string, unknown>>;
}

export class TxStore {
  readonly #db: Database;

  /** See `StateStore`: re-running the migrator is what makes import order irrelevant. */
  constructor(db: Database) {
    applyMigrations(db);
    this.#db = db;
  }

  /**
   * Persist an intended transaction. Idempotent (§97).
   *
   * - Same `(idempotencyKey, attempt)` as the stored row ⇒ returns the stored row, no write.
   * - A new attempt while the latest one is unresolved or confirmed ⇒ `TxBlockedError`
   *   (`already_in_flight` / `unknown_requires_chain_query` / `already_confirmed`).
   */
  record(input: TxRecordInput): TxRecord {
    const attempt = input.attempt ?? 1;
    if (!Number.isInteger(attempt) || attempt < 1) {
      throw new StoreError(`attempt must be a positive integer: ${String(input.attempt)}`);
    }
    const existingSameAttempt = queryOne(
      this.#db,
      'SELECT * FROM tx_records WHERE idempotency_key = ? AND attempt = ?',
      [input.idempotencyKey, attempt],
    );
    if (existingSameAttempt !== undefined) return mapTxRecord(existingSameAttempt);

    const latest = this.latestAttempt(input.idempotencyKey);
    if (latest !== null) {
      if (attempt !== latest.attempt + 1) {
        throw new TxBlockedError(
          'attempt_out_of_order',
          `attempt ${attempt} would skip attempt ${latest.attempt + 1} for ` +
            `'${input.idempotencyKey}'; attempts are 1-based and sequential`,
        );
      }
      assertNewAttemptAllowed(latest);
    } else if (attempt !== 1) {
      throw new TxBlockedError(
        'attempt_out_of_order',
        `first attempt for '${input.idempotencyKey}' must be 1, got ${attempt}`,
      );
    }

    const now = input.now ?? new Date().toISOString();
    const state = input.state ?? (input.txHash === undefined ? TX_STATES.CREATED : TX_STATES.SUBMITTED);
    try {
      executeChanges(
        this.#db,
        `INSERT INTO tx_records (
           idempotency_key, attempt, chain_id, purpose, state, tx_hash, from_address, to_address,
           nonce, raw_tx, raw_tx_format, guard_json, created_at, updated_at, submitted_at, unknown_reason
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.idempotencyKey,
          attempt,
          input.chainId,
          input.purpose,
          state,
          input.txHash ?? null,
          input.from ?? null,
          input.to ?? null,
          input.nonce ?? null,
          input.rawTx,
          input.rawTxFormat,
          input.guard === undefined ? null : JSON.stringify(input.guard),
          now,
          now,
          state === TX_STATES.SUBMITTED ? now : null,
          input.unknownReason ?? null,
        ],
      );
    } catch (error) {
      // A concurrent writer inserted the same (key, attempt) or the same hash first: return that row.
      if (isConstraintViolation(error)) {
        const row = queryOne(
          this.#db,
          input.txHash === undefined
            ? 'SELECT * FROM tx_records WHERE idempotency_key = ? AND attempt = ?'
            : 'SELECT * FROM tx_records WHERE tx_hash = ? OR (idempotency_key = ? AND attempt = ?)',
          input.txHash === undefined ? [input.idempotencyKey, attempt] : [input.txHash, input.idempotencyKey, attempt],
        );
        if (row !== undefined) return mapTxRecord(row);
      }
      throw error;
    }
    const inserted = queryOne(
      this.#db,
      'SELECT * FROM tx_records WHERE idempotency_key = ? AND attempt = ?',
      [input.idempotencyKey, attempt],
    );
    if (inserted === undefined) throw new StoreError('tx_records insert did not persist');
    return mapTxRecord(inserted);
  }

  /**
   * Guard-checked variant of `record` used by executors: refuses to persist an intent whose
   * §95 gate failed, so a `guard.ok === false` request can never even be stored as "in flight".
   */
  recordIntended(input: TxRecordInput, guard: TxGuardChecks): TxRecord {
    if (!guard.ok) {
      throw new TxBlockedError(
        'guard_failed',
        `tx guard failed for '${input.idempotencyKey}': ${guard.failures.join('; ') || 'unspecified'} (§95 — nothing is sent)`,
      );
    }
    return this.record({ ...input, guard });
  }

  /** A broadcast that failed locally, before a hash existed (FFA / gas estimation / RPC reject). */
  markBroadcastFailed(idempotencyKey: string, reason: string, attempt?: number, now: IsoTimestamp = new Date().toISOString()): TxRecord {
    const row = this.#requireAttempt(idempotencyKey, attempt);
    return this.#update(row.id, {
      state: TX_STATES.FAILED,
      unknown_reason: reason,
      resolved_at: now,
      updated_at: now,
    });
  }

  /**
   * Attach the hash and move `CREATED → SUBMITTED`.
   *
   * Kept separate from `record` because the hash only exists after signing, and the SUBMITTED
   * timestamp is the anchor for "did this land" during recovery.
   */
  markSubmitted(idempotencyKey: string, txHash: Hash, attempt?: number, now: IsoTimestamp = new Date().toISOString()): TxRecord {
    const row = this.#requireAttempt(idempotencyKey, attempt);
    if (row.state !== TX_STATES.CREATED && row.state !== TX_STATES.UNKNOWN) {
      throw new TxBlockedError(
        'invalid_transition',
        `cannot mark '${idempotencyKey}' attempt ${row.attempt} SUBMITTED from ${row.state}`,
      );
    }
    return this.#update(row.id, {
      state: TX_STATES.SUBMITTED,
      tx_hash: txHash,
      updated_at: now,
      submitted_at: now,
      // Re-broadcasting the same signed tx after an UNKNOWN is a *query-then-confirm* fallback; the
      // previous UNKNOWN reason stays in the row history via resolution_reason.
      resolution_reason: `resubmitted_same_payload_at=${now}`,
    });
  }

  /**
   * §98 — resolve a transaction with the result of a chain query.
   *
   * The ONLY sanctioned way out of `UNKNOWN`. `reason` is mandatory: an operator reading the row
   * later must see what the chain actually said.
   */
  applyChainObservation(txHash: Hash, observation: ChainObservation): TxRecord {
    const row = queryOne(this.#db, 'SELECT * FROM tx_records WHERE tx_hash = ?', [txHash]);
    if (row === undefined) throw new StoreError(`no tx_records row for hash ${txHash}`);
    if (observation.reason.trim().length === 0) {
      throw new StoreError(`applyChainObservation requires a reason for ${txHash}`);
    }
    // "I looked and I still do not know" is not an observation: §98 keeps the record UNKNOWN and
    // the startup gate keeps returning it. Encoding that as a write here would hide the problem.
    if ((observation.state as TxState) === TX_STATES.UNKNOWN) {
      throw new StoreError(
        `applyChainObservation cannot resolve ${txHash} to UNKNOWN — use markUnknown(key, reason) instead`,
      );
    }
    const at = observation.observedAt ?? new Date().toISOString();
    const current = toTxState(requiredString(row, 'state'), 'tx_records.state');
    if (current === TX_STATES.CONFIRMED) return mapTxRecord(row); // already final, ignore
    const next = observation.state;
    return this.#update(requiredInteger(row, 'id'), {
      state: next,
      updated_at: at,
      resolved_at: next === TX_STATES.FAILED || next === TX_STATES.REVERTED || next === TX_STATES.CONFIRMED ? at : null,
      block_number: observation.blockNumber === undefined || observation.blockNumber === null ? null : bigintToText(observation.blockNumber),
      gas_used: observation.gasUsed === undefined || observation.gasUsed === null ? null : bigintToText(observation.gasUsed),
      effective_gas_price_wei:
        observation.effectiveGasPriceWei === undefined || observation.effectiveGasPriceWei === null
          ? null
          : bigintToText(observation.effectiveGasPriceWei),
      receipt_json: observation.receipt === undefined ? null : JSON.stringify(observation.receipt),
      resolution_reason: `${current}->${next}: ${observation.reason}`,
    });
  }

  /** Record an unreadable outcome. `reason` is stored so the operator sees why nothing retried. */
  markUnknown(idempotencyKey: string, reason: string, attempt?: number, now: IsoTimestamp = new Date().toISOString()): TxRecord {
    const row = this.#requireAttempt(idempotencyKey, attempt);
    if (row.state === TX_STATES.CONFIRMED) {
      throw new TxBlockedError('invalid_transition', `'${idempotencyKey}' is already CONFIRMED`);
    }
    validateUnknownReason(reason);
    return this.#update(row.id, {
      state: TX_STATES.UNKNOWN,
      unknown_reason: reason,
      updated_at: now,
    });
  }

  /** Mark this attempt replaced by another one (same nonce, new gas price). */
  markSuperseded(idempotencyKey: string, replacement: Hash, attempt: number, reason: string): TxRecord {
    const row = this.#requireAttempt(idempotencyKey, attempt);
    return this.#update(row.id, {
      superseded_by: replacement,
      resolution_reason: `superseded_by=${replacement}: ${reason}`,
      updated_at: new Date().toISOString(),
    });
  }

  getByHash(txHash: Hash): TxRecord | null {
    const row = queryOne(this.#db, 'SELECT * FROM tx_records WHERE tx_hash = ?', [txHash]);
    return row === undefined ? null : mapTxRecord(row);
  }

  /** Latest attempt for an intended operation, or `null` when nothing was ever persisted. */
  latestAttempt(idempotencyKey: string): TxRecord | null {
    const row = queryOne(
      this.#db,
      'SELECT * FROM tx_records WHERE idempotency_key = ? ORDER BY attempt DESC LIMIT 1',
      [idempotencyKey],
    );
    return row === undefined ? null : mapTxRecord(row);
  }

  listAttempts(idempotencyKey: string): readonly TxRecord[] {
    return queryAll(
      this.#db,
      'SELECT * FROM tx_records WHERE idempotency_key = ? ORDER BY attempt ASC',
      [idempotencyKey],
    ).map(mapTxRecord);
  }

  listByState(state: TxState, limit = 200): readonly TxRecord[] {
    return queryAll(
      this.#db,
      'SELECT * FROM tx_records WHERE state = ? ORDER BY updated_at DESC LIMIT ?',
      [state, limit],
    ).map(mapTxRecord);
  }

  /**
   * §96/§98 startup gate — transactions whose outcome is not final.
   *
   * Everything returned here MUST be resolved by `applyChainObservation` after a chain query (or
   * explicitly re-broadcast with the *same* signed payload via `markSubmitted`). It is never a
   * retry list.
   */
  findUnresolved(query: UnresolvedQuery = {}): readonly TxRecord[] {
    const placeholders = UNRESOLVED_TX_STATES.map(() => '?').join(', ');
    const params: SqlValue[] = [...UNRESOLVED_TX_STATES];
    let sql = `SELECT * FROM tx_records WHERE state IN (${placeholders})`;
    if (query.chainId !== undefined) {
      sql += ' AND chain_id = ?';
      params.push(query.chainId);
    }
    sql += ' ORDER BY updated_at ASC LIMIT ?';
    params.push(query.limit ?? 200);
    return queryAll(this.#db, sql, params).map(mapTxRecord);
  }

  /** Persist the `TxGuardChecks` verdict for a record (used by executors before signing). */
  attachGuard(idempotencyKey: string, attempt: number, guard: TxGuardChecks): TxRecord {
    const row = this.#requireAttempt(idempotencyKey, attempt);
    return this.#update(row.id, { guard_json: JSON.stringify(guard), updated_at: new Date().toISOString() });
  }

  #requireAttempt(idempotencyKey: string, attempt?: number): TxRecord {
    const row =
      attempt === undefined
        ? this.latestAttempt(idempotencyKey)
        : (() => {
            const raw = queryOne(
              this.#db,
              'SELECT * FROM tx_records WHERE idempotency_key = ? AND attempt = ?',
              [idempotencyKey, attempt],
            );
            return raw === undefined ? null : mapTxRecord(raw);
          })();
    if (row === null) {
      throw new StoreError(
        `no tx_records row for '${idempotencyKey}'${attempt === undefined ? '' : ` attempt ${attempt}`}`,
      );
    }
    return row;
  }

  #update(id: number, patch: Readonly<Record<string, SqlValue>>): TxRecord {
    const assignments: string[] = [];
    const params: SqlValue[] = [];
    for (const [column, value] of Object.entries(patch)) {
      assignments.push(`${column} = ?`);
      params.push(value);
    }
    if (assignments.length === 0) throw new StoreError('empty tx_records patch');
    params.push(id);
    executeChanges(this.#db, `UPDATE tx_records SET ${assignments.join(', ')} WHERE id = ?`, params);
    const row = queryOne(this.#db, 'SELECT * FROM tx_records WHERE id = ?', [id]);
    if (row === undefined) throw new StoreError(`tx_records row ${id} disappeared`);
    return mapTxRecord(row);
  }
}

function validateUnknownReason(reason: string): void {
  if (reason.trim().length === 0) {
    throw new StoreError('UNKNOWN must carry a reason (§98): the operator has to see why no retry happened');
  }
}

/**
 * May a NEW attempt be recorded for this operation? (pure, so callers can pre-flight.)
 *
 * `UNKNOWN` is the case §98 singles out: it is refusable on purpose, even though it looks like a
 * failure. The remedy is a chain query, not another transaction.
 */
export function canOpenNewAttempt(latest: TxRecord | null): { readonly ok: boolean; readonly code: string; readonly reason: string } {
  if (latest === null) {
    return { ok: true, code: 'no_prior_attempt', reason: 'no attempt recorded yet' };
  }
  if (latest.state === TX_STATES.UNKNOWN) {
    return {
      ok: false,
      code: 'unknown_requires_chain_query',
      reason:
        `attempt ${latest.attempt} is UNKNOWN` +
        `${latest.txHash === null ? ' (no hash was ever observed)' : ` (hash ${latest.txHash})`}` +
        `${latest.unknownReason === undefined ? '' : ` — ${latest.unknownReason}`}` +
        '; §98 requires a chain query instead of a re-send',
    };
  }
  if (UNRESOLVED_TX_STATES.includes(latest.state)) {
    return {
      ok: false,
      code: 'already_in_flight',
      reason: `attempt ${latest.attempt} is ${latest.state}; resolve it before opening attempt ${latest.attempt + 1}`,
    };
  }
  if (latest.state === TX_STATES.CONFIRMED) {
    return { ok: false, code: 'already_confirmed', reason: `attempt ${latest.attempt} is CONFIRMED; the intent already executed` };
  }
  if (RETRYABLE_TX_STATES.includes(latest.state)) {
    return {
      ok: true,
      code: 'retry_allowed',
      reason: `attempt ${latest.attempt} is ${latest.state}; a deliberate retry is allowed`,
    };
  }
  return { ok: false, code: 'unknown_state', reason: `attempt ${latest.attempt} state ${latest.state} has no retry policy` };
}

function assertNewAttemptAllowed(latest: TxRecord): void {
  const verdict = canOpenNewAttempt(latest);
  if (!verdict.ok) throw new TxBlockedError(verdict.code, verdict.reason);
}

/**
 * Startup recovery plan. Never returns `retry` for an unresolved record — that is the whole point
 * of the §98 rule, and this function is the single place it is decided.
 */
export function planUnresolvedRecovery(records: readonly TxRecord[]): readonly RecoveryAction[] {
  return records.map((record) => {
    if (record.state === TX_STATES.UNKNOWN) {
      return {
        record,
        action: 'query_chain' as const,
        reason: `UNKNOWN: query ${record.txHash ?? 'the signer nonce history (no hash recorded)'} on chain before anything else`,
      };
    }
    if (record.state === TX_STATES.SUBMITTED) {
      return {
        record,
        action: 'query_chain' as const,
        reason: `SUBMITTED ${record.submittedAt ?? ''}: read the receipt (or re-broadcast the identical signed payload) — never a fresh swap`,
      };
    }
    if (record.state === TX_STATES.CREATED) {
      return {
        record,
        action: 'query_chain' as const,
        reason: 'CREATED: the intent was persisted before signing; check the signer nonce before re-using it',
      };
    }
    return { record, action: 'none' as const, reason: `terminal state ${record.state}` };
  });
}

function mapTxRecord(row: SqlRow): TxRecord {
  const from = optionalString(row, 'from_address');
  const to = optionalString(row, 'to_address');
  const nonce = optionalInteger(row, 'nonce');
  const submittedAt = optionalString(row, 'submitted_at');
  const resolvedAt = optionalString(row, 'resolved_at');
  const blockNumber = optionalBigint(row, 'block_number');
  const gasUsed = optionalBigint(row, 'gas_used');
  const effectiveGasPriceWei = optionalBigint(row, 'effective_gas_price_wei');
  const receipt = parseJsonObject(optionalString(row, 'receipt_json'), 'receipt_json');
  const guard = parseJsonObject(optionalString(row, 'guard_json'), 'guard_json');
  const unknownReason = optionalString(row, 'unknown_reason');
  const resolutionReason = optionalString(row, 'resolution_reason');
  const supersededBy = optionalString(row, 'superseded_by');
  const txHash = optionalString(row, 'tx_hash');

  return {
    id: requiredInteger(row, 'id'),
    idempotencyKey: requiredString(row, 'idempotency_key'),
    attempt: requiredInteger(row, 'attempt'),
    chainId: requiredInteger(row, 'chain_id'),
    purpose: toTxPurpose(requiredString(row, 'purpose')),
    state: toTxState(requiredString(row, 'state'), 'tx_records.state'),
    txHash: txHash === null ? null : (txHash as Hash),
    rawTx: requiredString(row, 'raw_tx'),
    rawTxFormat: toRawTxFormat(requiredString(row, 'raw_tx_format')),
    createdAt: requiredString(row, 'created_at'),
    updatedAt: requiredString(row, 'updated_at'),
    ...(from === null ? {} : { from: from as Address }),
    ...(to === null ? {} : { to: to as Address }),
    ...(nonce === null ? {} : { nonce }),
    ...(submittedAt === null ? {} : { submittedAt }),
    ...(resolvedAt === null ? {} : { resolvedAt }),
    ...(blockNumber === null ? {} : { blockNumber }),
    ...(gasUsed === null ? {} : { gasUsed }),
    ...(effectiveGasPriceWei === null ? {} : { effectiveGasPriceWei }),
    ...(receipt === undefined ? {} : { receipt }),
    ...(guard === undefined ? {} : { guard: guard as unknown as TxGuardChecks }),
    ...(unknownReason === null ? {} : { unknownReason }),
    ...(resolutionReason === null ? {} : { resolutionReason }),
    ...(supersededBy === null ? {} : { supersededBy: supersededBy as Hash }),
  };
}
