/**
 * T13 — approval gate. No network, no chain: the "channel" is a scripted notifier and the store is
 * either in-memory or a real `node:sqlite` database opened in memory (`:memory:`), so the persisted
 * happy path is exercised for real without touching `data/lptrader.db`.
 *
 * The property under test is fail-closed: `run` must not be invoked unless a persisted request is
 * `approved` and still inside its TTL.
 */
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
// Side-effect import: registers `approval_requests` (version 100) with StateStore's migration
// registry, exactly as the composition root must do before opening the database.
import '../../src/execution/approvalMigration.ts';
import { listMigrations, openDatabase } from '../../src/store/db.ts';
import { StateStore } from '../../src/store/stateStore.ts';
import {
  APPROVAL_ACTIONS,
  APPROVAL_REQUESTS_MIGRATION,
  APPROVAL_REQUESTS_TABLE,
  ApprovalGate,
  GATE_REFUSAL_REASONS,
  InMemoryApprovalStore,
  SqliteApprovalStore,
  createSqliteApprovalGate,
  stateStoreDecisionLogSink,
  type ApprovalStore,
  type DecisionLogSink,
  type StoredApprovalRequest,
} from '../../src/execution/approvalGate.ts';
import { TelegramNotifier } from '../../src/notify/telegram.ts';
import { APPROVAL_KINDS, APPROVAL_STATUSES, noopNotifier } from '../../src/types/notifier.ts';
import type {
  ApprovalDecision,
  ApprovalRequest,
  Notifier,
} from '../../src/types/notifier.ts';
import type { DecisionLog } from '../../src/types/portfolio.ts';

const BUILD = APPROVAL_KINDS.BUILD_POSITION;
const SWITCH = APPROVAL_KINDS.SWITCH_POOL;

/** A channel whose behaviour each test scripts explicitly. */
class ScriptedNotifier implements Notifier {
  readonly requests: ApprovalRequest[] = [];
  readonly sent: { severity: string; title: string; body: string }[] = [];
  queries: string[] = [];
  private readonly answer: (request: ApprovalRequest) => Promise<ApprovalDecision>;

  constructor(answer: (request: ApprovalRequest) => Promise<ApprovalDecision>) {
    this.answer = answer;
  }

  async send(): Promise<void> {}
  async requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    this.requests.push(request);
    return await this.answer(request);
  }
  async query(question: string): Promise<string> {
    this.queries.push(question);
    return `answer:${question}`;
  }
}

/** Approves or rejects immediately, using the identity a Telegram user would carry. */
function decideImmediately(approved: boolean): Notifier {
  return new ScriptedNotifier(async (request) => ({
    requestId: request.id,
    approved,
    decidedBy: '4242',
    decidedAt: new Date().toISOString(),
    reason: approved ? 'approved in test' : 'rejected in test',
  }));
}

/** A channel that never answers and never fails (simulates a person who does not look at the phone). */
function neverAnswers(): Notifier {
  return new ScriptedNotifier(() => new Promise<ApprovalDecision>(() => {}));
}

function collectingSink(): { sink: DecisionLogSink; records: DecisionLog[] } {
  const records: DecisionLog[] = [];
  return { records, sink: { append: (record) => records.push(record) } };
}

/** A real `node:sqlite` database, in memory so no file is created next to the repository. */
function openMemoryDatabase(): DatabaseSync {
  return new DatabaseSync(':memory:');
}

describe('approval gate — fail closed release path', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refuses an unknown requestId and never invokes the action', async () => {
    const notifier = decideImmediately(true);
    const gate = new ApprovalGate({ notifier, timeoutMinutes: 30 });
    const run = vi.fn(() => 'executed');

    const outcome = await gate.gate(BUILD, 'apr_does_not_exist', run);

    expect(outcome.approved).toBe(false);
    expect(outcome.approved === false && outcome.reason).toBe(GATE_REFUSAL_REASONS.UNKNOWN_REQUEST);
    expect(outcome.request).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it('does not release an approved request that arrived before the request existed nowhere (no pending record)', async () => {
    // The gate is a second, empty process: the notifier is not holding the id either.
    const gate = new ApprovalGate({ notifier: decideImmediately(true), timeoutMinutes: 30 });
    const run = vi.fn(() => 'executed');

    const outcome = await gate.gate(SWITCH, 'apr_from_another_process', run);

    expect(outcome.approved).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses a pending request whose kind does not match the gated action', async () => {
    const gate = new ApprovalGate({ notifier: neverAnswers(), timeoutMinutes: 30 });
    const created = await gate.request(BUILD, { summary: 'build QQQB/USDC', json: { pool: 'p' } });
    expect(created).not.toBeNull();

    const run = vi.fn(() => 'executed');
    const outcome = await gate.gate(SWITCH, created?.id ?? '', run);

    expect(outcome.approved).toBe(false);
    expect(outcome.approved === false && outcome.reason).toBe(GATE_REFUSAL_REASONS.WRONG_KIND);
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects when the operator rejects, and never invokes the action', async () => {
    const gate = new ApprovalGate({ notifier: decideImmediately(false), timeoutMinutes: 30 });
    const created = await gate.request(BUILD, { summary: 'build', json: { notionalUsd: 7000 } });
    const run = vi.fn(() => 'executed');

    const outcome = await gate.gate(BUILD, created?.id ?? '', run);

    expect(outcome.approved).toBe(false);
    expect(outcome.approved === false && outcome.reason).toBe(GATE_REFUSAL_REASONS.REJECTED);
    expect(gate.getRequest(created?.id ?? '')?.status).toBe(APPROVAL_STATUSES.REJECTED);
    expect(run).not.toHaveBeenCalled();
  });

  it('expires a pending request at its TTL, persists `expired`, and does not release it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-29T00:00:00.000Z'));
    const { sink, records } = collectingSink();
    const gate = new ApprovalGate({ notifier: neverAnswers(), timeoutMinutes: 30, audit: sink });
    const created = await gate.request(BUILD, { summary: 'build', json: {} });
    const requestId = created?.id ?? '';
    expect(created?.expiresAt).toBe('2026-09-29T00:30:00.000Z');

    const run = vi.fn(() => 'executed');
    const pending = gate.gate(BUILD, requestId, run);
    await vi.advanceTimersByTimeAsync(0);
    // One second past the TTL: the gate must stop waiting and refuse.
    await vi.advanceTimersByTimeAsync(30 * 60_000 + 1_000);
    const outcome = await pending;

    expect(outcome.approved).toBe(false);
    expect(outcome.approved === false && outcome.reason).toBe(GATE_REFUSAL_REASONS.EXPIRED);
    expect(gate.getRequest(requestId)?.status).toBe(APPROVAL_STATUSES.EXPIRED);
    expect(run).not.toHaveBeenCalled();
    expect(records.map((record) => record.action)).toContain(APPROVAL_ACTIONS.EXPIRED);
  });

  it('never releases approved-after-TTL, and marks the request expired instead', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-29T00:00:00.000Z'));
    const gate = new ApprovalGate({ notifier: decideImmediately(true), timeoutMinutes: 30 });
    const created = await gate.request(BUILD, { summary: 'build', json: {} });
    const requestId = created?.id ?? '';
    await gate.awaitDelivery(requestId);
    expect(gate.getRequest(requestId)?.status).toBe(APPROVAL_STATUSES.APPROVED);

    // The executor only gets around to releasing it long after the window closed.
    vi.setSystemTime(new Date('2026-09-29T01:00:00.000Z'));
    const run = vi.fn(() => 'executed');
    const outcome = await gate.gate(BUILD, requestId, run);

    expect(outcome.approved).toBe(false);
    expect(outcome.approved === false && outcome.reason).toBe(GATE_REFUSAL_REASONS.NOT_APPROVED_AFTER_TTL);
    expect(gate.getRequest(requestId)?.status).toBe(APPROVAL_STATUSES.EXPIRED);
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses a pending request that this process is not waiting on, and never invokes the action', async () => {
    // A request persisted by a previous run (or another process): the row exists and is `pending`,
    // but no channel is holding it, so no answer can ever arrive.
    const store = new InMemoryApprovalStore();
    store.insert({
      id: 'apr_orphan',
      kind: BUILD,
      status: APPROVAL_STATUSES.PENDING,
      createdAt: '2026-09-29T00:00:00.000Z',
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      payloadSummary: 'build from a previous process',
      payloadJson: {},
    });
    const gate = new ApprovalGate({ notifier: neverAnswers(), timeoutMinutes: 30, store });
    const run = vi.fn(() => 'executed');

    const outcome = await gate.gate(BUILD, 'apr_orphan', run);

    expect(outcome.approved).toBe(false);
    expect(outcome.approved === false && outcome.reason).toBe(GATE_REFUSAL_REASONS.NO_CHANNEL);
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses a pending request whose channel is alive but silent, once the TTL closes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-29T00:00:00.000Z'));
    const gate = new ApprovalGate({ notifier: neverAnswers(), timeoutMinutes: 1, store: new InMemoryApprovalStore() });
    const created = await gate.request(BUILD, { summary: 'build', json: {} });
    const requestId = created?.id ?? '';
    const run = vi.fn(() => 'executed');

    const pending = gate.gate(BUILD, requestId, run);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    const outcome = await pending;

    expect(outcome.approved).toBe(false);
    expect(outcome.approved === false && outcome.reason).toBe(GATE_REFUSAL_REASONS.EXPIRED);
    expect(run).not.toHaveBeenCalled();
  });

  it('runs the action exactly once for an approved request and reports the value', async () => {
    const gate = new ApprovalGate({ notifier: decideImmediately(true), timeoutMinutes: 30 });
    const created = await gate.request(BUILD, {
      summary: 'build QQQB/USDC range 0.85-1.16',
      json: { amount0: '0', amount1: '7000000000000000000000' },
    });
    const run = vi.fn(() => 'tx:0xdeadbeef');

    const outcome = await gate.gate(BUILD, created?.id ?? '', run);

    expect(outcome.approved).toBe(true);
    expect(outcome.approved === true && outcome.value).toBe('tx:0xdeadbeef');
    expect(outcome.approved === true && outcome.decision.approved).toBe(true);
    expect(outcome.approved === true && outcome.decision.decidedBy).toBe('4242');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('refuses a second release of the same approval instead of executing twice (§97)', async () => {
    const gate = new ApprovalGate({ notifier: decideImmediately(true), timeoutMinutes: 30 });
    const created = await gate.request(BUILD, { summary: 'build', json: {} });
    const run = vi.fn(() => 'executed');

    const first = await gate.gate(BUILD, created?.id ?? '', run);
    const second = await gate.gate(BUILD, created?.id ?? '', run);

    expect(first.approved).toBe(true);
    expect(second.approved).toBe(false);
    expect(second.approved === false && second.reason).toBe(GATE_REFUSAL_REASONS.ALREADY_RELEASED);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('refuses concurrent releases of the same approval (no double execution)', async () => {
    const gate = new ApprovalGate({ notifier: decideImmediately(true), timeoutMinutes: 30 });
    const created = await gate.request(BUILD, { summary: 'build', json: {} });
    const requestId = created?.id ?? '';
    let release = (): void => {};
    const entered = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = vi.fn(async () => {
      await entered;
      return 'executed';
    });

    const first = gate.gate(BUILD, requestId, run);
    await vi.waitFor(() => {
      expect(run).toHaveBeenCalledTimes(1);
    });
    // The first release is inside `run`; the second must be refused immediately, not queued.
    const second = await gate.gate(BUILD, requestId, run);
    release();
    const firstOutcome = await first;

    expect(second.approved).toBe(false);
    expect(second.approved === false && second.reason).toBe(GATE_REFUSAL_REASONS.ALREADY_RELEASED);
    expect(firstOutcome.approved).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('propagates an action failure and still refuses a later release with the same approval', async () => {
    const { sink, records } = collectingSink();
    const gate = new ApprovalGate({ notifier: decideImmediately(true), timeoutMinutes: 30, audit: sink });
    const created = await gate.request(BUILD, { summary: 'build', json: {} });
    const requestId = created?.id ?? '';
    const run = vi.fn(() => {
      throw new Error('rpc exploded mid-build');
    });

    await expect(gate.gate(BUILD, requestId, run)).rejects.toThrow('rpc exploded mid-build');
    const again = await gate.gate(BUILD, requestId, run);

    expect(again.approved).toBe(false);
    expect(again.approved === false && again.reason).toBe(GATE_REFUSAL_REASONS.ALREADY_RELEASED);
    expect(run).toHaveBeenCalledTimes(1);
    expect(records.map((record) => record.action)).toContain(APPROVAL_ACTIONS.RUN_FAILED);
  });

  it('fails closed when the store cannot be read', async () => {
    const broken: ApprovalStore = {
      ensureSchema: () => {},
      insert: () => {},
      get: () => {
        throw new Error('SQLITE_IOERR: database disk image is malformed');
      },
      decide: () => ({ applied: false, record: null }),
      expire: () => ({ applied: false, record: null }),
      claimRelease: () => ({ claimed: false, record: null }),
    };
    const gate = new ApprovalGate({
      notifier: decideImmediately(true),
      timeoutMinutes: 30,
      store: broken,
    });
    const run = vi.fn(() => 'executed');

    const outcome = await gate.gate(BUILD, 'apr_1', run);

    expect(outcome.approved).toBe(false);
    expect(outcome.approved === false && outcome.reason).toBe(GATE_REFUSAL_REASONS.STORE_UNAVAILABLE);
    expect(run).not.toHaveBeenCalled();
  });

  it('fails closed when the decision cannot be persisted', async () => {
    class FailingDecideStore extends InMemoryApprovalStore {
      override decide(): { readonly applied: boolean; readonly record: StoredApprovalRequest | null } {
        throw new Error('SQLITE_FULL');
      }
    }
    const { sink, records } = collectingSink();
    const gate = new ApprovalGate({
      notifier: decideImmediately(true),
      timeoutMinutes: 30,
      store: new FailingDecideStore(),
      audit: sink,
    });
    const created = await gate.request(BUILD, { summary: 'build', json: {} });
    const run = vi.fn(() => 'executed');

    const outcome = await gate.gate(BUILD, created?.id ?? '', run);

    expect(outcome.approved).toBe(false);
    expect(outcome.approved === false && outcome.reason).toBe(GATE_REFUSAL_REASONS.STORE_UNAVAILABLE);
    expect(run).not.toHaveBeenCalled();
    expect(records.map((record) => record.action)).toContain(APPROVAL_ACTIONS.STORE_UNAVAILABLE);
  });

  it('refuses to release when the request could not be persisted at all', async () => {
    class FailingInsertStore extends InMemoryApprovalStore {
      override insert(): void {
        throw new Error('SQLITE_READONLY');
      }
    }
    const { sink, records } = collectingSink();
    const gate = new ApprovalGate({
      notifier: decideImmediately(true),
      timeoutMinutes: 30,
      store: new FailingInsertStore(),
      audit: sink,
    });

    const created = await gate.request(BUILD, { summary: 'build', json: {} });

    expect(created).toBeNull();
    expect(records.map((record) => record.action)).toContain(APPROVAL_ACTIONS.STORE_UNAVAILABLE);
  });

  it('does not release the same approval twice across a process restart (durable claim)', async () => {
    const db = openMemoryDatabase();
    const notifier = decideImmediately(true);

    // Process #1 approves and releases the action, then the process dies.
    const first = createSqliteApprovalGate(db, { notifier, timeoutMinutes: 30 });
    const created = await first.request(BUILD, { summary: 'build', json: {} });
    const requestId = created?.id ?? '';
    const runOne = vi.fn(() => 'first-process');
    expect((await first.gate(BUILD, requestId, runOne)).approved).toBe(true);
    expect(runOne).toHaveBeenCalledTimes(1);

    // Process #2 starts fresh (new gate, same database) and must not re-execute the approval.
    const second = createSqliteApprovalGate(db, { notifier, timeoutMinutes: 30 });
    const runTwo = vi.fn(() => 'second-process');
    const outcome = await second.gate(BUILD, requestId, runTwo);

    expect(outcome.approved).toBe(false);
    expect(outcome.approved === false && outcome.reason).toBe(GATE_REFUSAL_REASONS.ALREADY_RELEASED);
    expect(runTwo).not.toHaveBeenCalled();
    expect(second.getRequest(requestId)?.releasedAt).toBeDefined();
  });

  it('records the release claim in the stored row so it is auditable', () => {
    const db = openMemoryDatabase();
    const store = new SqliteApprovalStore(db);
    store.ensureSchema();
    store.insert({
      id: 'apr_claim_1',
      kind: BUILD,
      status: APPROVAL_STATUSES.APPROVED,
      createdAt: '2026-09-29T00:00:00.000Z',
      expiresAt: '2026-09-29T00:30:00.000Z',
      decidedAt: '2026-09-29T00:01:00.000Z',
      decidedBy: '4242',
      payloadSummary: 'build',
      payloadJson: {},
    });

    const first = store.claimRelease('apr_claim_1', '2026-09-29T00:02:00.000Z');
    const second = store.claimRelease('apr_claim_1', '2026-09-29T00:03:00.000Z');

    expect(first.claimed).toBe(true);
    expect(first.record?.releasedAt).toBe('2026-09-29T00:02:00.000Z');
    expect(second.claimed).toBe(false);
    // The first claim wins; a second attempt must not move the timestamp.
    expect(second.record?.releasedAt).toBe('2026-09-29T00:02:00.000Z');
  });

  it('fails closed when the release claim cannot be persisted', async () => {
    class FailingClaimStore extends InMemoryApprovalStore {
      override claimRelease(): { readonly claimed: boolean; readonly record: StoredApprovalRequest | null } {
        throw new Error('SQLITE_BUSY: database is locked');
      }
    }
    const { sink, records } = collectingSink();
    const gate = new ApprovalGate({
      notifier: decideImmediately(true),
      timeoutMinutes: 30,
      store: new FailingClaimStore(),
      audit: sink,
    });
    const created = await gate.request(BUILD, { summary: 'build', json: {} });
    const run = vi.fn(() => 'executed');

    const outcome = await gate.gate(BUILD, created?.id ?? '', run);

    expect(outcome.approved).toBe(false);
    expect(outcome.approved === false && outcome.reason).toBe(GATE_REFUSAL_REASONS.STORE_UNAVAILABLE);
    expect(run).not.toHaveBeenCalled();
    expect(records.map((record) => record.action)).toContain(APPROVAL_ACTIONS.GATE_BLOCKED);
  });

  it('never runs the action when another process wins the release claim (race)', async () => {
    // Two processes both see `approved, released_at IS NULL`; only one may stamp the claim. The
    // loser must refuse instead of executing the same approved action twice.
    class RacedClaimStore extends InMemoryApprovalStore {
      override claimRelease(): { readonly claimed: boolean; readonly record: StoredApprovalRequest | null } {
        return { claimed: false, record: null };
      }
    }
    const { sink, records } = collectingSink();
    const gate = new ApprovalGate({
      notifier: decideImmediately(true),
      timeoutMinutes: 30,
      store: new RacedClaimStore(),
      audit: sink,
    });
    const created = await gate.request(BUILD, { summary: 'build', json: {} });
    const run = vi.fn(() => 'executed');

    const outcome = await gate.gate(BUILD, created?.id ?? '', run);

    expect(outcome.approved).toBe(false);
    expect(outcome.approved === false && outcome.reason).toBe(GATE_REFUSAL_REASONS.ALREADY_RELEASED);
    expect(run).not.toHaveBeenCalled();
    expect(records.map((record) => record.action)).toContain(APPROVAL_ACTIONS.GATE_BLOCKED);
  });

  it('noopNotifier can never release a build or a switch', async () => {
    const gate = new ApprovalGate({ notifier: noopNotifier, timeoutMinutes: 30 });
    const run = vi.fn(() => 'executed');

    for (const kind of [BUILD, SWITCH]) {
      const created = await gate.request(kind, { summary: `payload for ${kind}`, json: {} });
      const outcome = await gate.gate(kind, created?.id ?? '', run);
      expect(outcome.approved).toBe(false);
      expect(outcome.approved === false && outcome.decision.approved).toBe(false);
    }
    expect(run).not.toHaveBeenCalled();
  });

  it('records every transition in the audit sink', async () => {
    const { sink, records } = collectingSink();
    const gate = new ApprovalGate({ notifier: decideImmediately(true), timeoutMinutes: 30, audit: sink });
    const created = await gate.request(BUILD, { summary: 'build', json: { pool: '56:pancakeswap-v3:0xpool' } });
    const requestId = created?.id ?? '';
    await gate.gate(BUILD, requestId, () => 'ok');

    const actions = records.map((record) => record.action);
    expect(actions).toEqual([
      APPROVAL_ACTIONS.REQUESTED,
      APPROVAL_ACTIONS.APPROVED,
      APPROVAL_ACTIONS.GATE_ALLOWED,
    ]);
    const allowed = records.at(-1);
    expect(allowed?.result).toBe('approved');
    expect(allowed?.state).toBe('PREPARE_POSITION');
    expect(allowed?.detail?.['requestId']).toBe(requestId);
  });

  it('ignores a second, differing decision for the same request and keeps the first', async () => {
    const later: ApprovalDecision[] = [];
    const notifier = new ScriptedNotifier(async (request) => {
      // A misbehaving channel decides twice: the first answer must win.
      later.push({
        requestId: request.id,
        approved: false,
        decidedBy: '4242',
        decidedAt: new Date().toISOString(),
        reason: 'late flip to reject',
      });
      return {
        requestId: request.id,
        approved: true,
        decidedBy: '4242',
        decidedAt: new Date().toISOString(),
        reason: 'first answer wins',
      };
    });
    const { sink, records } = collectingSink();
    const gate = new ApprovalGate({ notifier, timeoutMinutes: 30, audit: sink });
    const created = await gate.request(BUILD, { summary: 'build', json: {} });
    await gate.awaitDelivery(created?.id ?? '');

    expect(gate.getRequest(created?.id ?? '')?.status).toBe(APPROVAL_STATUSES.APPROVED);
    expect(later).toHaveLength(1);
    void later;
    expect(records.map((record) => record.action)).not.toContain(APPROVAL_ACTIONS.GATE_BLOCKED);
  });
});

describe('approval gate — persistence', () => {
  it('persists a request and its decision in the approval_requests table', () => {
    const db = openMemoryDatabase();
    const store = new SqliteApprovalStore(db);
    store.ensureSchema();
    // Idempotent: the composition root may call it on every start.
    store.ensureSchema();

    store.insert({
      id: 'apr_persist_1',
      kind: BUILD,
      status: APPROVAL_STATUSES.PENDING,
      createdAt: '2026-09-29T00:00:00.000Z',
      expiresAt: '2026-09-29T00:30:00.000Z',
      payloadSummary: 'build QQQB/USDC',
      payloadJson: { amount1: '7000000000000000000000', slippage: 0.003 },
    });

    expect(store.get('apr_persist_1')?.status).toBe(APPROVAL_STATUSES.PENDING);

    const first = store.decide('apr_persist_1', {
      approved: true,
      decidedBy: '4242',
      decidedAt: '2026-09-29T00:05:00.000Z',
      reason: 'ok',
    });
    // A second click must not overwrite the recorded decision.
    const second = store.decide('apr_persist_1', {
      approved: false,
      decidedBy: '9999',
      decidedAt: '2026-09-29T00:06:00.000Z',
      reason: 'double click',
    });

    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    const stored = store.get('apr_persist_1');
    expect(stored?.status).toBe(APPROVAL_STATUSES.APPROVED);
    expect(stored?.decidedBy).toBe('4242');
    expect(stored?.payloadJson).toEqual({ amount1: '7000000000000000000000', slippage: 0.003 });

    const rows = db
      .prepare(`SELECT COUNT(*) AS n FROM ${APPROVAL_REQUESTS_TABLE}`)
      .get() as { readonly n: number };
    expect(rows.n).toBe(1);
  });

  it('only expires a request whose expiresAt has passed', () => {
    const db = openMemoryDatabase();
    const store = new SqliteApprovalStore(db);
    store.ensureSchema();
    store.insert({
      id: 'apr_expire_1',
      kind: SWITCH,
      status: APPROVAL_STATUSES.PENDING,
      createdAt: '2026-09-29T00:00:00.000Z',
      expiresAt: '2026-09-29T00:30:00.000Z',
      payloadSummary: 'switch',
      payloadJson: {},
    });

    const tooEarly = store.expire('apr_expire_1', '2026-09-29T00:29:59.000Z');
    expect(tooEarly.applied).toBe(false);
    expect(tooEarly.record?.status).toBe(APPROVAL_STATUSES.PENDING);

    const onTime = store.expire('apr_expire_1', '2026-09-29T00:30:00.000Z');
    expect(onTime.applied).toBe(true);
    expect(onTime.record?.status).toBe(APPROVAL_STATUSES.EXPIRED);
  });

  it('exposes the schema as a StateStore migration (version >= 100) and builds a working gate', async () => {
    expect(APPROVAL_REQUESTS_MIGRATION.version).toBeGreaterThanOrEqual(100);
    expect(APPROVAL_REQUESTS_MIGRATION.id).toBe(APPROVAL_REQUESTS_TABLE);

    const db = openMemoryDatabase();
    // What the migration registry would do.
    APPROVAL_REQUESTS_MIGRATION.up(db);
    const gate = createSqliteApprovalGate(db, {
      notifier: decideImmediately(true),
      timeoutMinutes: 30,
    });
    const created = await gate.request(SWITCH, { summary: 'switch to Uniswap V3', json: {} });
    const run = vi.fn(() => 'switched');
    const outcome = await gate.gate(SWITCH, created?.id ?? '', run);

    expect(outcome.approved).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(gate.getRequest(created?.id ?? '')?.status).toBe(APPROVAL_STATUSES.APPROVED);
  });
});

/**
 * The real cross-slice wiring: StateStore's migration registry, its `decision_logs` table and its
 * `openDatabase()`. This is the integration the composition root will perform, so it is asserted
 * here rather than assumed.
 */
describe('approval gate — StateStore integration', () => {
  it("registers approval_requests in StateStore's migration registry and audits through it", async () => {
    const registered = listMigrations().find((migration) => migration.id === APPROVAL_REQUESTS_TABLE);
    expect(registered?.version).toBe(100);

    // `:memory:` keeps this test off `data/lptrader.db`; the real path is identical otherwise.
    const db = openDatabase(':memory:');
    const applied = db
      .prepare('SELECT version, id FROM schema_migrations WHERE id = ?')
      .all(APPROVAL_REQUESTS_TABLE);
    expect(applied).toHaveLength(1);

    const store = new StateStore(db);
    const gate = new ApprovalGate({
      notifier: noopNotifier,
      timeoutMinutes: 1,
      store: new SqliteApprovalStore(db),
      audit: stateStoreDecisionLogSink(store),
    });
    const request = await gate.request(BUILD, { summary: 'smoke build', json: { capitalUsd: 7000 } });
    const run = vi.fn(() => 'executed');
    const outcome = await gate.gate(BUILD, request?.id ?? '', run);

    // noopNotifier → refused, and the whole chain (table + §77 decision log) recorded it.
    expect(outcome.approved).toBe(false);
    expect(run).not.toHaveBeenCalled();
    const rows = db
      .prepare(`SELECT status FROM ${APPROVAL_REQUESTS_TABLE} WHERE id = ?`)
      .all(request?.id ?? '');
    expect(rows[0]?.['status']).toBe(APPROVAL_STATUSES.REJECTED);

    const logs = store.listDecisionLogs();
    const actions = logs.map((log) => log.action);
    expect(actions).toContain(APPROVAL_ACTIONS.REQUESTED);
    expect(actions).toContain(APPROVAL_ACTIONS.GATE_BLOCKED);
    const requested = logs.find((log) => log.action === APPROVAL_ACTIONS.REQUESTED);
    // The §77 row carries a real §44 state and the request id in `detail`.
    expect(requested?.state).toBe('PREPARE_POSITION');
    expect(requested?.detail?.['requestId']).toBe(request?.id);
  });
});

/**
 * The production path end to end: a real `TelegramNotifier` in front of the gate, driven by injected
 * Bot API responses. This is the only place both slices are exercised together, so it is where a
 * wiring mistake between them would show up.
 */
describe('approval gate — Telegram wiring end to end', () => {
  const FAKE_TOKEN = '123456:TEST-TOKEN-NOT-REAL';
  const CHAT = '424242';

  function telegramHarness(allowed: readonly number[]): { readonly notifier: TelegramNotifier } {
    // Canned Bot API: `sendMessage` and the callback plumbing succeed; nothing is fetched.
    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = url.slice(url.lastIndexOf('/') + 1);
      if (method === 'sendMessage') {
        return new Response(
          JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: Number(CHAT) } } }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    };
    const notifier = new TelegramNotifier({
      botToken: FAKE_TOKEN,
      chatId: CHAT,
      allowedUserIds: allowed,
      fetchImpl,
      apiBaseUrl: 'https://telegram.invalid',
    });
    return { notifier };
  }

  it('releases a build only after the allowed operator clicks Approve in Telegram', async () => {
    const { notifier } = telegramHarness([7]);
    const gate = new ApprovalGate({ notifier, timeoutMinutes: 30 });
    const run = vi.fn(() => 'tx:0xbuild');

    const request = await gate.request(BUILD, { summary: 'build QQQB/USDC', json: { capitalUsd: 7000 } });
    const outcomePromise = gate.gate(BUILD, request?.id ?? '', run);
    // The operator taps Approve.
    await notifier.handleUpdate({
      update_id: 1,
      callback_query: {
        id: 'cb1',
        from: { id: 7, is_bot: false },
        data: `approve:${request?.id ?? ''}`,
        message: { message_id: 1, chat: { id: Number(CHAT) } },
      },
    });
    const outcome = await outcomePromise;

    expect(outcome.approved).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(gate.getRequest(request?.id ?? '')?.decidedBy).toBe('7');
  });

  it('does not run a build when the click comes from a non-whitelisted Telegram user', async () => {
    const { notifier } = telegramHarness([7]);
    const gate = new ApprovalGate({ notifier, timeoutMinutes: 1 });
    const run = vi.fn(() => 'tx:0xbuild');

    const request = await gate.request(BUILD, { summary: 'build QQQB/USDC', json: {} });
    const outcomePromise = gate.gate(BUILD, request?.id ?? '', run);
    // An intruder clicks Approve: the notifier ignores it, and the request stays pending until TTL.
    await notifier.handleUpdate({
      update_id: 1,
      callback_query: {
        id: 'cb_intruder',
        from: { id: 31337, is_bot: false },
        data: `approve:${request?.id ?? ''}`,
        message: { message_id: 1, chat: { id: Number(CHAT) } },
      },
    });
    expect(notifier.pendingCount).toBe(1);

    // Then the real operator rejects.
    await notifier.handleUpdate({
      update_id: 2,
      callback_query: {
        id: 'cb_operator',
        from: { id: 7, is_bot: false },
        data: `reject:${request?.id ?? ''}`,
        message: { message_id: 1, chat: { id: Number(CHAT) } },
      },
    });
    const outcome = await outcomePromise;

    expect(outcome.approved).toBe(false);
    expect(outcome.approved === false && outcome.decision.decidedBy).toBe('7');
    expect(run).not.toHaveBeenCalled();
  });

  it('blocks a switch when the Telegram channel cannot deliver the request (fail closed)', async () => {
    const failingFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ ok: false, error_code: 502, description: 'Bad Gateway' }), {
        status: 502,
      });
    const notifier = new TelegramNotifier({
      botToken: FAKE_TOKEN,
      chatId: CHAT,
      allowedUserIds: [7],
      fetchImpl: failingFetch,
      apiBaseUrl: 'https://telegram.invalid',
    });
    const gate = new ApprovalGate({ notifier, timeoutMinutes: 30 });
    const run = vi.fn(() => 'tx:0xswitch');

    const request = await gate.request(SWITCH, { summary: 'switch to PancakeSwap V3', json: {} });
    const outcome = await gate.gate(SWITCH, request?.id ?? '', run);

    expect(outcome.approved).toBe(false);
    expect(outcome.approved === false && outcome.reason).toBe(
      GATE_REFUSAL_REASONS.CHANNEL_UNAVAILABLE,
    );
    // The channel's own wording is preserved verbatim rather than flattened to the category.
    expect(outcome.approved === false && outcome.recordedReason).toContain('could not be delivered');
    expect(run).not.toHaveBeenCalled();
  });
});
