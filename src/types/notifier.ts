/**
 * §78 + approval gate contract.
 *
 * The Notifier is a PURE SIDE CHANNEL: it pushes alerts, answers queries and collects human
 * decisions. It MUST NOT send transactions, hold keys, or reach the chain — the executor is the
 * only component that reads an `ApprovalDecision` and then acts on it. Consequently nothing in
 * this file exposes a write/sign capability.
 */

export const ALERT_SEVERITIES = {
  INFO: 'info',
  WARNING: 'warning',
  CRITICAL: 'critical',
} as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[keyof typeof ALERT_SEVERITIES];

/**
 * User decision: only building a position and switching a pool require explicit human
 * confirmation. Collecting fees, exiting and risk operations stay automatic (§91).
 */
export const APPROVAL_KINDS = {
  BUILD_POSITION: 'BUILD_POSITION',
  SWITCH_POOL: 'SWITCH_POOL',
} as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[keyof typeof APPROVAL_KINDS];

export const APPROVAL_STATUSES = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
} as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[keyof typeof APPROVAL_STATUSES];

/**
 * A pending human approval. `payloadJson` is the canonical reviewable payload (planned token
 * amounts as raw strings, pool, range, slippage, price impact, estimated cost) so the human can
 * check the actual numbers; `payloadSummary` is the rendered one-message digest.
 */
export interface ApprovalRequest {
  /** Idempotency/audit key, also used to correlate the decision (§97). */
  readonly id: string;
  readonly kind: ApprovalKind;
  readonly createdAt: string;
  /** Past this instant the request is `expired` and must NOT be executed. */
  readonly expiresAt: string;
  readonly payloadSummary: string;
  /** `unknown` values only; must never contain a private key or passphrase. */
  readonly payloadJson: Readonly<Record<string, unknown>>;
  readonly status: ApprovalStatus;
}

export interface ApprovalDecision {
  readonly requestId: string;
  readonly approved: boolean;
  /** Telegram user id (or other channel identity) that decided. */
  readonly decidedBy: string;
  readonly decidedAt: string;
  readonly reason?: string;
}

export interface NotifyOptions {
  /** Collapse repeated identical alerts (e.g. per-pool warnings) on the channel side. */
  readonly dedupeKey?: string;
  readonly parseMode?: 'plain' | 'markdown';
  /** Free-form trace id for the audit log. */
  readonly traceId?: string;
}

export interface Notifier {
  send(
    severity: AlertSeverity,
    title: string,
    body: string,
    opts?: NotifyOptions,
  ): Promise<void>;
  /**
   * Ask the operator to approve or reject. Must resolve with `approved: false` (never throw,
   * never assume yes) when no answer arrives before `expiresAt` — fail closed.
   */
  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>;
  /** Interactive query (e.g. "/status portfolio"); resolves to the rendered answer text. */
  query(question: string): Promise<string>;
}

/**
 * No-op notifier for tests and read-only runs. `requestApproval` always rejects — a missing or
 * disabled channel can never silently approve a write.
 */
export const noopNotifier: Notifier = {
  send: async () => {},
  requestApproval: async (request) => ({
    requestId: request.id,
    approved: false,
    decidedBy: 'noop-notifier',
    decidedAt: new Date().toISOString(),
    reason: 'notifier is a no-op: approvals can never be granted',
  }),
  query: async () => {
    throw new Error('noop notifier cannot answer queries');
  },
};
