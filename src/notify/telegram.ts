/**
 * §78 Telegram notifier — the real bidirectional channel (alerts + queries + human approvals).
 *
 * Design constraints (D4 / T13):
 * - **`fetch` only.** No Telegram SDK, no third-party client: the surface we need is three calls.
 * - **Long polling (`getUpdates`), never a webhook.** A webhook would require exposing the process
 *   (or a tunnel) to the public internet; polling keeps the bot outbound-only.
 * - **Fail closed.** A missing token, a 5xx, a timeout or a caller who never answers all resolve
 *   `requestApproval` as `approved: false`. Nothing here can silently approve a write, and there is
 *   no code path in this file that could send a transaction (§78: the notifier is a pure side
 *   channel — it holds no key and reaches no chain).
 * - **Authorization by user id.** Only numeric ids listed in `TELEGRAM_ALLOWED_USER_IDS` may
 *   approve, reject or run a query command; every other sender is ignored *and* recorded (speaking
 *   back to an unknown user would leak the bot's existence).
 * - **Data comes from injected `QueryHandlers`.** This module never reads the chain, the DB or the
 *   portfolio: the composition root wires real providers in (see `QueryHandlers`).
 *
 * Fake tokens in tests: any token used in `tests/notify/**` is a locally invented placeholder
 * (`123456:TEST-TOKEN-NOT-REAL`) and must never be mistaken for a live credential.
 */
import {
  ALERT_SEVERITIES,
  APPROVAL_KINDS,
  APPROVAL_STATUSES,
  noopNotifier,
  type AlertSeverity,
  type ApprovalDecision,
  type ApprovalRequest,
  type Notifier,
  type NotifyOptions,
} from '../types/notifier.ts';
import { BOT_STATES } from '../types/state.ts';
import type { StrategyConfig } from '../types/config.ts';
import type { IsoTimestamp } from '../types/primitives.ts';
import type { DecisionLog } from '../types/portfolio.ts';
import type { DecisionLogSink, LoggerLike } from '../execution/approvalGate.ts';
// Shared deadline primitive: the gate caps its wait at `expiresAt`, the notifier caps its wait for a
// callback at the same instant. Keeping one implementation means the fail-closed deadline can only
// be wrong in one place. (Notifier stays a pure side channel: this is a pure function, not a
// capability — nothing here can sign or send.)
import { withDeadline } from '../execution/approvalGate.ts';

/** Default Bot API host. Overridable for self-hosted Bot API servers and offline fixtures. */
export const TELEGRAM_API_BASE_URL_DEFAULT = 'https://api.telegram.org';

/** How long an operator action stays answerable. Matches the §6.2 approval window (30 minutes). */
export const DEFAULT_ACTION_APPROVAL_TTL_MS = 30 * 60 * 1000;

/**
 * Read-only queries plus the operator actions (§78 / T13 / architecture §6.2).
 *
 * The two groups are separated because they have different authority:
 * - **queries** (`/status` …) answer a question and change nothing.
 * - **actions** (`/exit` `/start` `/resume`) move money and are gated differently — see
 *   `TELEGRAM_ACTION_COMMANDS`.
 */
export const TELEGRAM_QUERY_COMMANDS = [
  '/status',
  '/position',
  '/pools',
  '/nav',
  '/risk',
  '/help',
] as const;

/**
 * Operator actions. `/exit` and `/resume` require an explicit Approve; `/start` does not, because the
 * command itself is the authorisation (architecture §6.2) — asking twice would make "exit then rebuild"
 * a two-round-trip ritual for no added safety.
 */
export const TELEGRAM_ACTION_COMMANDS = ['/exit', '/start', '/resume'] as const;

export const TELEGRAM_COMMANDS = [...TELEGRAM_QUERY_COMMANDS, ...TELEGRAM_ACTION_COMMANDS] as const;
export type TelegramCommand = (typeof TELEGRAM_COMMANDS)[number];
export type TelegramQueryCommand = (typeof TELEGRAM_QUERY_COMMANDS)[number];
export type TelegramActionCommand = (typeof TELEGRAM_ACTION_COMMANDS)[number];

/** True for a command that moves funds and therefore carries its own authorisation rules. */
export function isActionCommand(command: TelegramCommand): command is TelegramActionCommand {
  return (TELEGRAM_ACTION_COMMANDS as readonly string[]).includes(command);
}

/** Callback-data actions of the inline keyboard. Telegram limits `callback_data` to 64 bytes. */
export const DECISION_CALLBACK_ACTIONS = {
  APPROVE: 'approve',
  REJECT: 'reject',
} as const;
export type DecisionCallbackAction =
  (typeof DECISION_CALLBACK_ACTIONS)[keyof typeof DECISION_CALLBACK_ACTIONS];

const CALLBACK_DATA_MAX_BYTES = 64;
const TELEGRAM_TEXT_MAX_CHARS = 4096;
const DEFAULT_POLL_TIMEOUT_SECONDS = 25;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_DEDUPE_WINDOW_MS = 60_000;

/**
 * Reason strings produced by this notifier when it refuses. They are part of the audit trail, so
 * they are exported as constants instead of being spelled at each call site.
 */
export const TELEGRAM_REFUSAL_REASONS = {
  NOT_CONFIGURED: 'telegram channel is not configured: no approval can be granted (fail closed)',
  TIMEOUT: 'telegram: no answer before expiresAt (fail closed)',
  TRANSPORT: 'telegram: approval message could not be delivered (fail closed)',
  NOT_PENDING: 'telegram: approval request is not pending any more (fail closed)',
  UNKNOWN_REQUEST: 'telegram: no pending approval request with this id (fail closed)',
  UNAUTHORIZED: 'telegram: only TELEGRAM_ALLOWED_USER_IDS may decide',
} as const;

/** Audit/ops events emitted by the notifier through the §77 sink. */
export const TELEGRAM_AUDIT_EVENTS = {
  APPROVAL_UNAVAILABLE: 'telegram_approval_unavailable',
  UNAUTHORIZED_USER: 'telegram_unauthorized_user',
  DECISION_ACCEPTED: 'telegram_decision_accepted',
  DECISION_DUPLICATE: 'telegram_decision_duplicate',
  DECISION_UNKNOWN_REQUEST: 'telegram_decision_unknown_request',
  SEND_FAILED: 'telegram_send_failed',
} as const;
export type TelegramAuditEvent =
  (typeof TELEGRAM_AUDIT_EVENTS)[keyof typeof TELEGRAM_AUDIT_EVENTS];

/** Subset of `typeof fetch` we depend on; injectable so tests never touch the network. */
export type FetchLike = typeof fetch;

/** Minimal Telegram Bot API shapes this client reads. Unknown fields are ignored on purpose. */
export interface TelegramUser {
  readonly id: number;
  readonly is_bot?: boolean;
  readonly username?: string;
  readonly first_name?: string;
}

export interface TelegramChat {
  readonly id: number;
  readonly type?: string;
}

export interface TelegramMessage {
  readonly message_id: number;
  readonly chat: TelegramChat;
  readonly from?: TelegramUser;
  readonly text?: string;
  readonly date?: number;
}

export interface TelegramCallbackQuery {
  readonly id: string;
  readonly from?: TelegramUser;
  readonly data?: string;
  readonly message?: TelegramMessage;
}

export interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: TelegramMessage;
  readonly callback_query?: TelegramCallbackQuery;
}

/** Answer of any Bot API call. `result` is only present when `ok` is true. */
export interface TelegramApiResponse<T> {
  readonly ok: boolean;
  readonly result?: T;
  readonly description?: string;
  readonly error_code?: number;
}

/**
 * Injected data source for query commands. `/pools` cannot be derived from local facts (pool state
 * is supplied by `PoolDataProvider`), so `createNotifierFromConfig` refuses to build a bot without
 * one — a fabricated answer would be worse than "unavailable" (fail closed).
 */
export interface QueryHandlers {
  readonly status: (args: string) => string | Promise<string>;
  readonly position: (args: string) => string | Promise<string>;
  readonly pools: (args: string) => string | Promise<string>;
  readonly nav: (args: string) => string | Promise<string>;
  readonly risk: (args: string) => string | Promise<string>;
  /** `/help`: usage text. Optional — a sensible default is rendered when absent. */
  readonly help?: (args: string) => string | Promise<string>;
}

/**
 * Operator actions, injected like `QueryHandlers` so this module still never touches the chain, the DB
 * or the executor.
 *
 * Each returns a human-readable outcome. **They must not throw for a business refusal** (e.g. `/start`
 * while a position is open): the caller renders the reason. Throwing is reserved for wiring failures.
 *
 * `exit` and `resume` are gated by the approval channel before they run — see
 * `createNotifierFromConfig` and the `/exit` handling below. `start` runs directly.
 */
export interface ActionHandlers {
  /** Request to close the current position; the caller has ALREADY obtained approval. */
  readonly exit: (args: string) => string | Promise<string>;
  /** Begin a build from IDLE. No approval: the command is the authorisation. */
  readonly start: (args: string) => string | Promise<string>;
  /** Leave PAUSED after a risk halt; the caller has ALREADY obtained approval. */
  readonly resume: (args: string) => string | Promise<string>;
}

/** Thrown for Bot API failures. Deliberately carries no URL/token (a token must never be logged). */
export class TelegramApiError extends Error {
  readonly method: string;
  readonly status: number;
  readonly description: string;

  constructor(method: string, status: number, description: string) {
    super(
      status === 0
        ? `telegram ${method} failed: ${description}`
        : `telegram ${method} failed with HTTP ${status}: ${description}`,
    );
    this.name = 'TelegramApiError';
    this.method = method;
    this.status = status;
    this.description = description;
  }
}

export interface TelegramNotifierOptions {
  /** Bot token from `TELEGRAM_BOT_TOKEN`. Empty ⇒ construction fails (use the factory instead). */
  readonly botToken: string;
  /** Chat that receives alerts and approval requests (`TELEGRAM_CHAT_ID`). */
  readonly chatId: string;
  /** Numeric user ids allowed to approve/reject/query (`TELEGRAM_ALLOWED_USER_IDS`). */
  readonly allowedUserIds: readonly number[];
  readonly fetchImpl?: FetchLike;
  readonly apiBaseUrl?: string;
  /** Long-poll window in seconds; Bot API caps it at 50. */
  readonly pollTimeoutSeconds?: number;
  readonly requestTimeoutMs?: number;
  /** Data source for `/status` `/position` `/pools` `/nav` `/risk`. */
  readonly queryHandlers?: QueryHandlers;
  /** Operator actions (§6.2). Absent ⇒ action commands are refused rather than silently ignored. */
  readonly actionHandlers?: ActionHandlers;
  /** TTL for an action's approval prompt; falls back to the query/approval default. */
  readonly actionApprovalTtlMs?: number;
  /** §77 audit sink (StateStore). Wired by the composition root. */
  readonly audit?: DecisionLogSink;
  readonly logger?: LoggerLike;
  readonly now?: () => number;
  /** Window in which an identical `dedupeKey` alert is collapsed. */
  readonly dedupeWindowMs?: number;
}

const defaultLogger: LoggerLike = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function iso(ms: number): IsoTimestamp {
  return new Date(ms).toISOString();
}

/** Split a command message into its canonical command and remaining args (`/status portfolio`). */
export function parseTelegramCommand(
  text: string,
): { readonly command: TelegramCommand; readonly args: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) {
    return null;
  }
  const parts = trimmed.split(/\s+/);
  const rawCommand = parts[0] ?? '';
  // `/status@SomeBot` is what Telegram delivers in groups.
  const command = (rawCommand.split('@')[0] ?? '').toLowerCase();
  if (!(TELEGRAM_COMMANDS as readonly string[]).includes(command)) {
    return null;
  }
  return { command: command as TelegramCommand, args: parts.slice(1).join(' ') };
}

/** `approve:<requestId>` / `reject:<requestId>` — must fit Telegram's 64-byte callback_data. */
export function encodeDecisionCallback(
  action: DecisionCallbackAction,
  requestId: string,
): string {
  const data = `${action}:${requestId}`;
  if (Buffer.byteLength(data, 'utf8') > CALLBACK_DATA_MAX_BYTES) {
    throw new Error(
      `callback_data would exceed ${CALLBACK_DATA_MAX_BYTES} bytes; shorten the approval request id`,
    );
  }
  return data;
}

export function parseDecisionCallback(
  data: string,
): { readonly action: DecisionCallbackAction; readonly requestId: string } | null {
  const separator = data.indexOf(':');
  if (separator <= 0) {
    return null;
  }
  const action = data.slice(0, separator);
  const requestId = data.slice(separator + 1);
  if (requestId.length === 0) {
    return null;
  }
  if (action === DECISION_CALLBACK_ACTIONS.APPROVE || action === DECISION_CALLBACK_ACTIONS.REJECT) {
    return { action, requestId };
  }
  return null;
}

/** Render one alert message. Severity is always visible; `critical` gets an unambiguous marker. */
export function renderAlert(
  severity: AlertSeverity,
  title: string,
  body: string,
  opts?: NotifyOptions,
): string {
  const header = `[${severity.toUpperCase()}] ${title}`;
  const trace = opts?.traceId === undefined ? '' : `\n--\ntrace: ${opts.traceId}`;
  return truncateTelegramText(`${header}\n\n${body}${trace}`);
}

export function truncateTelegramText(text: string): string {
  return text.length <= TELEGRAM_TEXT_MAX_CHARS
    ? text
    : `${text.slice(0, TELEGRAM_TEXT_MAX_CHARS - 20)}\n...[truncated]`;
}

/** Parse `TELEGRAM_ALLOWED_USER_IDS` ("1, 2" / "1 2"). An empty value means "nobody". */
export function parseAllowedUserIds(raw: string | undefined): readonly number[] {
  if (raw === undefined) {
    return [];
  }
  const ids = raw
    .split(/[\s,;]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => Number.parseInt(part, 10))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
  return [...new Set(ids)];
}

/** `TELEGRAM_ENABLED`, falling back to the YAML `strategy.telegram.enabled` switch. */
export function isTelegramEnabledFromEnv(
  raw: string | undefined,
  config: StrategyConfig,
): boolean {
  if (raw === undefined || raw.trim().length === 0) {
    return config.telegram.enabled;
  }
  return !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase());
}

/**
 * The real Telegram client. Implements the frozen `Notifier` contract and adds the polling loop.
 *
 * `start()` begins long polling (`getUpdates`) and dispatches inbound updates; `stop()` ends it
 * (aborting the in-flight poll). Nothing in this class sends a transaction, signs anything, or
 * writes to the database.
 */
export class TelegramNotifier implements Notifier {
  private readonly botToken: string;
  private readonly chatId: string;
  private readonly allowedUserIds: ReadonlySet<number>;
  private readonly fetchImpl: FetchLike;
  private readonly apiBaseUrl: string;
  private readonly pollTimeoutSeconds: number;
  private readonly requestTimeoutMs: number;
  private readonly queryHandlers: QueryHandlers | undefined;
  private readonly actionHandlers: ActionHandlers | undefined;
  private readonly approvalTtlMs: number;
  private readonly audit: DecisionLogSink | undefined;
  private readonly logger: LoggerLike;
  private readonly nowMs: () => number;
  private readonly dedupeWindowMs: number;

  /** Requests waiting for an inline-button answer, keyed by approval request id. */
  private readonly pending = new Map<string, (decision: ApprovalDecision) => void>();
  /** Request ids that already received exactly one decision — makes repeated clicks idempotent. */
  private readonly decided = new Set<string>();
  /** `dedupeKey -> last alert sent inside the window`. */
  private readonly recentAlerts = new Map<string, { readonly text: string; readonly sentAtMs: number }>();

  private running = false;
  private loopPromise: Promise<void> | null = null;
  private pollAbort: AbortController | null = null;
  private wake: (() => void) | null = null;
  private offset: number | null = null;

  constructor(options: TelegramNotifierOptions) {
    if (options.botToken.trim().length === 0) {
      throw new Error(
        'telegram bot token is required: refusing to build a notifier that cannot deliver (fail closed)',
      );
    }
    if (options.chatId.trim().length === 0) {
      throw new Error('telegram chat id is required (fail closed)');
    }
    this.botToken = options.botToken.trim();
    this.chatId = options.chatId.trim();
    this.allowedUserIds = new Set(options.allowedUserIds);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiBaseUrl = (options.apiBaseUrl ?? TELEGRAM_API_BASE_URL_DEFAULT).replace(/\/+$/, '');
    this.pollTimeoutSeconds = Math.min(Math.max(options.pollTimeoutSeconds ?? DEFAULT_POLL_TIMEOUT_SECONDS, 0), 50);
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.queryHandlers = options.queryHandlers;
    this.actionHandlers = options.actionHandlers;
    this.approvalTtlMs = options.actionApprovalTtlMs ?? DEFAULT_ACTION_APPROVAL_TTL_MS;
    this.audit = options.audit;
    this.logger = options.logger ?? defaultLogger;
    this.nowMs = options.now ?? (() => Date.now());
    this.dedupeWindowMs = options.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
  }

  /** Number of approval requests currently waiting for an answer (ops/tests). */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Read-only self-check: `getMe` proves the token is valid and reports the bot identity; `getChat`
   * proves `TELEGRAM_CHAT_ID` is reachable by this bot (wrong id / bot not a member is the most
   * common misconfiguration). Neither call sends, posts, approves or consumes an update — exactly
   * what an operator should run before a live session. Throws `TelegramApiError` on any failure.
   */
  async verifyChannel(): Promise<TelegramUser> {
    const me = await this.call<TelegramUser>('getMe', {});
    const chat = await this.call<TelegramChat>('getChat', { chat_id: this.chatId });
    if (String(chat.id) !== this.chatId) {
      throw new TelegramApiError(
        'getChat',
        200,
        `TELEGRAM_CHAT_ID resolves to a different chat (${String(chat.id)})`,
      );
    }
    return me;
  }

  get polling(): boolean {
    return this.running;
  }

  // ---------------------------------------------------------------------------------------------
  // Notifier contract
  // ---------------------------------------------------------------------------------------------

  /** Push a three-level alert (§78). Critical alerts use the same path, just marked CRITICAL. */
  async send(
    severity: AlertSeverity,
    title: string,
    body: string,
    opts?: NotifyOptions,
  ): Promise<void> {
    const text = renderAlert(severity, title, body, opts);
    const dedupeKey = opts?.dedupeKey;
    if (dedupeKey !== undefined) {
      const previous = this.recentAlerts.get(dedupeKey);
      if (previous?.text === text && this.nowMs() - previous.sentAtMs < this.dedupeWindowMs) {
        this.logger.info('telegram: duplicate alert collapsed', { dedupeKey });
        return;
      }
      this.recentAlerts.set(dedupeKey, { text, sentAtMs: this.nowMs() });
      // Bound the map without a timer: drop the least recently touched key past a small cap.
      if (this.recentAlerts.size > 512) {
        const oldest = this.recentAlerts.keys().next();
        if (!oldest.done) {
          this.recentAlerts.delete(oldest.value);
        }
      }
    }
    try {
      await this.call<TelegramMessage>('sendMessage', {
        chat_id: this.chatId,
        text,
        ...(opts?.parseMode === 'markdown' ? { parse_mode: 'Markdown' } : {}),
        // Critical alerts must be seen; informational cadence alerts stay quiet on the phone.
        disable_notification: severity !== ALERT_SEVERITIES.CRITICAL,
      });
    } catch (error) {
      // Alerts are best effort: an outage must not break the caller, but it must be loud and
      // auditable. Approval delivery is a different story and fails closed (see requestApproval).
      const reason = error instanceof Error ? error.message : 'unknown error';
      this.logger.error(`telegram: alert send failed (${severity}: ${title})`, { reason });
      this.emitAudit(TELEGRAM_AUDIT_EVENTS.SEND_FAILED, {
        title,
        severity,
        reason,
        ...(opts?.traceId === undefined ? {} : { traceId: opts.traceId }),
      });
    }
  }

  /**
   * Ask the operator to approve or reject. Resolves `approved: false` for every failure mode: no
   * configured chat, HTTP error, timeout, unknown/unauthorized/duplicate callback, TTL expiry.
   */
  async requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    const refuse = (reason: string): ApprovalDecision => ({
      requestId: request.id,
      approved: false,
      decidedBy: 'telegram-notifier',
      decidedAt: iso(this.nowMs()),
      reason,
    });

    if (request.status !== APPROVAL_STATUSES.PENDING) {
      return refuse(TELEGRAM_REFUSAL_REASONS.NOT_PENDING);
    }
    const expiresAtMs = Date.parse(request.expiresAt);
    const ttlMs = Number.isFinite(expiresAtMs) ? expiresAtMs - this.nowMs() : 0;
    if (ttlMs <= 0) {
      return refuse(TELEGRAM_REFUSAL_REASONS.TIMEOUT);
    }

    let resolvePending: (decision: ApprovalDecision) => void = () => {};
    const answer = new Promise<ApprovalDecision>((resolve) => {
      resolvePending = resolve;
    });
    this.pending.set(request.id, resolvePending);

    try {
      await this.call<TelegramMessage>('sendMessage', {
        chat_id: this.chatId,
        text: truncateTelegramText(
          `[APPROVAL REQUIRED] ${request.kind}\n` +
            `id: ${request.id}\n` +
            `expires: ${request.expiresAt}\n\n` +
            `${request.payloadSummary}`,
        ),
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Approve', callback_data: encodeDecisionCallback(DECISION_CALLBACK_ACTIONS.APPROVE, request.id) },
              { text: 'Reject', callback_data: encodeDecisionCallback(DECISION_CALLBACK_ACTIONS.REJECT, request.id) },
            ],
          ],
        },
      });
    } catch (error) {
      this.pending.delete(request.id);
      const reason = error instanceof Error ? error.message : 'unknown error';
      this.logger.error(`telegram: approval message failed to deliver (${request.id})`, { reason });
      this.emitAudit(TELEGRAM_AUDIT_EVENTS.APPROVAL_UNAVAILABLE, {
        requestId: request.id,
        kind: request.kind,
        reason: TELEGRAM_REFUSAL_REASONS.TRANSPORT,
      });
      return refuse(TELEGRAM_REFUSAL_REASONS.TRANSPORT);
    }

    const outcome = await withDeadline(answer, ttlMs);
    this.pending.delete(request.id);
    if (outcome.timedOut) {
      this.logger.warn(`telegram: approval ${request.id} expired unanswered (fail closed)`);
      return refuse(TELEGRAM_REFUSAL_REASONS.TIMEOUT);
    }
    return outcome.value;
  }

  /**
   * Answer a query command. Data comes exclusively from the injected `QueryHandlers`; absent
   * handlers throw rather than returning a fabricated answer (fail closed).
   */
  async query(question: string): Promise<string> {
    const parsed = parseTelegramCommand(question);
    if (parsed === null) {
      throw new Error(`unknown query command: "${question}"`);
    }
    // An action must be refused BEFORE the handler-wiring check. Otherwise a workspace with no query
    // handlers wired would report "query handlers are not wired" for `/exit` — naming a wiring problem
    // for what is actually an authorisation refusal, and hiding the real reason from the operator.
    if (isActionCommand(parsed.command)) {
      throw new Error(
        `${parsed.command} is an operator action and cannot run through the query path; ` +
          'use performAction (fail closed)',
      );
    }

    const handlers = this.queryHandlers;
    if (handlers === undefined) {
      throw new Error('telegram query handlers are not wired (fail closed)');
    }
    if (parsed.command === '/status') {
      return await handlers.status(parsed.args);
    }
    if (parsed.command === '/position') {
      return await handlers.position(parsed.args);
    }
    if (parsed.command === '/pools') {
      return await handlers.pools(parsed.args);
    }
    if (parsed.command === '/nav') {
      return await handlers.nav(parsed.args);
    }
    if (parsed.command === '/risk') {
      return await handlers.risk(parsed.args);
    }
    if (parsed.command === '/help') {
      return handlers.help === undefined ? renderHelp() : await handlers.help(parsed.args);
    }
    throw new Error(`unknown query command: "${question}"`);
  }

  /**
   * Run an operator action (§6.2).
   *
   * ## Authorisation policy, per command
   * - **`/exit`** and **`/resume`** are approved first. Both are irreversible or consequential: an exit
   *   pays swap costs and realises impermanent loss, and a resume re-enables trading after a risk halt.
   *   The approval is requested through this same channel, so the operator sees the numbers (position
   *   value, range, fees) before agreeing.
   * - **`/start`** runs directly. It is a deliberate command from an authorised user, so asking again
   *   would make "exit then rebuild" a two-round-trip ritual without adding safety — and §6.2 records
   *   that decision.
   *
   * A refusal from the gate does NOT run the handler; the caller sees why.
   */
  async performAction(
    command: TelegramActionCommand,
    args: string,
    options: {
      /** Human-readable payload shown in the approval prompt. Never include secrets. */
      readonly approvalSummary: string;
      readonly approvalPayload?: Readonly<Record<string, unknown>>;
      readonly requestId: string;
    },
  ): Promise<string> {
    const handlers = this.actionHandlers;
    if (handlers === undefined) {
      throw new Error('telegram action handlers are not wired (fail closed)');
    }

    if (command !== '/start') {
      const decision = await this.requestApproval({
        id: options.requestId,
        kind: APPROVAL_KINDS.BUILD_POSITION,
        createdAt: iso(this.nowMs()),
        expiresAt: iso(this.nowMs() + this.approvalTtlMs),
        payloadSummary: options.approvalSummary,
        payloadJson: options.approvalPayload ?? {},
        status: APPROVAL_STATUSES.PENDING,
      });
      if (!decision.approved) {
        return `${command} not confirmed — nothing was done (${decision.reason ?? 'no approval'})`;
      }
    }

    if (command === '/exit') return await handlers.exit(args);
    if (command === '/start') return await handlers.start(args);
    return await handlers.resume(args);
  }

  // ---------------------------------------------------------------------------------------------
  // Long polling
  // ---------------------------------------------------------------------------------------------

  /** Start the `getUpdates` long-poll loop. Idempotent; never throws (failures are logged). */
  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.logger.info('telegram: long polling started', {
      allowedUserIds: [...this.allowedUserIds].join(','),
    });
    this.loopPromise = this.pollLoop().finally(() => {
      this.running = false;
      this.loopPromise = null;
    });
  }

  /** Stop the loop and abort the in-flight poll. Safe to call twice. */
  async stop(): Promise<void> {
    this.running = false;
    this.pollAbort?.abort();
    this.wake?.();
    const loop = this.loopPromise;
    if (loop !== null) {
      await loop.catch(() => {});
    }
  }

  private async pollLoop(): Promise<void> {
    let failures = 0;
    while (this.running) {
      try {
        const updates = await this.getUpdates();
        failures = 0;
        for (const update of updates) {
          if (!this.running) {
            return;
          }
          this.offset = Math.max(this.offset ?? 0, update.update_id + 1);
          await this.handleUpdate(update);
        }
        if (updates.length === 0 && this.pollTimeoutSeconds === 0) {
          await this.waitUnlessStopped(250);
        }
      } catch (error) {
        if (!this.running) {
          return;
        }
        failures += 1;
        const reason = error instanceof Error ? error.message : 'unknown error';
        this.logger.warn('telegram: getUpdates failed, backing off', {
          reason,
          failures: String(failures),
        });
        await this.waitUnlessStopped(Math.min(30_000, 1_000 * 2 ** Math.min(failures, 5)));
      }
    }
  }

  private async getUpdates(): Promise<readonly TelegramUpdate[]> {
    const abort = new AbortController();
    this.pollAbort = abort;
    try {
      const body: Record<string, unknown> = {
        timeout: this.pollTimeoutSeconds,
        allowed_updates: ['message', 'callback_query'],
      };
      if (this.offset !== null) {
        body['offset'] = this.offset;
      }
      const result = await this.call<readonly TelegramUpdate[]>(
        'getUpdates',
        body,
        this.pollTimeoutSeconds * 1_000 + this.requestTimeoutMs,
        abort.signal,
      );
      return result ?? [];
    } finally {
      this.pollAbort = null;
    }
  }

  /**
   * Dispatch one inbound update. Public because it is the whole inbound surface (the poll loop only
   * feeds it), which lets tests exercise it deterministically without the network.
   */
  async handleUpdate(update: TelegramUpdate): Promise<void> {
    const callback = update.callback_query;
    if (callback !== undefined) {
      await this.handleCallbackQuery(callback);
      return;
    }
    const message = update.message;
    if (message !== undefined && typeof message.text === 'string') {
      await this.handleMessage(message);
    }
  }

  private async handleCallbackQuery(callback: TelegramCallbackQuery): Promise<void> {
    const userId = callback.from?.id;
    const parsed = typeof callback.data === 'string' ? parseDecisionCallback(callback.data) : null;
    if (userId === undefined || parsed === null) {
      this.logger.info('telegram: ignoring callback without a user id or decision payload');
      return;
    }
    if (!this.allowedUserIds.has(userId)) {
      // Never answer an unknown user (no API call), but always record the attempt.
      this.logger.warn('telegram: ignoring decision from unauthorized user (not in TELEGRAM_ALLOWED_USER_IDS)', {
        userId: String(userId),
        requestId: parsed.requestId,
        action: parsed.action,
      });
      this.emitAudit(TELEGRAM_AUDIT_EVENTS.UNAUTHORIZED_USER, {
        userId: String(userId),
        requestId: parsed.requestId,
        action: parsed.action,
        reason: TELEGRAM_REFUSAL_REASONS.UNAUTHORIZED,
      });
      return;
    }

    const approved = parsed.action === DECISION_CALLBACK_ACTIONS.APPROVE;
    const decision: ApprovalDecision = {
      requestId: parsed.requestId,
      approved,
      decidedBy: String(userId),
      decidedAt: iso(this.nowMs()),
      reason: approved
        ? 'approved via telegram inline button'
        : 'rejected via telegram inline button',
    };

    const pendingResolver = this.pending.get(parsed.requestId);
    if (pendingResolver === undefined) {
      const duplicate = this.decided.has(parsed.requestId);
      this.logger.warn(
        duplicate
          ? 'telegram: duplicate decision click ignored (already decided)'
          : 'telegram: decision for an unknown or already-finished request ignored',
        { requestId: parsed.requestId, userId: String(userId) },
      );
      this.emitAudit(
        duplicate
          ? TELEGRAM_AUDIT_EVENTS.DECISION_DUPLICATE
          : TELEGRAM_AUDIT_EVENTS.DECISION_UNKNOWN_REQUEST,
        {
          requestId: parsed.requestId,
          userId: String(userId),
          action: parsed.action,
          reason: TELEGRAM_REFUSAL_REASONS.UNKNOWN_REQUEST,
        },
      );
      await this.answerCallbackQuery(callback, duplicate ? 'Already answered' : 'Request is not active');
      await this.clearInlineKeyboard(callback);
      return;
    }

    this.decided.add(parsed.requestId);
    this.pending.delete(parsed.requestId);
    this.emitAudit(TELEGRAM_AUDIT_EVENTS.DECISION_ACCEPTED, {
      requestId: parsed.requestId,
      userId: String(userId),
      action: parsed.action,
    });
    await this.answerCallbackQuery(callback, approved ? 'Approved' : 'Rejected');
    await this.clearInlineKeyboard(callback);
    pendingResolver(decision);
  }

  private async handleMessage(message: TelegramMessage): Promise<void> {
    const userId = message.from?.id;
    const text = message.text ?? '';
    if (userId === undefined) {
      return;
    }
    if (!this.allowedUserIds.has(userId)) {
      this.logger.warn('telegram: ignoring message from unauthorized user', {
        userId: String(userId),
        command: text.split(/\s+/)[0] ?? '',
      });
      this.emitAudit(TELEGRAM_AUDIT_EVENTS.UNAUTHORIZED_USER, {
        userId: String(userId),
        reason: TELEGRAM_REFUSAL_REASONS.UNAUTHORIZED,
      });
      return;
    }
    const parsed = parseTelegramCommand(text);
    if (parsed === null) {
      this.logger.info('telegram: ignoring non-command message from authorized user', {
        userId: String(userId),
      });
      return;
    }
    let answer: string;
    try {
      answer = await this.query(text);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      this.logger.error(`telegram: query "${parsed.command}" failed`, { reason });
      answer = `${parsed.command}: data unavailable (${reason})`;
    }
    try {
      await this.call<TelegramMessage>('sendMessage', {
        chat_id: message.chat.id,
        text: truncateTelegramText(answer),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      this.logger.error('telegram: query reply failed to deliver', { reason });
    }
  }

  private async answerCallbackQuery(callback: TelegramCallbackQuery, text: string): Promise<void> {
    try {
      await this.call<boolean>('answerCallbackQuery', { callback_query_id: callback.id, text });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn('telegram: answerCallbackQuery failed', { reason });
    }
  }

  /** Remove the inline keyboard so the same request cannot be clicked twice. */
  private async clearInlineKeyboard(callback: TelegramCallbackQuery): Promise<void> {
    const target = callback.message;
    if (target === undefined) {
      this.logger.info('telegram: callback has no message reference; keyboard left as is');
      return;
    }
    try {
      await this.call<TelegramMessage>('editMessageReplyMarkup', {
        chat_id: target.chat.id,
        message_id: target.message_id,
        reply_markup: { inline_keyboard: [] },
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn('telegram: could not remove inline keyboard', { reason });
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Bot API plumbing
  // ---------------------------------------------------------------------------------------------

  /**
   * One Bot API call. The URL (which embeds the token) is never put into an error or a log line.
   */
  private async call<T>(
    method: string,
    body: Record<string, unknown>,
    timeoutMs: number = this.requestTimeoutMs,
    signal?: AbortSignal,
  ): Promise<T> {
    const url = `${this.apiBaseUrl}/bot${this.botToken}/${method}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal ?? AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : 'Error';
      throw new TelegramApiError(method, 0, `${name}: request failed`);
    }
    let payload: TelegramApiResponse<T>;
    try {
      payload = (await response.json()) as TelegramApiResponse<T>;
    } catch {
      throw new TelegramApiError(method, response.status, 'response is not JSON');
    }
    if (!response.ok || payload.ok !== true) {
      throw new TelegramApiError(
        method,
        response.status,
        payload.description ?? `ok=false (error_code=${String(payload.error_code ?? 'none')})`,
      );
    }
    return payload.result as T;
  }

  private emitAudit(event: TelegramAuditEvent, detail: Readonly<Record<string, unknown>>): void {
    const sink = this.audit;
    if (sink === undefined) {
      return;
    }
    const record: DecisionLog = {
      timestamp: iso(this.nowMs()),
      // The loop state is not changed by an inbound message; the meaning lives in action/result.
      state: BOT_STATES.MONITOR,
      action: event,
      reason: typeof detail['reason'] === 'string' ? detail['reason'] : event,
      result: 'blocked',
      detail: { channel: 'telegram', ...detail },
    };
    try {
      void sink.append(record);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      this.logger.error('telegram: audit sink rejected a record', { reason });
    }
  }

  private waitUnlessStopped(ms: number): Promise<void> {
    if (!this.running) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }
}

/** Resolve the Telegram transport from the environment; `null` when the channel is unusable. */
export interface TelegramEnvConfig {
  readonly botToken: string;
  readonly chatId: string;
  readonly allowedUserIds: readonly number[];
  readonly apiBaseUrl?: string;
}

export function telegramEnvConfigFrom(
  env: NodeJS.ProcessEnv,
): TelegramEnvConfig | null {
  const botToken = env['TELEGRAM_BOT_TOKEN']?.trim() ?? '';
  const chatId = env['TELEGRAM_CHAT_ID']?.trim() ?? '';
  if (botToken.length === 0 || chatId.length === 0) {
    return null;
  }
  const apiBaseUrl = env['TELEGRAM_API_BASE_URL']?.trim();
  return {
    botToken,
    chatId,
    allowedUserIds: parseAllowedUserIds(env['TELEGRAM_ALLOWED_USER_IDS']),
    ...(apiBaseUrl === undefined || apiBaseUrl.length === 0 ? {} : { apiBaseUrl }),
  };
}

/**
 * **Wiring point for T12 / the composition root.**
 *
 * Returns a configured `TelegramNotifier`, or the contract's `noopNotifier` when the channel is
 * disabled or half-configured. The no-op notifier always refuses approvals, so with no Telegram the
 * gate blocks `BUILD_POSITION` / `SWITCH_POOL` — the documented fail-closed behaviour (D4).
 */
export function createNotifierFromConfig(
  config: StrategyConfig,
  env: NodeJS.ProcessEnv = process.env,
  deps: {
    readonly queryHandlers?: QueryHandlers;
  /** Operator actions (§6.2). Absent ⇒ action commands are refused rather than silently ignored. */
  readonly actionHandlers?: ActionHandlers;
  /** TTL for an action's approval prompt; falls back to the query/approval default. */
  readonly actionApprovalTtlMs?: number;
    readonly audit?: DecisionLogSink;
    readonly logger?: LoggerLike;
    readonly fetchImpl?: FetchLike;
    /** Test hook: construct the notifier even when the config disables telegram. */
    readonly force?: boolean;
  } = {},
): Notifier {
  const logger = deps.logger ?? defaultLogger;
  const enabled = isTelegramEnabledFromEnv(env['TELEGRAM_ENABLED'], config);
  if (!enabled && deps.force !== true) {
    logger.warn(
      'Telegram is disabled (TELEGRAM_ENABLED / strategy.telegram.enabled = false): no approval can be ' +
        'granted, so BUILD_POSITION and SWITCH_POOL will be blocked (fail closed). Alerts are dropped.',
    );
    return noopNotifier;
  }
  const transport = telegramEnvConfigFrom(env);
  if (transport === null) {
    logger.error(
      'Telegram is enabled but TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are unset: falling back to the ' +
        'no-op notifier, so BUILD_POSITION and SWITCH_POOL will be blocked (fail closed).',
    );
    return noopNotifier;
  }
  if (transport.allowedUserIds.length === 0) {
    logger.warn(
      'TELEGRAM_ALLOWED_USER_IDS is empty: the bot will ignore every inbound message and every ' +
        'approval stays pending, so BUILD_POSITION and SWITCH_POOL cannot be released (fail closed).',
    );
  }
  if (deps.queryHandlers === undefined) {
    logger.warn(
      'Telegram query handlers are not wired: /status /position /pools /nav /risk will answer ' +
        '"data unavailable" instead of reporting numbers.',
    );
  }
  return new TelegramNotifier({
    botToken: transport.botToken,
    chatId: transport.chatId,
    allowedUserIds: transport.allowedUserIds,
    ...(deps.queryHandlers === undefined ? {} : { queryHandlers: deps.queryHandlers }),
    ...(deps.audit === undefined ? {} : { audit: deps.audit }),
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    ...(transport.apiBaseUrl === undefined ? {} : { apiBaseUrl: transport.apiBaseUrl }),
    logger,
  });
}

/**
 * Usage text for `/help`.
 *
 * States the authorisation policy explicitly, because "which commands need a confirmation" is exactly
 * the thing an operator must not have to guess before pressing something that moves funds.
 */
function renderHelp(): string {
  return [
    'lptrader commands',
    '',
    'Queries (read-only):',
    '  /status             state, mode, risk line',
    '  /position           current pool, range, fees',
    '  /pools              pools passing the hard filters now',
    '  /nav                total NAV, reserve, LP value, fees',
    '  /risk               depeg, reserve ratio, TVL, drawdown',
    '',
    'Actions:',
    '  /exit               close the position (asks for confirmation)',
    '  /start              build from an empty portfolio (no confirmation — the',
    '                      command is the authorisation)',
    '  /resume             leave a risk halt (asks for confirmation)',
    '',
    'After /exit the bot re-runs pool selection: it builds if a pool qualifies,',
    'otherwise it stays flat and waits for /start.',
    '',
    'After a RISK halt the bot stops and does NOT rebuild. Use /resume to allow it.',
  ].join('\n');
}
