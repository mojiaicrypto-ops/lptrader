/**
 * Registers the approval-gate table with StateStore's migration registry (T11).
 *
 * **Import this module for its side effect** from the composition root, before `openDatabase()`:
 *
 * ```ts
 * import '../execution/approvalMigration.ts';           // registers version 100
 * import { openDatabase } from '../store/db.ts';
 * import { ApprovalGate, SqliteApprovalStore, stateStoreDecisionLogSink } from './approvalGate.ts';
 *
 * const db = openDatabase();                            // applies all registered migrations
 * const gate = new ApprovalGate({
 *   notifier: createNotifierFromConfig(config, env),
 *   timeoutMinutes: config.approvals.timeoutMinutes,
 *   store: new SqliteApprovalStore(db),
 *   audit: stateStoreDecisionLogSink(new StateStore(db)),
 * });
 * ```
 *
 * The registration lives in its own module on purpose: `approvalGate.ts` stays free of any store
 * import (it only needs a structural `SqliteDatabaseLike`), so the gate is usable with a bare
 * `node:sqlite` handle and in tests without pulling in the whole store layer. Version 100 is the
 * range StateStore reserves for other modules (their core is 1..99), so the two can never collide;
 * `applyMigrations` sorts by version, so registering 100 before or after 1..N makes no difference.
 *
 * The import is not load-bearing for correctness — every StateStore constructor re-runs
 * `applyMigrations`, so a handle opened earlier still self-heals — but importing it up front keeps
 * `openDatabase()` the single place where schema state is established.
 */
import { registerMigration, type Database } from '../store/db.ts';
import {
  APPROVAL_REQUESTS_MIGRATION,
  APPROVAL_REQUESTS_TABLE,
  ensureApprovalRequestsSchema,
} from './approvalGate.ts';

/** The `approval_requests` DDL as a StateStore migration (`{version: 100, id: 'approval_requests'}`). */
export const APPROVAL_MIGRATION = {
  version: APPROVAL_REQUESTS_MIGRATION.version,
  id: APPROVAL_REQUESTS_TABLE,
  up: (db: Database): void => {
    ensureApprovalRequestsSchema(db);
  },
} as const;

registerMigration(APPROVAL_MIGRATION);
