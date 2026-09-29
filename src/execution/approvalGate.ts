/**
 * §77 + §91 + §96 approval gate — the single release path for human-confirmed writes.
 *
 * Only `BUILD_POSITION` and `SWITCH_POOL` (the two `APPROVAL_KINDS`) pass through here; collect /
 * exit / risk operations stay automatic and must NOT be routed through this gate (§91).
 *
 * Fail-closed rules enforced by `gate()` — in none of these cases is `run` invoked:
 *   1. `requestId` was never created            → unknown request
 *   2. request is `pending` and nobody answers   → expires at `expiresAt`
 *   3. request is `rejected`                     → refused, the stored reason is reported
 *   4. request is `expired`                      → refused
 *   plus: `approved` after `expiresAt` is refused as well — the contract says a request must not be
 *   executed past `expiresAt` ("Past this instant the request is `expired` and must NOT be executed")
 *   — and a store that cannot be read/written refuses instead of guessing.
 *
 * Persistence is the same SQLite database (`data/lptrader.db`) in table `approval_requests`; the
 * DDL is idempotent and also exposed as a `Migration`-shaped object (`APPROVAL_REQUESTS_MIGRATION`,
 * version 100) so `StateStore`'s migration registry can own it (see module docs in the report).
 * Every state change is appended to the §77 `DecisionLog` through an injected sink.
 *
 * A release is **one-shot**: `gate()` runs the action at most once per `requestId` (§97 idempotency)
 * — a second call with the same id refuses with `ALREADY_RELEASED` instead of executing twice, even
 * while the first call is still in flight. If a `run` fails, the caller must create a NEW request;
 * re-releasing an old approval is never allowed.
 *
 * The in-process wait for an answer is deliberately decoupled from the notifier: `request()`
 * publishes in the background, `gate()` waits for the settlement. That means a slow Telegram call
 * never blocks the request from being recorded, and a lost callback still expires on time.
 */
import {
  APPROVAL_KINDS,
  APPROVAL_STATUSES,
  type ApprovalKind,
  type ApprovalRequest,
  type ApprovalStatus,
  type ApprovalDecision,
  type Notifier,
} from '../types/notifier.ts';
import { BOT_STATES, type BotState } from '../types/state.ts';
import type { DecisionLog } from '../types/portfolio.ts';
import type { IsoTimestamp } from '../types/primitives.ts';

// -----------------------------------------------------------------------------------------------
// Narrow wiring interfaces (owned by this module; no cross-slice dependency)
// -----------------------------------------------------------------------------------------------

/** §77 audit sink. `StateStore.appendDecisionLog` satisfies this via `stateStoreDecisionLogSink`. */
export interface DecisionLogSink {
  append(record: DecisionLog): unknown;
}

/** Structural view of `StateStore`'s §77 writer — no import from the store slice is needed. */
export interface DecisionLogWriter {
  appendDecisionLog(record: Omit<DecisionLog, 'timestamp'> & { readonly timestamp?: IsoTimestamp }): void;
}

/**
 * **Wiring point for StateStore (T11).**
 *
 * Adapts `StateStore` to the gate's §77 sink. `timestamp` is preserved, so the audit row carries the
 * gate's clock rather than the store's.
 */
export function stateStoreDecisionLogSink(store: DecisionLogWriter): DecisionLogSink {
  return {
    append: (record) => {
      store.appendDecisionLog(record);
      return undefined;
    },
  };
}

/** Minimal structured logger. Compatible with `console` and with a no-op default. */
export interface LoggerLike {
  info(message: string, detail?: Readonly<Record<string, string>>): void;
  warn(message: string, detail?: Readonly<Record<string, string>>): void;
  error(message: string, detail?: Readonly<Record<string, string>>): void;
}

const defaultLogger: LoggerLike = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Values `node:sqlite` accepts as bound parameters. */
export type SqliteValue = string | number | bigint | null | Uint8Array;

export interface SqliteStatementLike {
  run(...params: readonly SqliteValue[]): unknown;
  get(...params: readonly SqliteValue[]): unknown;
  all(...params: readonly SqliteValue[]): readonly unknown[];
}

/**
 * Structural view of the SQLite handle. `node:sqlite`'s `DatabaseSync` satisfies it, so the gate
 * needs no import from the store slice and stays testable with an in-memory implementation.
 */
export interface SqliteDatabaseLike {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatementLike;
}

/** A migration in the shape `StateStore.registerMigration` consumes. */
export interface ApprovalMigration {
  readonly version: number;
  readonly id: string;
  readonly up: (db: SqliteDatabaseLike) => void;
}

/**
 * Idempotent DDL for this slice's table. Version 100+ keeps it clear of StateStore's core 1..99
 * (`registerApprovalMigration()` puts it in their registry; the DDL is also run directly so the gate
 * works with a bare `node:sqlite` handle, e.g. in tests).
 *
 * `approval_requests` is owned exclusively by this module.
 */
export const APPROVAL_REQUESTS_TABLE = 'approval_requests';

export const APPROVAL_REQUESTS_DDL = `
CREATE TABLE IF NOT EXISTS ${APPROVAL_REQUESTS_TABLE} (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,
  status          TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  decided_at      TEXT,
  decided_by      TEXT,
  -- Set when the approved action was handed to the executor. Durable §97 proof that this approval
  -- was already consumed, so a process restart cannot release it a second time.
  released_at     TEXT,
  reason          TEXT,
  payload_summary TEXT NOT NULL,
  payload_json    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ${APPROVAL_REQUESTS_TABLE}_status_idx
  ON ${APPROVAL_REQUESTS_TABLE} (status);
`;

export function ensureApprovalRequestsSchema(db: SqliteDatabaseLike): void {
  db.exec(APPROVAL_REQUESTS_DDL);
}

export const APPROVAL_REQUESTS_MIGRATION: ApprovalMigration = {
  version: 100,
  id: APPROVAL_REQUESTS_TABLE,
  up: ensureApprovalRequestsSchema,
};

// -----------------------------------------------------------------------------------------------
// Records & store
// -----------------------------------------------------------------------------------------------

/** A persisted approval request plus the decision that closed it. */
export interface StoredApprovalRequest {
  readonly id: string;
  readonly kind: ApprovalKind;
  readonly status: ApprovalStatus;
  readonly createdAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  readonly decidedAt?: IsoTimestamp;
  readonly decidedBy?: string;
  /** Set once the approved action was handed to the executor (§97 durable release claim). */
  readonly releasedAt?: IsoTimestamp;
  readonly reason?: string;
  readonly payloadSummary: string;
  readonly payloadJson: Readonly<Record<string, unknown>>;
}

export interface ApprovalStore {
  /** Idempotent DDL; safe to call on every open. */
  ensureSchema(): void;
  insert(record: StoredApprovalRequest): void;
  get(id: string): StoredApprovalRequest | null;
  /**
   * `pending → approved|rejected` in one conditional statement. `applied` is true ONLY for the call
   * that performed the transition, which is what makes repeated clicks idempotent.
   */
  decide(
    id: string,
    decision: {
      readonly approved: boolean;
      readonly decidedBy: string;
      readonly decidedAt: IsoTimestamp;
      readonly reason: string;
    },
  ): { readonly applied: boolean; readonly record: StoredApprovalRequest | null };
  /** `pending → expired` when `expiresAt <= now`. Returns the record after the attempt. */
  expire(id: string, now: IsoTimestamp): { readonly applied: boolean; readonly record: StoredApprovalRequest | null };
  /**
   * Claim an approved request for its single release (`released_at IS NULL → now`). `claimed` is
   * true only for the call that won the claim, which is what makes a release survive a restart.
   */
  claimRelease(id: string, now: IsoTimestamp): { readonly claimed: boolean; readonly record: StoredApprovalRequest | null };
}

interface ApprovalRow {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly decided_at: string | null;
  readonly decided_by: string | null;
  readonly released_at: string | null;
  readonly reason: string | null;
  readonly payload_summary: string;
  readonly payload_json: string;
}

function rowToRecord(row: ApprovalRow): StoredApprovalRequest {
  // `payload_json` is written by this module from a `Record<string, unknown>`; a corrupt row is
  // read as "no payload" rather than trusted (this value is never used to decide anything).
  let payloadJson: Readonly<Record<string, unknown>> = {};
  try {
    const parsed: unknown = JSON.parse(row.payload_json);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      payloadJson = parsed as Record<string, unknown>;
    }
  } catch {
    payloadJson = {};
  }
  return {
    id: row.id,
    kind: row.kind as ApprovalKind,
    status: row.status as ApprovalStatus,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(row.decided_at === null ? {} : { decidedAt: row.decided_at }),
    ...(row.decided_by === null ? {} : { decidedBy: row.decided_by }),
    ...(row.released_at === null ? {} : { releasedAt: row.released_at }),
    ...(row.reason === null ? {} : { reason: row.reason }),
    payloadSummary: row.payload_summary,
    // Only this module writes `payload_json`, and it always writes an object; anything else is read
    // as "no payload" rather than trusted (the value never decides anything).
    payloadJson,
  };
}

/** SQLite-backed store for `approval_requests`. */
export class SqliteApprovalStore implements ApprovalStore {
  private readonly db: SqliteDatabaseLike;

  constructor(db: SqliteDatabaseLike) {
    this.db = db;
  }

  ensureSchema(): void {
    ensureApprovalRequestsSchema(this.db);
  }

  insert(record: StoredApprovalRequest): void {
    this.db
      .prepare(
        `INSERT INTO ${APPROVAL_REQUESTS_TABLE}
           (id, kind, status, created_at, expires_at, decided_at, decided_by, released_at, reason, payload_summary, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.kind,
        record.status,
        record.createdAt,
        record.expiresAt,
        record.decidedAt ?? null,
        record.decidedBy ?? null,
        record.releasedAt ?? null,
        record.reason ?? null,
        record.payloadSummary,
        JSON.stringify(record.payloadJson),
      );
  }

  get(id: string): StoredApprovalRequest | null {
    const row = this.db
      .prepare(`SELECT * FROM ${APPROVAL_REQUESTS_TABLE} WHERE id = ?`)
      .get(id);
    return row === undefined || row === null ? null : rowToRecord(row as ApprovalRow);
  }

  decide(
    id: string,
    decision: {
      readonly approved: boolean;
      readonly decidedBy: string;
      readonly decidedAt: IsoTimestamp;
      readonly reason: string;
    },
  ): { readonly applied: boolean; readonly record: StoredApprovalRequest | null } {
    const status: ApprovalStatus = decision.approved
      ? APPROVAL_STATUSES.APPROVED
      : APPROVAL_STATUSES.REJECTED;
    const result = this.db
      .prepare(
        `UPDATE ${APPROVAL_REQUESTS_TABLE}
            SET status = ?, decided_at = ?, decided_by = ?, reason = ?
          WHERE id = ? AND status = ?`,
      )
      .run(status, decision.decidedAt, decision.decidedBy, decision.reason, id, APPROVAL_STATUSES.PENDING);
    const applied = changesOf(result) === 1;
    return { applied, record: this.get(id) };
  }

  expire(id: string, now: IsoTimestamp): { readonly applied: boolean; readonly record: StoredApprovalRequest | null } {
    // `expired` means "the window closed before the action ran": that covers both a request nobody
    // answered and one approved so late that releasing it would violate `expiresAt`.
    const result = this.db
      .prepare(
        `UPDATE ${APPROVAL_REQUESTS_TABLE}
            SET status = ?, decided_at = COALESCE(decided_at, ?), reason = ?
          WHERE id = ? AND status IN (?, ?) AND expires_at <= ?`,
      )
      .run(
        APPROVAL_STATUSES.EXPIRED,
        now,
        `expired after ${now} (fail closed)`,
        id,
        APPROVAL_STATUSES.PENDING,
        APPROVAL_STATUSES.APPROVED,
        now,
      );
    return { applied: changesOf(result) === 1, record: this.get(id) };
  }

  claimRelease(id: string, now: IsoTimestamp): { readonly claimed: boolean; readonly record: StoredApprovalRequest | null } {
    const result = this.db
      .prepare(
        `UPDATE ${APPROVAL_REQUESTS_TABLE}
            SET released_at = ?
          WHERE id = ? AND status = ? AND released_at IS NULL`,
      )
      .run(now, id, APPROVAL_STATUSES.APPROVED);
    return { claimed: changesOf(result) === 1, record: this.get(id) };
  }
}

/** `node:sqlite` reports `{ changes }`; a result without a usable counter counts as "not applied". */
function changesOf(result: unknown): number {
  if (typeof result !== 'object' || result === null || !('changes' in result)) {
    return 0;
  }
  const changes = result.changes;
  if (typeof changes === 'bigint') {
    return Number(changes);
  }
  return typeof changes === 'number' ? changes : 0;
}

/** In-memory store for tests, `--dry-run` runs and read-only starts (no file is created). */
export class InMemoryApprovalStore implements ApprovalStore {
  private readonly rows = new Map<string, StoredApprovalRequest>();

  ensureSchema(): void {}

  insert(record: StoredApprovalRequest): void {
    this.rows.set(record.id, record);
  }

  get(id: string): StoredApprovalRequest | null {
    return this.rows.get(id) ?? null;
  }

  decide(
    id: string,
    decision: {
      readonly approved: boolean;
      readonly decidedBy: string;
      readonly decidedAt: IsoTimestamp;
      readonly reason: string;
    },
  ): { readonly applied: boolean; readonly record: StoredApprovalRequest | null } {
    const current = this.rows.get(id);
    if (current === undefined) {
      return { applied: false, record: null };
    }
    if (current.status !== APPROVAL_STATUSES.PENDING) {
      return { applied: false, record: current };
    }
    const next: StoredApprovalRequest = {
      ...current,
      status: decision.approved ? APPROVAL_STATUSES.APPROVED : APPROVAL_STATUSES.REJECTED,
      decidedAt: decision.decidedAt,
      decidedBy: decision.decidedBy,
      reason: decision.reason,
    };
    this.rows.set(id, next);
    return { applied: true, record: next };
  }

  expire(id: string, now: IsoTimestamp): { readonly applied: boolean; readonly record: StoredApprovalRequest | null } {
    const current = this.rows.get(id);
    if (current === undefined) {
      return { applied: false, record: null };
    }
    const expirable =
      current.status === APPROVAL_STATUSES.PENDING || current.status === APPROVAL_STATUSES.APPROVED;
    if (!expirable || current.expiresAt > now) {
      return { applied: false, record: current };
    }
    const next: StoredApprovalRequest = {
      ...current,
      status: APPROVAL_STATUSES.EXPIRED,
      decidedAt: current.decidedAt ?? now,
      reason: `expired after ${now} (fail closed)`,
    };
    this.rows.set(id, next);
    return { applied: true, record: next };
  }

  claimRelease(id: string, now: IsoTimestamp): { readonly claimed: boolean; readonly record: StoredApprovalRequest | null } {
    const current = this.rows.get(id);
    if (current === undefined) {
      return { claimed: false, record: null };
    }
    if (current.status !== APPROVAL_STATUSES.APPROVED || current.releasedAt !== undefined) {
      return { claimed: false, record: current };
    }
    const next: StoredApprovalRequest = { ...current, releasedAt: now };
    this.rows.set(id, next);
    return { claimed: true, record: next };
  }
}

// -----------------------------------------------------------------------------------------------
// The gate
// -----------------------------------------------------------------------------------------------

/** §77 action names written by this module. */
export const APPROVAL_ACTIONS = {
  REQUESTED: 'approval.requested',
  APPROVED: 'approval.approved',
  REJECTED: 'approval.rejected',
  EXPIRED: 'approval.expired',
  GATE_ALLOWED: 'approval.gate_allowed',
  GATE_BLOCKED: 'approval.gate_blocked',
  RUN_FAILED: 'approval.run_failed',
  RUN_DUPLICATE_DECISION: 'approval.duplicate_decision',
  STORE_UNAVAILABLE: 'approval.store_unavailable',
  DUPLICATE_REQUEST: 'approval.duplicate_request',
} as const;

/** Gate refusal reasons. Exported so callers/reporting never spell them by hand. */
export const GATE_REFUSAL_REASONS = {
  UNKNOWN_REQUEST: 'no persisted approval request with this id (fail closed)',
  WRONG_KIND: 'approval request kind does not match the action being gated (fail closed)',
  REJECTED: 'approval request was rejected by the operator',
  EXPIRED: 'approval request expired before it was answered (fail closed)',
  NOT_APPROVED_AFTER_TTL: 'approval arrived after expiresAt and must not be executed (fail closed)',
  NO_CHANNEL: 'no approval channel is waiting for this request in this process (fail closed)',
  ALREADY_RELEASED: 'this approval has already been released: a second release would double-execute (fail closed)',
  STORE_UNAVAILABLE: 'approval store is unreachable: refusing to release the action (fail closed)',
  CHANNEL_UNAVAILABLE: 'approval channel could not deliver the request (fail closed)',
} as const;

export type GateRefusalReason = (typeof GATE_REFUSAL_REASONS)[keyof typeof GATE_REFUSAL_REASONS];

/**
 * Refusals that the gate itself records because the channel or the store failed — as opposed to an
 * operator pressing Reject. Both surface as `status = rejected` (nothing ran), but the gate
 * re-reports the real cause instead of blaming the operator.
 */
const CHANNEL_FAILURE_REASONS: readonly string[] = [
  GATE_REFUSAL_REASONS.CHANNEL_UNAVAILABLE,
  GATE_REFUSAL_REASONS.STORE_UNAVAILABLE,
];

/**
 * `decidedBy` values that are NOT a human identity. A refusal carrying one of these means the
 * channel itself gave up (no token, unreachable API, no-op notifier), not that an operator said no —
 * and the two must be distinguishable in the audit trail.
 */
const NON_OPERATOR_DECIDERS: readonly string[] = ['approval-gate', 'noop-notifier', 'telegram-notifier'];

function isOperatorIdentity(decidedBy: string): boolean {
  return !NON_OPERATOR_DECIDERS.includes(decidedBy);
}

export type GateOutcome<T> =
  | {
      readonly approved: true;
      readonly request: ApprovalRequest;
      readonly decision: ApprovalDecision;
      readonly value: T;
    }
  | {
      readonly approved: false;
      readonly request: ApprovalRequest | null;
      readonly decision: ApprovalDecision;
      /** Machine-readable category of the refusal. */
      readonly reason: GateRefusalReason;
      /**
       * The reason as recorded on the decision, verbatim. A refusal caused by a channel failure
       * (not an operator) is distinguishable here: the category is `REJECTED` because nothing ran,
       * but this says the operator never answered.
       */
      readonly recordedReason: string;
    };

export interface ApprovalGateOptions {
  /** The approval channel. With `noopNotifier` no request can ever be approved (§96). */
  readonly notifier: Notifier;
  /** `StrategyConfig.approvals.timeoutMinutes` → the TTL of every request. */
  readonly timeoutMinutes: number;
  /** Defaults to an in-memory store (tests / read-only runs create no file). */
  readonly store?: ApprovalStore;
  readonly audit?: DecisionLogSink;
  readonly logger?: LoggerLike;
  readonly now?: () => number;
  readonly newRequestId?: () => string;
  /**
   * Optional hook called synchronously when a request is created, e.g. to emit a CRITICAL alert
   * through the same notifier. Rejections are logged and never affect the decision.
   */
  readonly onRequested?: (kind: ApprovalKind, request: ApprovalRequest) => void;
}

/** Bot state recorded in the §77 log for each gated action (§44 state machine). */
const STATE_BY_KIND: Readonly<Record<ApprovalKind, BotState>> = {
  [APPROVAL_KINDS.BUILD_POSITION]: BOT_STATES.PREPARE_POSITION,
  [APPROVAL_KINDS.SWITCH_POOL]: BOT_STATES.SWITCH_POOL,
};

function stateFor(kind: ApprovalKind): BotState {
  return STATE_BY_KIND[kind] ?? BOT_STATES.RISK_REVIEW;
}

/** Metadata carried by a request. `json` must never contain a key, passphrase or signature. */
export interface ApprovalPayload {
  readonly summary: string;
  readonly json: Readonly<Record<string, unknown>>;
}

/**
 * Serialises `BUILD_POSITION` / `SWITCH_POOL` behind a persisted human approval.
 *
 * Usage (the executor calls exactly this):
 * ```ts
 * const request = await gate.request(kind, { summary, json });   // records + publishes
 * const outcome = await gate.gate(kind, request.id, () => executor.build());
 * if (!outcome.approved) return;                                  // nothing was executed
 * ```
 */
export class ApprovalGate {
  private readonly notifier: Notifier;
  private readonly timeoutMinutes: number;
  private readonly store: ApprovalStore;
  private readonly audit: DecisionLogSink | undefined;
  private readonly logger: LoggerLike;
  private readonly nowMs: () => number;
  private readonly newRequestId: () => string;
  private readonly onRequested: ((kind: ApprovalKind, request: ApprovalRequest) => void) | undefined;

  /** In-flight publication per request id (so a request is never published twice). */
  private readonly deliveries = new Map<string, Promise<void>>();
  /** Settlement of a request: the decision plus the persisted final state. */
  private readonly settlements = new Map<string, Settlement>();
  /** Waiters blocked in `gate()`/`awaitDecision()`. */
  private readonly waiters = new Map<string, ((settlement: Settlement) => void)[]>();
  /** Request ids currently being released (claimed before any await, cleared in `finally`). */
  private readonly inflight = new Set<string>();
  /** Request ids whose action has already run — a second release would double-execute. */
  private readonly released = new Set<string>();

  constructor(options: ApprovalGateOptions) {
    this.notifier = options.notifier;
    this.timeoutMinutes = Math.max(1, options.timeoutMinutes);
    this.store = options.store ?? new InMemoryApprovalStore();
    this.audit = options.audit;
    this.logger = options.logger ?? defaultLogger;
    this.nowMs = options.now ?? (() => Date.now());
    this.newRequestId = options.newRequestId ?? (() => `apr_${this.nowMs().toString(36)}_${randomSuffix()}`);
    this.onRequested = options.onRequested;
  }

  /** Idempotent DDL. Call once at startup (the migration registry may instead own it). */
  ensureSchema(): void {
    try {
      this.store.ensureSchema();
    } catch (error) {
      // Fatal on purpose: without the table nothing can be released (fail closed).
      throw new ApprovalStoreError(
        `could not create the ${APPROVAL_REQUESTS_TABLE} table: ${errorMessage(error)}`,
        error,
      );
    }
  }

  /** Default TTL in milliseconds, from `approvals.timeoutMinutes`. */
  get ttlMs(): number {
    return this.timeoutMinutes * 60_000;
  }

  /**
   * Record a new pending request and start publishing it to the approval channel (in the
   * background — the caller must not have to wait for a human before it can call `gate()`).
   *
   * Returns `null` when the store refuses the write: no persisted request means nothing can ever be
   * released for it, which is the fail-closed outcome rather than an exception the caller could
   * accidentally treat as "carry on".
   */
  async request(kind: ApprovalKind, payload: ApprovalPayload): Promise<ApprovalRequest | null> {
    const createdAt = new Date(this.nowMs()).toISOString();
    const expiresAt = new Date(this.nowMs() + this.ttlMs).toISOString();
    let id: string;
    try {
      id = this.newRequestId();
    } catch (error) {
      this.logger.error('approval gate: could not allocate a request id', { reason: errorMessage(error) });
      return null;
    }
    const request: ApprovalRequest = {
      id,
      kind,
      createdAt,
      expiresAt,
      payloadSummary: payload.summary,
      payloadJson: payload.json,
      status: APPROVAL_STATUSES.PENDING,
    };

    try {
      this.store.insert({
        id: request.id,
        kind,
        status: APPROVAL_STATUSES.PENDING,
        createdAt: request.createdAt,
        expiresAt: request.expiresAt,
        payloadSummary: payload.summary,
        payloadJson: payload.json,
      });
    } catch (error) {
      // A duplicate id is a bug in the id source, not a reason to reuse someone else's approval.
      this.logger.error('approval gate: could not persist the request (fail closed)', {
        requestId: request.id,
        reason: errorMessage(error),
      });
      this.emitAudit({
        timestamp: createdAt,
        state: stateFor(kind),
        action: APPROVAL_ACTIONS.STORE_UNAVAILABLE,
        reason: errorMessage(error),
        result: 'blocked_fail_closed',
        detail: { requestId: request.id, kind },
      });
      return null;
    }

    this.emitAudit({
      timestamp: createdAt,
      state: stateFor(kind),
      action: APPROVAL_ACTIONS.REQUESTED,
      reason: `awaiting human confirmation for ${kind} until ${expiresAt}`,
      result: 'pending_approval',
      detail: { requestId: request.id, kind, expiresAt },
    });
    try {
      this.onRequested?.(kind, request);
    } catch (error) {
      this.logger.warn('approval gate: onRequested hook failed', { reason: errorMessage(error) });
    }
    this.publish(request);
    return request;
  }

  /**
   * Wait for the decision on an already-persisted request. Resolves with the final record (or
   * `null` when the store is unreachable). Never throws: a missing answer is a refusal.
   */
  async awaitDecision(requestId: string): Promise<StoredApprovalRequest | null> {
    const settled = this.settlements.get(requestId);
    if (settled !== undefined) {
      return settled.record;
    }
    let current: StoredApprovalRequest | null;
    try {
      current = this.store.get(requestId);
    } catch (error) {
      this.logger.error('approval gate: store read failed (fail closed)', {
        requestId,
        reason: errorMessage(error),
      });
      return null;
    }
    if (current === null) {
      return null;
    }
    if (current.status !== APPROVAL_STATUSES.PENDING) {
      return current;
    }
    if (current.expiresAt <= new Date(this.nowMs()).toISOString()) {
      return this.expireNow(current);
    }
    if (!this.deliveries.has(requestId)) {
      // Nothing in this process is listening for an answer, so waiting would only delay the
      // inevitable refusal. Refuse now (fail closed) instead of holding the executor.
      this.logger.warn('approval gate: no approval channel is waiting for this request', { requestId });
      return current;
    }
    // A reply always wins the race; only the TTL may end the wait without one. The wait is capped at
    // `expiresAt`, so a channel that swallows its own timeout cannot hold the gate open.
    const ttlMs = Math.max(0, Date.parse(current.expiresAt) - this.nowMs());
    const settlement = await withDeadline(this.waitForSettlement(requestId), ttlMs);
    if (!settlement.timedOut) {
      return settlement.value.record;
    }
    this.logger.warn('approval gate: no answer before expiresAt (fail closed)', { requestId });
    return this.expireNow(current);
  }

  /**
   * **The release path.** Runs `run` only when the persisted request is `approved` and still inside
   * its TTL; every other outcome returns `approved: false` and leaves `run` untouched.
   */
  async gate<T>(
    kind: ApprovalKind,
    requestId: string,
    run: () => T | Promise<T>,
  ): Promise<GateOutcome<T>> {
    const refuse = (
      reason: GateRefusalReason,
      request: ApprovalRequest | null,
      decidedBy: string,
      recordedReason?: string,
    ): GateOutcome<T> => {
      this.emitAudit({
        timestamp: new Date(this.nowMs()).toISOString(),
        state: stateFor(kind),
        action: APPROVAL_ACTIONS.GATE_BLOCKED,
        reason,
        result: 'blocked_fail_closed',
        detail: { requestId, kind },
      });
      const recorded = recordedReason ?? reason;
      return {
        approved: false,
        request,
        reason,
        recordedReason: recorded,
        decision: {
          requestId,
          approved: false,
          decidedBy,
          decidedAt: new Date(this.nowMs()).toISOString(),
          reason: recorded,
        },
      };
    };

    let record: StoredApprovalRequest | null;
    try {
      record = this.store.get(requestId);
    } catch (error) {
      this.logger.error('approval gate: store read failed (fail closed)', {
        requestId,
        reason: errorMessage(error),
      });
      return refuse(GATE_REFUSAL_REASONS.STORE_UNAVAILABLE, null, 'approval-gate');
    }
    if (record === null) {
      return refuse(GATE_REFUSAL_REASONS.UNKNOWN_REQUEST, null, 'approval-gate');
    }
    if (record.kind !== kind) {
      return refuse(GATE_REFUSAL_REASONS.WRONG_KIND, toContractRequest(record), record.decidedBy ?? 'approval-gate');
    }
    // §97: an approval releases its action at most once. The in-process claim is taken
    // synchronously before any await, and `releasedAt` is the durable (survives restart) marker.
    if (this.inflight.has(requestId) || this.released.has(requestId) || record.releasedAt !== undefined) {
      return refuse(
        GATE_REFUSAL_REASONS.ALREADY_RELEASED,
        toContractRequest(record),
        record.decidedBy ?? 'approval-gate',
      );
    }
    this.inflight.add(requestId);
    try {
      return await this.release(kind, requestId, record, run, refuse);
    } finally {
      this.inflight.delete(requestId);
    }
  }

  /** Body of `gate()` once the one-shot claim is held. Never runs `run` without an approval. */
  private async release<T>(
    kind: ApprovalKind,
    requestId: string,
    initial: StoredApprovalRequest,
    run: () => T | Promise<T>,
    refuse: (
      reason: GateRefusalReason,
      request: ApprovalRequest | null,
      decidedBy: string,
      recordedReason?: string,
    ) => GateOutcome<T>,
  ): Promise<GateOutcome<T>> {
    let record = initial;
    if (record.status === APPROVAL_STATUSES.PENDING) {
      const settled = await this.awaitDecision(requestId);
      if (settled !== null) {
        record = settled;
      }
    }

    const contractRequest = toContractRequest(record);
    const decidedBy = record.decidedBy ?? 'approval-gate';
    const now = new Date(this.nowMs()).toISOString();

    if (record.status === APPROVAL_STATUSES.PENDING) {
      // A live channel either settles the request or lets `awaitDecision` expire it, so reaching
      // here means no channel is holding this id at all: nothing will ever answer it.
      return refuse(GATE_REFUSAL_REASONS.NO_CHANNEL, contractRequest, decidedBy);
    }
    if (record.status === APPROVAL_STATUSES.REJECTED) {
      // `rejected` covers three different things and the audit trail must say which one happened:
      //   1. a store failure we recorded ourselves (the stored reason names it exactly),
      //   2. the channel giving up — no token, 5xx, timeout, no-op notifier (never a human identity),
      //   3. an operator pressing Reject.
      const recordedFailure = CHANNEL_FAILURE_REASONS.find((reason) => reason === record.reason);
      if (recordedFailure !== undefined) {
        return refuse(recordedFailure as GateRefusalReason, contractRequest, decidedBy, record.reason);
      }
      if (!isOperatorIdentity(decidedBy)) {
        return refuse(GATE_REFUSAL_REASONS.CHANNEL_UNAVAILABLE, contractRequest, decidedBy, record.reason);
      }
      return refuse(GATE_REFUSAL_REASONS.REJECTED, contractRequest, decidedBy, record.reason);
    }
    if (record.status === APPROVAL_STATUSES.EXPIRED) {
      return refuse(GATE_REFUSAL_REASONS.EXPIRED, contractRequest, decidedBy);
    }
    // status === approved. The TTL is part of the contract: an approval that arrived after
    // `expiresAt` must not be executed.
    if (record.expiresAt <= now) {
      const expired = this.expireNow(record);
      return refuse(GATE_REFUSAL_REASONS.NOT_APPROVED_AFTER_TTL, toContractRequest(expired ?? record), decidedBy);
    }

    const decision: ApprovalDecision = {
      requestId,
      approved: true,
      decidedBy,
      decidedAt: record.decidedAt ?? now,
      ...(record.reason === undefined ? {} : { reason: record.reason }),
    };
    this.emitAudit({
      timestamp: now,
      state: stateFor(kind),
      action: APPROVAL_ACTIONS.GATE_ALLOWED,
      reason: `approved by ${decidedBy}`,
      result: 'approved',
      detail: { requestId, kind, expiresAt: record.expiresAt },
    });

    // Claimed before the side effect: once `released_at` is stamped (or the in-memory claim taken),
    // this approval can never release another action — not after a crash, not after a restart.
    let claimed = false;
    try {
      claimed = this.store.claimRelease(requestId, now).claimed;
    } catch (error) {
      this.logger.error('approval gate: could not record the release claim (fail closed)', {
        requestId,
        reason: errorMessage(error),
      });
      return refuse(GATE_REFUSAL_REASONS.STORE_UNAVAILABLE, contractRequest, decidedBy);
    }
    if (!claimed) {
      // Another actor won the claim: this request was already released elsewhere.
      return refuse(GATE_REFUSAL_REASONS.ALREADY_RELEASED, contractRequest, decidedBy);
    }
    this.released.add(requestId);
    try {
      const value = await run();
      return { approved: true, request: contractRequest, decision, value };
    } catch (error) {
      this.emitAudit({
        timestamp: new Date(this.nowMs()).toISOString(),
        state: stateFor(kind),
        action: APPROVAL_ACTIONS.RUN_FAILED,
        reason: errorMessage(error),
        result: 'failed',
        detail: { requestId, kind },
      });
      throw error;
    }
  }

  /** Create a request and gate `run` on it in one call (the common executor shape). */
  async requestAndGate<T>(
    kind: ApprovalKind,
    payload: ApprovalPayload,
    run: () => T | Promise<T>,
  ): Promise<GateOutcome<T>> {
    const request = await this.request(kind, payload);
    if (request === null) {
      return {
        approved: false,
        request: null,
        reason: GATE_REFUSAL_REASONS.STORE_UNAVAILABLE,
        recordedReason: GATE_REFUSAL_REASONS.STORE_UNAVAILABLE,
        decision: {
          requestId: '',
          approved: false,
          decidedBy: 'approval-gate',
          decidedAt: new Date(this.nowMs()).toISOString(),
          reason: GATE_REFUSAL_REASONS.STORE_UNAVAILABLE,
        },
      };
    }
    return await this.gate(kind, request.id, run);
  }

  /** Await the in-flight publication of a request (ops/tests; never throws). */
  async awaitDelivery(requestId: string): Promise<void> {
    const delivery = this.deliveries.get(requestId);
    if (delivery === undefined) {
      return;
    }
    await delivery;
  }

  /** Persisted state of one request, or `null` when it is unknown/unreadable. */
  getRequest(requestId: string): StoredApprovalRequest | null {
    try {
      return this.store.get(requestId);
    } catch (error) {
      this.logger.error('approval gate: store read failed', { requestId, reason: errorMessage(error) });
      return null;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------------------------

  /** Publish to the channel, then settle exactly once. Never rejects. */
  private publish(request: ApprovalRequest): void {
    if (this.deliveries.has(request.id)) {
      this.logger.warn('approval gate: request already published, ignoring duplicate publish', {
        requestId: request.id,
      });
      return;
    }
    const delivery = this.deliver(request);
    this.deliveries.set(request.id, delivery);
  }

  /** Resolve when the settlement for `requestId` lands (only ever called with a live delivery). */
  private waitForSettlement(requestId: string): Promise<Settlement> {
    return new Promise<Settlement>((resolve) => {
      const list = this.waiters.get(requestId) ?? [];
      list.push(resolve);
      this.waiters.set(requestId, list);
    });
  }

  private async deliver(request: ApprovalRequest): Promise<void> {
    // `requestApproval` is invoked synchronously so the channel is listening before the caller can
    // possibly call `gate()`.
    const decisionPromise = this.notifier.requestApproval(request);
    try {
      const decision = await decisionPromise;
      this.settle(request, decision);
    } catch (error) {
      // The contract says `requestApproval` never throws, but a broken implementation must still
      // not release anything: an error means "no answer".
      this.logger.error('approval gate: notifier threw instead of refusing (fail closed)', {
        requestId: request.id,
        reason: errorMessage(error),
      });
      this.settle(request, {
        requestId: request.id,
        approved: false,
        decidedBy: 'approval-gate',
        decidedAt: new Date(this.nowMs()).toISOString(),
        reason: GATE_REFUSAL_REASONS.CHANNEL_UNAVAILABLE,
      });
    }
  }

  /** Apply a decision to the persisted record and wake any waiter. Runs at most once per request. */
  private settle(request: ApprovalRequest, decision: ApprovalDecision): void {
    if (request.id !== decision.requestId) {
      this.logger.error('approval gate: decision does not match the request id (fail closed)', {
        requestId: request.id,
      });
      return;
    }
    if (this.settlements.has(request.id)) {
      this.emitAudit({
        timestamp: new Date(this.nowMs()).toISOString(),
        state: stateFor(request.kind),
        action: APPROVAL_ACTIONS.RUN_DUPLICATE_DECISION,
        reason: 'a second decision was ignored; the first one stands',
        result: 'blocked_differs',
        detail: { requestId: request.id },
      });
      return;
    }
    const now = new Date(this.nowMs()).toISOString();
    const late = decision.approved && request.expiresAt <= now;
    const approved = decision.approved && !late;
    const reason = late
      ? GATE_REFUSAL_REASONS.NOT_APPROVED_AFTER_TTL
      : decision.reason ?? (approved ? 'approved' : 'rejected');
    const settled: StoredApprovalRequest = {
      id: request.id,
      kind: request.kind,
      status: approved ? APPROVAL_STATUSES.APPROVED : APPROVAL_STATUSES.REJECTED,
      createdAt: request.createdAt,
      expiresAt: request.expiresAt,
      decidedAt: decision.decidedAt,
      decidedBy: decision.decidedBy,
      reason,
      payloadSummary: request.payloadSummary,
      payloadJson: request.payloadJson,
    };

    let persisted = settled;
    try {
      const result = this.store.decide(request.id, {
        approved,
        decidedBy: decision.decidedBy,
        decidedAt: decision.decidedAt,
        reason,
      });
      if (result.record !== null) {
        persisted = result.record;
      }
      if (!result.applied) {
        this.emitAudit({
          timestamp: now,
          state: stateFor(request.kind),
          action: APPROVAL_ACTIONS.RUN_DUPLICATE_DECISION,
          reason: 'the request was already decided; the first decision stands',
          result: 'blocked_differs',
          detail: { requestId: request.id },
        });
      }
    } catch (error) {
      // Persistence failed: the decision cannot be trusted, and after a restart it will not exist
      // at all. Keep it in memory as a refusal so this process still fails closed.
      this.logger.error('approval gate: could not persist the decision (fail closed)', {
        requestId: request.id,
        reason: errorMessage(error),
      });
      persisted = { ...settled, status: APPROVAL_STATUSES.REJECTED, reason: GATE_REFUSAL_REASONS.STORE_UNAVAILABLE };
      this.emitAudit({
        timestamp: now,
        state: stateFor(request.kind),
        action: APPROVAL_ACTIONS.STORE_UNAVAILABLE,
        reason: GATE_REFUSAL_REASONS.STORE_UNAVAILABLE,
        result: 'blocked_fail_closed',
        detail: { requestId: request.id, kind: request.kind, error: errorMessage(error) },
      });
    }

    this.settlements.set(request.id, { record: persisted });
    const waiters = this.waiters.get(request.id) ?? [];
    this.waiters.delete(request.id);
    for (const waiter of waiters) {
      waiter({ record: persisted });
    }

    this.emitAudit({
      timestamp: persisted.decidedAt ?? now,
      state: stateFor(request.kind),
      action:
        persisted.status === APPROVAL_STATUSES.APPROVED
          ? APPROVAL_ACTIONS.APPROVED
          : persisted.status === APPROVAL_STATUSES.EXPIRED
            ? APPROVAL_ACTIONS.EXPIRED
            : APPROVAL_ACTIONS.REJECTED,
      reason: persisted.reason ?? '',
      result: persisted.status,
      detail: {
        requestId: request.id,
        kind: request.kind,
        decidedBy: persisted.decidedBy ?? '',
      },
    });
  }

  /** `pending → expired` through the store, auditing the transition once. */
  private expireNow(record: StoredApprovalRequest): StoredApprovalRequest | null {
    const now = new Date(this.nowMs()).toISOString();
    try {
      const result = this.store.expire(record.id, now);
      const final = result.record ?? record;
      if (result.applied) {
        this.settlements.set(record.id, { record: final });
        const waiters = this.waiters.get(record.id) ?? [];
        this.waiters.delete(record.id);
        for (const waiter of waiters) {
          waiter({ record: final });
        }
        this.emitAudit({
          timestamp: now,
          state: stateFor(record.kind),
          action: APPROVAL_ACTIONS.EXPIRED,
          reason: `no answer before ${record.expiresAt}`,
          result: 'expired',
          detail: { requestId: record.id, kind: record.kind },
        });
      }
      return final;
    } catch (error) {
      this.logger.error('approval gate: could not persist the expiry (fail closed)', {
        requestId: record.id,
        reason: errorMessage(error),
      });
      return { ...record, status: APPROVAL_STATUSES.EXPIRED, reason: GATE_REFUSAL_REASONS.EXPIRED };
    }
  }

  private emitAudit(record: Omit<DecisionLog, 'result'> & { result: string }): void {
    const sink = this.audit;
    if (sink === undefined) {
      return;
    }
    try {
      sink.append(record as DecisionLog);
    } catch (error) {
      this.logger.error('approval gate: audit sink rejected a record', { reason: errorMessage(error) });
    }
  }
}

/** Outcome of a request: the final persisted record (the decision is derivable from it). */
interface Settlement {
  readonly record: StoredApprovalRequest | null;
}

/** Thrown only for a fatal, non-recoverable store problem at startup. */
export class ApprovalStoreError extends Error {
  override readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'ApprovalStoreError';
    this.cause = cause;
  }
}

/**
 * **Wiring point for StateStore / the composition root.**
 *
 * Builds a gate backed by the real `approval_requests` table in `data/lptrader.db`. The schema is
 * created by an idempotent `CREATE TABLE IF NOT EXISTS` (`APPROVAL_REQUESTS_MIGRATION` carries the
 * same DDL for StateStore's migration registry); `StateStore.openDatabase()`'s `DatabaseSync`
 * handle satisfies `SqliteDatabaseLike` structurally, so no import from the store slice is needed.
 *
 * Example:
 * ```ts
 * const db = openDatabase();                       // StateStore (T11)
 * const gate = createSqliteApprovalGate(db, { notifier, timeoutMinutes: config.approvals.timeoutMinutes });
 * ```
 */
export function createSqliteApprovalGate(
  db: SqliteDatabaseLike,
  options: Omit<ApprovalGateOptions, 'store'>,
): ApprovalGate {
  const gate = new ApprovalGate({ ...options, store: new SqliteApprovalStore(db) });
  gate.ensureSchema();
  return gate;
}

function toContractRequest(record: StoredApprovalRequest): ApprovalRequest {
  return {
    id: record.id,
    kind: record.kind,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    payloadSummary: record.payloadSummary,
    payloadJson: record.payloadJson,
    status: record.status,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Resolve `promise` or give up after `ms`, reporting which happened. Used so that no wait in this
 * slice can outlive its TTL — a notifier (or a network call) that never answers must not be able to
 * hold a write path open.
 */
export async function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
): Promise<{ readonly timedOut: true } | { readonly timedOut: false; readonly value: T }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ readonly timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), Math.max(ms, 0));
  });
  try {
    return await Promise.race([
      promise.then((value) => ({ timedOut: false as const, value })),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function randomSuffix(): string {
  return Math.floor(Math.random() * 0xffff_ffff)
    .toString(36)
    .padStart(7, '0');
}
