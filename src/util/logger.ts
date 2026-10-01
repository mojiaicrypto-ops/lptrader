/**
 * A logger the build path can actually reach.
 *
 * ## Why this exists
 *
 * Every module on the money path — the orchestrator, the executor, the DEX adapter, the funding planner —
 * had NO logging at all. A failed build produced a single line on the operator's phone and nothing in the
 * log: not which pool was chosen, not the amounts, not which leg failed, not the calldata. Diagnosing it
 * meant reconstructing the transaction by hand from a partially pasted error.
 *
 * ## The shape
 *
 * ```text
 * [12:34:56.789] build    selecting from 11 candidate pools
 * [12:34:56.812] build    candidate …44c2cdb693 rejected: TVL_BELOW_MINIMUM
 * [12:34:57.100] build    accepted …e9b9998b2e (APR 29.4%)
 * [12:34:57.300] plan     capital 700.00 -> amount0 452588602893567244 / amount1 164964922289086812792
 * [12:34:57.500] quote    USDT -> AAPLB  amountIn=150550715617909772129 out=...
 * [12:34:57.510] gate     ok (impact 0.11%, slippage 0.30%)
 * [12:34:58.000] execute  estimating gas…
 * [12:34:58.900] execute  FAILED: STF
 * ```
 *
 * The prefix is a scope, not a severity: the operator reads a build as a sequence of steps, and being able
 * to `grep '^\[.*\] build'` is what makes one failure readable.
 *
 * ## Levels are real, not decoration
 *
 * `debug` is off unless `LP_LOG_LEVEL=debug`. The verbose per-candidate lines would otherwise make a normal
 * start unreadable, and an unreadable log is the same as no log. Failures are always written.
 *
 * ## Never throws
 *
 * A logger that can fail the thing it is observing is worse than none, so every write is guarded. A closed
 * stdout during shutdown must not turn a successful build into an error.
 */
import type { IsoTimestamp } from '../types/primitives.ts';

export const LOG_LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
} as const;
export type LogLevel = keyof typeof LOG_LEVELS;

export interface Logger {
  debug(scope: string, message: string, fields?: Readonly<Record<string, unknown>>): void;
  info(scope: string, message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(scope: string, message: string, fields?: Readonly<Record<string, unknown>>): void;
  error(scope: string, message: string, fields?: Readonly<Record<string, unknown>>): void;
}

/** Scopes are fixed so a log can be filtered by the stage of a build, not by string matching. */
export const LOG_SCOPES = {
  build: 'build',
  plan: 'plan',
  quote: 'quote',
  gate: 'gate',
  execute: 'execute',
  fund: 'fund',
} as const;
export type LogScope = (typeof LOG_SCOPES)[keyof typeof LOG_SCOPES];

const STREAM_FOR_LEVEL: Readonly<Record<LogLevel, 'stdout' | 'stderr'>> = {
  debug: 'stdout',
  info: 'stdout',
  warn: 'stderr',
  error: 'stderr',
};

/**
 * Render a field value for a log line without losing precision.
 *
 * Bigints are the whole reason this exists: the amounts on the money path are bigints, `JSON.stringify`
 * throws on them, and a diagnostic that crashes is worse than none. A raw `150550715617909772129` is also
 * unreadable next to a human amount, so both are shown.
 */
function renderValue(value: unknown): string {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value, (_key, val) => (typeof val === 'bigint' ? `${val.toString()}n` : val));
  } catch {
    return String(value);
  }
}

function renderFields(fields: Readonly<Record<string, unknown>> | undefined): string {
  if (fields === undefined) return '';
  const entries = Object.entries(fields);
  if (entries.length === 0) return '';
  return ` ${entries.map(([key, value]) => `${key}=${renderValue(value)}`).join(' ')}`;
}

/** Local wall-clock time with milliseconds: an operator correlating with Telegram needs the second. */
function stamp(now: Date): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
}

export interface CreateLoggerOptions {
  readonly level?: LogLevel;
  /** Injected so a test can capture output and a replay can reproduce timestamps. */
  readonly write?: (stream: 'stdout' | 'stderr', line: string) => void;
  readonly now?: () => Date;
}

/**
 * Build a logger at `level` (default `info`), or from `LP_LOG_LEVEL` when `level` is omitted.
 *
 * The environment is consulted because the operator sets verbosity without editing code, and a debug level
 * that requires a rebuild would not be used at the moment it is needed.
 */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const envLevel = process.env['LP_LOG_LEVEL'];
  const level =
    options.level ??
    (envLevel !== undefined && envLevel in LOG_LEVELS ? (envLevel as LogLevel) : 'info');
  const threshold = LOG_LEVELS[level];
  const write =
    options.write ??
    ((stream: 'stdout' | 'stderr', line: string): void => {
      try {
        process[stream].write(`${line}\n`);
      } catch {
        // A closed stream during shutdown must not fail the operation being logged.
      }
    });
  const now = options.now ?? ((): Date => new Date());

  const emit = (
    levelName: LogLevel,
    scope: string,
    message: string,
    fields?: Readonly<Record<string, unknown>>,
  ): void => {
    if (LOG_LEVELS[levelName] < threshold) return;
    // Guarded here rather than only inside the default writer: an INJECTED writer can throw too (a closed
    // pipe, a full disk), and a logger that fails the operation it observes is worse than none.
    try {
      write(STREAM_FOR_LEVEL[levelName], `[${stamp(now())}] ${scope}  ${message}${renderFields(fields)}`);
    } catch {
      // Deliberately swallowed.
    }
  };

  return {
    debug: (scope, message, fields) => emit('debug', scope, message, fields),
    info: (scope, message, fields) => emit('info', scope, message, fields),
    warn: (scope, message, fields) => emit('warn', scope, message, fields),
    error: (scope, message, fields) => emit('error', scope, message, fields),
  };
}

/** A logger that writes nothing. For tests and for callers that genuinely have no output. */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Format an ISO timestamp for the log, when a caller only has the ISO form. */
export function isoToStamp(at: IsoTimestamp): string {
  const parsed = Date.parse(at);
  return Number.isFinite(parsed) ? stamp(new Date(parsed)) : at;
}
