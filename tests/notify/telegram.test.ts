/**
 * T13 — Telegram notifier. **No network**: every request goes to an injected `fetch` that answers
 * with canned Bot API payloads.
 *
 * All tokens/passwords in this file are locally invented placeholders (`123456:TEST-TOKEN-NOT-REAL`)
 * — no real credential exists in this repository or its history.
 *
 * The security property under test: an unreachable, misconfigured or unauthorized channel can never
 * produce an approval.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  DECISION_CALLBACK_ACTIONS,
  TELEGRAM_AUDIT_EVENTS,
  TELEGRAM_ACTION_COMMANDS,
  TELEGRAM_QUERY_COMMANDS,
  TELEGRAM_REFUSAL_REASONS,
  TelegramApiError,
  TelegramNotifier,
  createNotifierFromConfig,
  encodeDecisionCallback,
  isTelegramEnabledFromEnv,
  parseAllowedUserIds,
  parseDecisionCallback,
  parseTelegramCommand,
  renderAlert,
  type FetchLike,
  type ActionHandlers,
  type QueryHandlers,
  type TelegramUpdate,
} from '../../src/notify/telegram.ts';
import { APPROVAL_KINDS, APPROVAL_STATUSES, noopNotifier } from '../../src/types/notifier.ts';
import type { ApprovalDecision, ApprovalRequest } from '../../src/types/notifier.ts';
import type { DecisionLog } from '../../src/types/portfolio.ts';
import type { DecisionLogSink, LoggerLike } from '../../src/execution/approvalGate.ts';
import { loadConfig } from '../../src/config/index.ts';

/** Obviously fake bot token — mirrors Telegram's `digits:secret` shape and nothing else. */
const FAKE_BOT_TOKEN = '123456:TEST-TOKEN-NOT-REAL';
const OTHER_FAKE_BOT_TOKEN = '999999:ANOTHER-FAKE-TOKEN-NOT-REAL';
const ALLOWED_USER_ID = 7;
const INTRUDER_USER_ID = 31337;
const CHAT_ID = '424242';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface RecordedCall {
  readonly method: string;
  readonly body: Record<string, unknown>;
  readonly url: string;
}

/** Minimal Bot API stand-in. Nothing here touches the network (URLs are never fetched). */
class FakeTelegramApi {
  readonly calls: RecordedCall[] = [];
  /** One entry per `getUpdates` call; a missing entry hangs until the poll is aborted. */
  batches: TelegramUpdate[][] = [];
  /** When set, the next call of that method fails with this HTTP status. */
  failNext: { method: string; status: number; description: string } | null = null;
  /** When set, the next call of that method throws (network-level failure / timeout). */
  throwNext: { method: string; error: Error } | null = null;

  readonly fetch: FetchLike = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = url.slice(url.lastIndexOf('/') + 1);
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    this.calls.push({
      method,
      body: typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {},
      url,
    });

    if (this.throwNext !== null && this.throwNext.method === method) {
      const { error } = this.throwNext;
      this.throwNext = null;
      throw error;
    }
    if (this.failNext !== null && this.failNext.method === method) {
      const { status, description } = this.failNext;
      this.failNext = null;
      return jsonResponse({ ok: false, error_code: status, description }, status);
    }
    if (method === 'getUpdates') {
      const batch = this.batches.shift();
      if (batch === undefined) {
        return await this.hang(init?.signal ?? null);
      }
      return jsonResponse({ ok: true, result: batch });
    }
    if (method === 'sendMessage') {
      return jsonResponse({ ok: true, result: { message_id: 11, chat: { id: Number(CHAT_ID) } } });
    }
    return jsonResponse({ ok: true, result: true });
  };

  methodCalls(method: string): readonly RecordedCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  private hang(signal: AbortSignal | null): Promise<Response> {
    return new Promise<Response>((_resolve, reject) => {
      const abort = (): void => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      };
      if (signal === null) {
        return; // never settles: the loop is expected to be stopped with `stop()`
      }
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener('abort', abort, { once: true });
    });
  }
}

function collectingLogger(): { logger: LoggerLike; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    logger: {
      info: (message) => lines.push(`info: ${message}`),
      warn: (message) => lines.push(`warn: ${message}`),
      error: (message) => lines.push(`error: ${message}`),
    },
  };
}

function collectingSink(): { audit: DecisionLogSink; records: DecisionLog[] } {
  const records: DecisionLog[] = [];
  return { records, audit: { append: (record) => records.push(record) } };
}

function approvalRequest(id: string, overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  // The window is relative to now, so a request created by a test is always answerable.
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
  return {
    id,
    kind: APPROVAL_KINDS.BUILD_POSITION,
    createdAt,
    expiresAt,
    payloadSummary: 'QQQB/USDC, lower 0.85, upper 1.16, $7000',
    payloadJson: { capitalUsd: 7000 },
    status: APPROVAL_STATUSES.PENDING,
    ...overrides,
  };
}

function callbackUpdate(requestId: string, userId: number, action: 'approve' | 'reject'): TelegramUpdate {
  return {
    update_id: 1,
    callback_query: {
      id: `cb_${requestId}_${userId}`,
      from: { id: userId, is_bot: false, username: 'operator' },
      data: `${action}:${requestId}`,
      message: { message_id: 11, chat: { id: Number(CHAT_ID) }, date: 1_790_000_000 },
    },
  };
}

function textUpdate(text: string, userId: number, updateId = 2): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: 12,
      chat: { id: Number(CHAT_ID), type: 'private' },
      from: { id: userId, is_bot: false },
      text,
      date: 1_790_000_000,
    },
  };
}

function buildNotifier(
  api: FakeTelegramApi,
  extras: {
    readonly allowedUserIds?: readonly number[];
    readonly audit?: DecisionLogSink;
    readonly logger?: LoggerLike;
    readonly queryHandlers?: QueryHandlers;
    readonly actionHandlers?: ActionHandlers;
    readonly now?: () => number;
  } = {},
): TelegramNotifier {
  return new TelegramNotifier({
    botToken: FAKE_BOT_TOKEN,
    chatId: CHAT_ID,
    allowedUserIds: extras.allowedUserIds ?? [ALLOWED_USER_ID],
    fetchImpl: api.fetch,
    apiBaseUrl: 'https://telegram.invalid',
    pollTimeoutSeconds: 0,
    ...(extras.audit === undefined ? {} : { audit: extras.audit }),
    ...(extras.logger === undefined ? {} : { logger: extras.logger }),
    ...(extras.queryHandlers === undefined ? {} : { queryHandlers: extras.queryHandlers }),
    ...(extras.actionHandlers === undefined ? {} : { actionHandlers: extras.actionHandlers }),
    ...(extras.now === undefined ? {} : { now: extras.now }),
  });
}

/** Wait until the notifier has actually sent the approval message. */
async function waitForSend(api: FakeTelegramApi): Promise<void> {
  await vi.waitFor(() => {
    expect(api.methodCalls('sendMessage').length).toBeGreaterThan(0);
  });
}

describe('telegram — approval decisions', () => {
  it('accepts Approve from an allowed user and reports who decided', async () => {
    const api = new FakeTelegramApi();
    const { audit, records } = collectingSink();
    const notifier = buildNotifier(api, { audit });

    const pending = notifier.requestApproval(approvalRequest('apr_ok'));
    await waitForSend(api);
    await notifier.handleUpdate(callbackUpdate('apr_ok', ALLOWED_USER_ID, 'approve'));
    const decision = await pending;

    expect(decision.approved).toBe(true);
    expect(decision.decidedBy).toBe(String(ALLOWED_USER_ID));
    expect(decision.requestId).toBe('apr_ok');

    // The inline keyboard carries both actions and the request id.
    const sent = api.methodCalls('sendMessage')[0];
    expect(sent?.body['reply_markup']).toEqual({
      inline_keyboard: [
        [
          { text: 'Approve', callback_data: 'approve:apr_ok' },
          { text: 'Reject', callback_data: 'reject:apr_ok' },
        ],
      ],
    });
    // The keyboard is removed so the same message cannot be clicked again.
    expect(api.methodCalls('editMessageReplyMarkup')[0]?.body).toMatchObject({
      chat_id: Number(CHAT_ID),
      message_id: 11,
      reply_markup: { inline_keyboard: [] },
    });
    expect(records.map((record) => record.action)).toContain(TELEGRAM_AUDIT_EVENTS.DECISION_ACCEPTED);
    expect(notifier.pendingCount).toBe(0);
  });

  it('accepts Reject from an allowed user and refuses the approval', async () => {
    const api = new FakeTelegramApi();
    const notifier = buildNotifier(api);

    const pending = notifier.requestApproval(approvalRequest('apr_no'));
    await waitForSend(api);
    await notifier.handleUpdate(callbackUpdate('apr_no', ALLOWED_USER_ID, 'reject'));
    const decision = await pending;

    expect(decision.approved).toBe(false);
    expect(decision.decidedBy).toBe(String(ALLOWED_USER_ID));
    expect(decision.reason).toContain('rejected');
  });

  it('ignores an Approve click from a user outside TELEGRAM_ALLOWED_USER_IDS (logged + audited)', async () => {
    const api = new FakeTelegramApi();
    const { audit, records } = collectingSink();
    const { logger, lines } = collectingLogger();
    const notifier = buildNotifier(api, { audit, logger });

    const pending = notifier.requestApproval(approvalRequest('apr_intruder'));
    await waitForSend(api);
    await notifier.handleUpdate(callbackUpdate('apr_intruder', INTRUDER_USER_ID, 'approve'));

    // The click changed nothing: the request is still waiting for the real operator.
    expect(notifier.pendingCount).toBe(1);
    expect(api.methodCalls('answerCallbackQuery')).toHaveLength(0);
    expect(api.methodCalls('editMessageReplyMarkup')).toHaveLength(0);
    expect(lines.some((line) => line.startsWith('warn:') && line.includes('unauthorized user'))).toBe(true);
    const unauthorized = records.filter(
      (record) => record.action === TELEGRAM_AUDIT_EVENTS.UNAUTHORIZED_USER,
    );
    expect(unauthorized).toHaveLength(1);
    expect(unauthorized[0]?.detail?.['userId']).toBe(String(INTRUDER_USER_ID));
    expect(unauthorized[0]?.result).toBe('blocked');

    // Only the allowed user can close it.
    await notifier.handleUpdate(callbackUpdate('apr_intruder', ALLOWED_USER_ID, 'reject'));
    expect((await pending).approved).toBe(false);
  });

  it('treats a repeated click on the same request id as idempotent', async () => {
    const api = new FakeTelegramApi();
    const { audit, records } = collectingSink();
    const notifier = buildNotifier(api, { audit });

    const pending = notifier.requestApproval(approvalRequest('apr_dup'));
    await waitForSend(api);
    await notifier.handleUpdate(callbackUpdate('apr_dup', ALLOWED_USER_ID, 'approve'));
    const first = await pending;
    // A second click (the message was already stripped of its keyboard, but a stale client may
    // still send it) must not create a second decision.
    await notifier.handleUpdate(callbackUpdate('apr_dup', ALLOWED_USER_ID, 'reject'));

    expect(first.approved).toBe(true);
    expect(notifier.pendingCount).toBe(0);
    expect(api.methodCalls('answerCallbackQuery')[1]?.body['text']).toBe('Already answered');
    expect(
      records.filter((record) => record.action === TELEGRAM_AUDIT_EVENTS.DECISION_ACCEPTED),
    ).toHaveLength(1);
    expect(
      records.filter((record) => record.action === TELEGRAM_AUDIT_EVENTS.DECISION_DUPLICATE),
    ).toHaveLength(1);
  });

  it('refuses (never approves) when the Bot API answers 5xx', async () => {
    const api = new FakeTelegramApi();
    api.failNext = { method: 'sendMessage', status: 502, description: 'Bad Gateway' };
    const { audit, records } = collectingSink();
    const notifier = buildNotifier(api, { audit });

    const decision = await notifier.requestApproval(approvalRequest('apr_5xx'));

    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe(TELEGRAM_REFUSAL_REASONS.TRANSPORT);
    expect(notifier.pendingCount).toBe(0);
    expect(
      records.filter((record) => record.action === TELEGRAM_AUDIT_EVENTS.APPROVAL_UNAVAILABLE),
    ).toHaveLength(1);
  });

  it('refuses (never approves) when the Bot API request itself fails (timeout / DNS / offline)', async () => {
    const api = new FakeTelegramApi();
    api.throwNext = {
      method: 'sendMessage',
      error: new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
    };
    const notifier = buildNotifier(api);

    const decision = await notifier.requestApproval(approvalRequest('apr_timeout'));

    expect(decision.approved).toBe(false);
    expect(decision.reason).toBe(TELEGRAM_REFUSAL_REASONS.TRANSPORT);
  });

  it('refuses an unanswerable request without touching the network', async () => {
    const api = new FakeTelegramApi();
    const notifier = buildNotifier(api);

    const expired = await notifier.requestApproval(
      approvalRequest('apr_past', { expiresAt: '2026-09-28T00:00:00.000Z' }),
    );
    const notPending = await notifier.requestApproval(
      approvalRequest('apr_done', { status: APPROVAL_STATUSES.APPROVED }),
    );

    expect(expired.approved).toBe(false);
    expect(expired.reason).toBe(TELEGRAM_REFUSAL_REASONS.TIMEOUT);
    expect(notPending.approved).toBe(false);
    expect(notPending.reason).toBe(TELEGRAM_REFUSAL_REASONS.NOT_PENDING);
    expect(api.calls).toHaveLength(0);
  });

  it('expires a pending request at TTL without an answer (fail closed)', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-29T00:00:00.000Z'));
      const api = new FakeTelegramApi();
      const notifier = buildNotifier(api);

      const decisionRef: { value: ApprovalDecision | null } = { value: null };
      const pending = notifier.requestApproval(approvalRequest('apr_ttl')).then((value) => {
        decisionRef.value = value;
        return value;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(api.methodCalls('sendMessage')).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(30 * 60_000 + 1);
      await pending;

      expect(decisionRef.value).not.toBeNull();
      expect(decisionRef.value?.approved).toBe(false);
      expect(decisionRef.value?.reason).toBe(TELEGRAM_REFUSAL_REASONS.TIMEOUT);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves a late click after the TTL as a refusal', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-29T00:00:00.000Z'));
      const api = new FakeTelegramApi();
      const notifier = buildNotifier(api);

      const pending = notifier.requestApproval(
        approvalRequest('apr_late', { expiresAt: '2026-09-29T00:30:00.000Z' }),
      );
      await vi.advanceTimersByTimeAsync(31 * 60_000);
      const decision = await pending;

      // A click that arrives after the deadline finds nothing pending; the promise already refused.
      await notifier.handleUpdate(callbackUpdate('apr_late', ALLOWED_USER_ID, 'approve'));
      expect(decision.approved).toBe(false);
      expect(decision.reason).toBe(TELEGRAM_REFUSAL_REASONS.TIMEOUT);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is refused by the contract no-op notifier under every circumstance', async () => {
    const decision = await noopNotifier.requestApproval(approvalRequest('apr_noop'));

    expect(decision.approved).toBe(false);
    expect(decision.requestId).toBe('apr_noop');
    expect(decision.reason).toContain('no-op');
    await expect(noopNotifier.query('/status')).rejects.toThrow('noop notifier cannot answer queries');
  });
});

describe('telegram — long polling loop', () => {
  it('polls getUpdates (never a webhook), answers an allowed /status and advances the offset', async () => {
    const api = new FakeTelegramApi();
    api.batches = [[textUpdate('/status', ALLOWED_USER_ID, 41)]];
    const statusCalls: string[] = [];
    const notifier = buildNotifier(api, {
      queryHandlers: {
        status: (args) => {
          statusCalls.push(args);
          return 'state=MONITOR nav=$10,000';
        },
        position: () => 'no position',
        pools: () => '2 candidates',
        nav: () => '$10,000',
        risk: () => 'ok',
      },
    });

    notifier.start();
    await vi.waitFor(() => {
      expect(api.methodCalls('getUpdates').length).toBeGreaterThanOrEqual(2);
    });
    await notifier.stop();

    expect(notifier.polling).toBe(false);
    expect(statusCalls).toEqual(['']);
    const first = api.methodCalls('getUpdates')[0];
    // Long polling, not a webhook: the only network call is an outbound getUpdates with a timeout.
    expect(first?.body['timeout']).toBe(0);
    expect(first?.body['allowed_updates']).toEqual(['message', 'callback_query']);
    expect(api.calls.every((call) => call.url.startsWith('https://telegram.invalid/bot'))).toBe(true);
    // The offset is advanced past the consumed update so it is never replayed.
    expect(api.methodCalls('getUpdates')[1]?.body['offset']).toBe(42);

    const reply = api.methodCalls('sendMessage')[0];
    expect(reply?.body['chat_id']).toBe(Number(CHAT_ID));
    expect(reply?.body['text']).toBe('state=MONITOR nav=$10,000');
  });

  it('ignores text commands from unauthorized users (logged, audited, no reply sent)', async () => {
    const api = new FakeTelegramApi();
    api.batches = [[textUpdate('/nav', INTRUDER_USER_ID, 51)]];
    const { audit, records } = collectingSink();
    const { logger, lines } = collectingLogger();
    const notifier = buildNotifier(api, {
      audit,
      logger,
      queryHandlers: {
        status: () => 'n/a',
        position: () => 'n/a',
        pools: () => 'n/a',
        nav: () => '$10,000',
        risk: () => 'n/a',
      },
    });

    notifier.start();
    await vi.waitFor(() => {
      expect(api.methodCalls('getUpdates').length).toBeGreaterThanOrEqual(2);
    });
    await notifier.stop();

    expect(api.methodCalls('sendMessage')).toHaveLength(0);
    expect(lines.some((line) => line.startsWith('warn:') && line.includes('unauthorized user'))).toBe(true);
    expect(
      records.filter((record) => record.action === TELEGRAM_AUDIT_EVENTS.UNAUTHORIZED_USER),
    ).toHaveLength(1);
  });

  it('keeps polling and backs off after a getUpdates failure', async () => {
    vi.useFakeTimers();
    try {
      const api = new FakeTelegramApi();
      api.failNext = { method: 'getUpdates', status: 500, description: 'Internal Server Error' };
      const { logger, lines } = collectingLogger();
      const notifier = buildNotifier(api, { logger });

      notifier.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(api.methodCalls('getUpdates')).toHaveLength(1);
      expect(lines.some((line) => line.startsWith('warn:') && line.includes('getUpdates failed'))).toBe(true);

      // The loop must survive the failure: after the backoff it polls again.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(api.methodCalls('getUpdates').length).toBeGreaterThanOrEqual(2);

      await notifier.stop();
      expect(notifier.polling).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('telegram — alerts and queries', () => {
  it('sends the three severities on one path and marks critical alerts for attention', async () => {
    const api = new FakeTelegramApi();
    const notifier = buildNotifier(api);

    await notifier.send('info', 'scan complete', 'no candidate changed', { dedupeKey: 'scan' });
    await notifier.send('warning', 'underperforming', 'net APR 8% for 72h', { dedupeKey: 'apr' });
    await notifier.send('critical', 'GLOBAL RISK OFF', 'NAV drawdown 15%');

    const bodies = api.methodCalls('sendMessage').map((call) => call.body);
    expect(bodies[0]?.['text']).toBe('[INFO] scan complete\n\nno candidate changed');
    expect(bodies[1]?.['text']).toContain('[WARNING] underperforming');
    expect(bodies[2]?.['text']).toContain('[CRITICAL] GLOBAL RISK OFF');
    expect(bodies[2]?.['disable_notification']).toBe(false);
    expect(bodies[0]?.['disable_notification']).toBe(true);
  });

  it('collapses a repeated alert inside the dedupe window only', async () => {
    const api = new FakeTelegramApi();
    const clock = { now: 0 };
    const notifier = buildNotifier(api, { now: () => clock.now });

    await notifier.send('warning', 'TVL falling', 'TVL -50%', { dedupeKey: '56:pool:tvl' });
    await notifier.send('warning', 'TVL falling', 'TVL -50%', { dedupeKey: '56:pool:tvl' });
    clock.now += 60_001;
    await notifier.send('warning', 'TVL falling', 'TVL -50%', { dedupeKey: '56:pool:tvl' });

    expect(api.methodCalls('sendMessage')).toHaveLength(2);
  });

  it('routes every query command through the injected handlers', async () => {
    const api = new FakeTelegramApi();
    const seen: string[] = [];
    const handlers: QueryHandlers = {
      status: (args) => `status:${args}`,
      position: (args) => `position:${args}`,
      pools: (args) => `pools:${args}`,
      nav: (args) => `nav:${args}`,
      risk: (args) => `risk:${args}`,
    };
    const notifier = buildNotifier(api, {
      queryHandlers: {
        status: (args) => {
          seen.push('/status');
          return handlers.status(args);
        },
        position: (args) => {
          seen.push('/position');
          return handlers.position(args);
        },
        pools: (args) => {
          seen.push('/pools');
          return handlers.pools(args);
        },
        nav: (args) => {
          seen.push('/nav');
          return handlers.nav(args);
        },
        risk: (args) => {
          seen.push('/risk');
          return handlers.risk(args);
        },
      },
    });

    // Only the QUERY commands run through this path. Actions are asserted separately below: they must
    // NOT be reachable here, because the query path has no approval gate and actions move funds.
    for (const command of TELEGRAM_QUERY_COMMANDS) {
      const expected = command === '/help' ? expect.stringContaining('lptrader commands') : `${command.slice(1)}:`;
      expect(await notifier.query(command)).toEqual(expected);
    }
    expect(await notifier.query('/status portfolio')).toBe('status:portfolio');
    expect(seen).toEqual(
      TELEGRAM_QUERY_COMMANDS.filter((command) => command !== '/help').concat('/status'),
    );
  });

  it('refuses to run an ACTION through the read-only query path', async () => {
    // Routing an action here would skip its authorisation entirely, so the refusal is the safety property,
    // not an inconvenience.
    const notifier = buildNotifier(new FakeTelegramApi(), {
      actionHandlers: {
        exit: async () => 'exited',
        start: async () => 'started',
        resume: async () => 'resumed',
      },
    });
    for (const command of TELEGRAM_ACTION_COMMANDS) {
      await expect(notifier.query(command)).rejects.toThrow(/operator action/);
    }
  });

  describe('operator actions (§6.2 authorisation policy)', () => {
    function collectingActions(): {
      readonly handlers: ActionHandlers;
      readonly seen: string[];
    } {
      const seen: string[] = [];
      return {
        seen,
        handlers: {
          exit: async () => {
            seen.push('/exit');
            return 'position closed';
          },
          start: async () => {
            seen.push('/start');
            return 'building';
          },
          resume: async () => {
            seen.push('/resume');
            return 'resumed';
          },
        },
      };
    }

    it('/start runs WITHOUT an approval, because the command is the authorisation', async () => {
      // Asking twice would make "exit then rebuild" a two-round-trip ritual with no added safety. The
      // decision is recorded in the architecture doc; this test is what enforces it.
      const api = new FakeTelegramApi();
      const { handlers, seen } = collectingActions();
      const notifier = buildNotifier(api, { actionHandlers: handlers });

      const result = await notifier.performAction('/start', '', {
        approvalSummary: 'unused',
        requestId: 'act_start',
      });

      expect(result).toBe('building');
      expect(seen).toEqual(['/start']);
      expect(api.methodCalls('sendMessage')).toHaveLength(0);
    });

    it('/exit does NOT run until the operator approves', async () => {
      // An exit pays swap costs and realises impermanent loss, so it is irreversible in practice.
      const api = new FakeTelegramApi();
      const { handlers, seen } = collectingActions();
      const notifier = buildNotifier(api, { actionHandlers: handlers });

      const pending = notifier.performAction('/exit', '', {
        approvalSummary: 'EXIT position (value $4,900, range 627–857)',
        requestId: 'act_exit',
      });
      await waitForSend(api);

      // Nothing happened yet, and the operator was shown the numbers.
      expect(seen).toEqual([]);
      const sent = api.methodCalls('sendMessage')[0]?.body['text'];
      expect(String(sent)).toContain('EXIT position');
      expect(String(sent)).toContain('$4,900');

      await notifier.handleUpdate(callbackUpdate('act_exit', ALLOWED_USER_ID, 'approve'));
      expect(await pending).toContain('position closed');
      expect(seen).toEqual(['/exit']);
    });

    it('/exit runs NOTHING when the operator rejects', async () => {
      const api = new FakeTelegramApi();
      const { handlers, seen } = collectingActions();
      const notifier = buildNotifier(api, { actionHandlers: handlers });

      const pending = notifier.performAction('/exit', '', {
        approvalSummary: 'EXIT',
        requestId: 'act_exit_reject',
      });
      await waitForSend(api);
      await notifier.handleUpdate(callbackUpdate('act_exit_reject', ALLOWED_USER_ID, 'reject'));

      const result = await pending;
      expect(result).toContain('not confirmed');
      expect(seen).toEqual([]);
    });

    it('/resume needs an approval too (it re-enables trading after a risk halt)', async () => {
      const api = new FakeTelegramApi();
      const { handlers, seen } = collectingActions();
      const notifier = buildNotifier(api, { actionHandlers: handlers });

      const pending = notifier.performAction('/resume', '', {
        approvalSummary: 'RESUME trading after risk halt',
        requestId: 'act_resume',
      });
      await waitForSend(api);
      expect(seen).toEqual([]);

      await notifier.handleUpdate(callbackUpdate('act_resume', ALLOWED_USER_ID, 'approve'));
      expect(await pending).toContain('resumed');
      expect(seen).toEqual(['/resume']);
    });

    it('an UNAUTHORISED user cannot approve an exit (the gate is not just a prompt)', async () => {
      const api = new FakeTelegramApi();
      const { handlers, seen } = collectingActions();
      const notifier = buildNotifier(api, { actionHandlers: handlers });

      const pending = notifier.performAction('/exit', '', {
        approvalSummary: 'EXIT',
        requestId: 'act_exit_intruder',
      });
      await waitForSend(api);
      await notifier.handleUpdate(callbackUpdate('act_exit_intruder', INTRUDER_USER_ID, 'approve'));

      // Still pending: the intruder's click changed nothing.
      expect(seen).toEqual([]);
      expect(notifier.pendingCount).toBe(1);

      await notifier.handleUpdate(callbackUpdate('act_exit_intruder', ALLOWED_USER_ID, 'reject'));
      expect(await pending).toContain('not confirmed');
      expect(seen).toEqual([]);
    });

    it('refuses an action when no action handlers are wired', async () => {
      const notifier = buildNotifier(new FakeTelegramApi());
      await expect(
        notifier.performAction('/start', '', { approvalSummary: 'x', requestId: 'r' }),
      ).rejects.toThrow('action handlers are not wired');
    });
  });

  it('refuses to answer a query when no handlers are wired', async () => {
    const notifier = buildNotifier(new FakeTelegramApi());
    await expect(notifier.query('/pools')).rejects.toThrow('query handlers are not wired');
    await expect(notifier.query('/unknown')).rejects.toThrow('unknown query command');
  });

  it('reports a failed send without throwing (alerts are best effort)', async () => {
    const api = new FakeTelegramApi();
    api.failNext = { method: 'sendMessage', status: 503, description: 'Service Unavailable' };
    const { audit, records } = collectingSink();
    const { logger, lines } = collectingLogger();
    const notifier = buildNotifier(api, { audit, logger });

    await expect(notifier.send('critical', 'boom', 'body')).resolves.toBeUndefined();

    expect(lines.some((line) => line.startsWith('error:'))).toBe(true);
    expect(records.map((record) => record.action)).toContain(TELEGRAM_AUDIT_EVENTS.SEND_FAILED);
  });
});

describe('telegram — configuration and helpers', () => {
  it('parses decisions and commands, and rejects malformed payloads', () => {
    expect(parseDecisionCallback('approve:apr_1')).toEqual({
      action: DECISION_CALLBACK_ACTIONS.APPROVE,
      requestId: 'apr_1',
    });
    expect(parseDecisionCallback('reject:apr_1')).toEqual({
      action: DECISION_CALLBACK_ACTIONS.REJECT,
      requestId: 'apr_1',
    });
    expect(parseDecisionCallback('approve:')).toBeNull();
    expect(parseDecisionCallback('delete:apr_1')).toBeNull();
    expect(parseDecisionCallback('nonsense')).toBeNull();

    expect(parseTelegramCommand('/status portfolio')).toEqual({ command: '/status', args: 'portfolio' });
    expect(parseTelegramCommand('/risk@lptrader_bot')).toEqual({ command: '/risk', args: '' });
    expect(parseTelegramCommand('/unknown')).toBeNull();
    expect(parseTelegramCommand('hello')).toBeNull();

    // Telegram caps callback_data at 64 bytes; a long id must fail loudly, not silently truncate.
    expect(() => encodeDecisionCallback(DECISION_CALLBACK_ACTIONS.APPROVE, 'x'.repeat(80))).toThrow(
      '64 bytes',
    );
    expect(encodeDecisionCallback(DECISION_CALLBACK_ACTIONS.APPROVE, 'x'.repeat(50))).toHaveLength(58);
  });

  it('parses TELEGRAM_ALLOWED_USER_IDS strictly (empty means nobody)', () => {
    expect(parseAllowedUserIds('1,2, 3')).toEqual([1, 2, 3]);
    expect(parseAllowedUserIds('42 42')).toEqual([42]);
    expect(parseAllowedUserIds('not-a-number, -5')).toEqual([]);
    expect(parseAllowedUserIds(undefined)).toEqual([]);
    expect(parseAllowedUserIds('')).toEqual([]);
  });

  it('prefers TELEGRAM_ENABLED over the YAML switch for the startup decision', async () => {
    const config = await loadConfig();
    expect(isTelegramEnabledFromEnv(undefined, config)).toBe(config.telegram.enabled);
    expect(isTelegramEnabledFromEnv('1', config)).toBe(true);
    expect(isTelegramEnabledFromEnv('false', config)).toBe(false);
  });

  it('falls back to the contract no-op notifier when telegram is disabled (no approval possible)', async () => {
    const config = await loadConfig();
    const { logger, lines } = collectingLogger();

    const disabled = createNotifierFromConfig(config, {}, { logger });
    expect(disabled).toBe(noopNotifier);
    expect(lines.some((line) => line.includes('BUILD_POSITION and SWITCH_POOL will be blocked'))).toBe(true);
    expect((await disabled.requestApproval(approvalRequest('apr_disabled'))).approved).toBe(false);
  });

  it('falls back to the no-op notifier when the token or chat id is missing', async () => {
    const config = await loadConfig();
    const { logger, lines } = collectingLogger();

    const noToken = createNotifierFromConfig(
      config,
      { TELEGRAM_ENABLED: 'true', TELEGRAM_CHAT_ID: CHAT_ID, TELEGRAM_ALLOWED_USER_IDS: '7' },
      { logger },
    );
    const noChat = createNotifierFromConfig(
      config,
      { TELEGRAM_ENABLED: 'true', TELEGRAM_BOT_TOKEN: OTHER_FAKE_BOT_TOKEN },
      { logger },
    );

    expect(noToken).toBe(noopNotifier);
    expect(noChat).toBe(noopNotifier);
    expect(lines.filter((line) => line.startsWith('error:')).length).toBe(2);
  });

  it('builds a real notifier when the channel is configured, and warns when nobody may approve', async () => {
    const config = await loadConfig();
    const api = new FakeTelegramApi();
    const { logger, lines } = collectingLogger();

    const notifier = createNotifierFromConfig(
      config,
      {
        TELEGRAM_ENABLED: 'true',
        TELEGRAM_BOT_TOKEN: FAKE_BOT_TOKEN,
        TELEGRAM_CHAT_ID: CHAT_ID,
        TELEGRAM_ALLOWED_USER_IDS: '7',
      },
      { logger },
    );

    expect(notifier).toBeInstanceOf(TelegramNotifier);
    expect(notifier).not.toBe(noopNotifier);

    const nobody = createNotifierFromConfig(
      config,
      {
        TELEGRAM_ENABLED: 'true',
        TELEGRAM_BOT_TOKEN: FAKE_BOT_TOKEN,
        TELEGRAM_CHAT_ID: CHAT_ID,
        TELEGRAM_ALLOWED_USER_IDS: '',
      },
      { logger, fetchImpl: api.fetch },
    );
    expect(nobody).toBeInstanceOf(TelegramNotifier);
    expect(
      lines.some((line) => line.includes('TELEGRAM_ALLOWED_USER_IDS is empty')),
    ).toBe(true);
  });

  it('verifies the channel read-only (getMe + getChat) and reports a mismatch as a failure', async () => {
    const calls: string[] = [];
    const okFetch: FetchLike = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = url.slice(url.lastIndexOf('/') + 1);
      calls.push(method);
      void init;
      if (method === 'getMe') {
        return jsonResponse({ ok: true, result: { id: 999, username: 'lptrader_bot', is_bot: true } });
      }
      return jsonResponse({ ok: true, result: { id: Number(CHAT_ID), type: 'private' } });
    };
    const notifier = new TelegramNotifier({
      botToken: FAKE_BOT_TOKEN,
      chatId: CHAT_ID,
      allowedUserIds: [ALLOWED_USER_ID],
      fetchImpl: okFetch,
      apiBaseUrl: 'https://telegram.invalid',
    });

    const me = await notifier.verifyChannel();

    expect(me.username).toBe('lptrader_bot');
    // Read-only: exactly getMe + getChat, no sendMessage and no getUpdates.
    expect(calls).toEqual(['getMe', 'getChat']);

    const wrongChatFetch: FetchLike = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = url.slice(url.lastIndexOf('/') + 1);
      if (method === 'getMe') {
        return jsonResponse({ ok: true, result: { id: 999, username: 'lptrader_bot' } });
      }
      return jsonResponse({ ok: true, result: { id: 999_999, type: 'private' } });
    };
    const wrongChat = new TelegramNotifier({
      botToken: FAKE_BOT_TOKEN,
      chatId: CHAT_ID,
      allowedUserIds: [ALLOWED_USER_ID],
      fetchImpl: wrongChatFetch,
      apiBaseUrl: 'https://telegram.invalid',
    });
    await expect(wrongChat.verifyChannel()).rejects.toThrow('resolves to a different chat');
  });

  it('never leaks the bot token through an API error or a log line', () => {
    const error = new TelegramApiError('sendMessage', 401, 'Unauthorized');
    expect(error.message).not.toContain(FAKE_BOT_TOKEN);
    expect(JSON.stringify(error)).not.toContain(FAKE_BOT_TOKEN);
    expect(renderAlert('critical', 'title', 'body', { traceId: 'trace-1' })).toContain('trace: trace-1');
  });
});
