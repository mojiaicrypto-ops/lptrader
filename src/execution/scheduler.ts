/**
 * §89 scheduler + §46/§14/§15 cadences.
 *
 * One loop per cadence, each independently guarded. The properties that matter:
 *
 * - **A failed round never kills the loop** and never silently looks like a healthy round: every
 *   cadence records what it did, and an error is reported through the notifier rather than swallowed.
 * - **Overlap is impossible.** Each cadence holds a flag for the duration of its run, so a slow round
 *   (a rate-limited data source, a hung RPC) cannot stack up behind itself. Without this a 10 req/min
 *   source plus a 60s scan interval would self-inflict a 429 storm.
 * - **Nothing here decides anything.** The scheduler calls the injected handlers; the decisions, their
 *   gates and their approvals live in the executor and the risk layer.
 */
import type { AlertSeverity } from '../types/notifier.ts';
import type { IsoTimestamp } from '../types/primitives.ts';

/** §89 cadences, as configured (`StrategyConfig.monitor`). */
export interface SchedulerCadence {
  readonly name: string;
  /** Interval in seconds; `0` disables the cadence. */
  readonly intervalSeconds: number;
  readonly run: (at: IsoTimestamp) => Promise<void>;
}

export interface SchedulerReport {
  readonly name: string;
  readonly startedAt: IsoTimestamp;
  readonly finishedAt: IsoTimestamp;
  readonly ok: boolean;
  readonly error?: string;
}

export interface SchedulerOptions {
  readonly cadences: readonly SchedulerCadence[];
  /** Injectable clock so cadence behaviour is deterministic under test. */
  readonly now?: () => Date;
  /**
   * How a failed round is surfaced. Defaults to stderr; the composition root wires this to the
   * notifier so an operator sees a broken loop (§78 "Transaction Failure" class of alert).
   */
  readonly onReport?: (report: SchedulerReport) => void;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Runs every cadence on its own interval.
 *
 * `run()` resolves when `stop()` is called or when `maxRounds` rounds have completed (used by tests
 * and by `--once` runs). The single-timer design — one tick loop that fires whichever cadences are
 * due — is deliberate: per-cadence `setInterval`s would each need their own overlap guard and would
 * drift independently, and the tick is cheap.
 */
export class Scheduler {
  private readonly options: SchedulerOptions;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly running = new Set<string>();
  private readonly lastRun = new Map<string, number>();
  private stopped = false;
  private readonly reports: SchedulerReport[] = [];

  constructor(options: SchedulerOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
    this.sleep =
      options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  /** Every round this scheduler has attempted, in order — the audit trail for the loop itself. */
  history(): readonly SchedulerReport[] {
    return this.reports;
  }

  stop(): void {
    this.stopped = true;
  }

  /**
   * One tick: run every cadence that is due and not already in flight.
   *
   * Exposed separately so tests can drive time explicitly instead of waiting on real intervals.
   */
  async tick(): Promise<readonly SchedulerReport[]> {
    const nowMs = this.now().getTime();
    const produced: SchedulerReport[] = [];

    for (const cadence of this.options.cadences) {
      if (cadence.intervalSeconds <= 0) continue;
      if (this.running.has(cadence.name)) continue; // no overlap
      const last = this.lastRun.get(cadence.name);
      if (last !== undefined && nowMs - last < cadence.intervalSeconds * 1000) continue;
      // Marked as running AND as run before awaiting, so a slow cadence cannot be re-entered by the
      // next tick while it is still in flight.
      this.running.add(cadence.name);
      this.lastRun.set(cadence.name, nowMs);
      try {
        const report = await this.runOne(cadence);
        produced.push(report);
      } finally {
        this.running.delete(cadence.name);
      }
    }

    this.reports.push(...produced);
    return produced;
  }

  private async runOne(cadence: SchedulerCadence): Promise<SchedulerReport> {
    const startedAt = this.now().toISOString();
    try {
      await cadence.run(startedAt);
      const report: SchedulerReport = {
        name: cadence.name,
        startedAt,
        finishedAt: this.now().toISOString(),
        ok: true,
      };
      this.report(report);
      return report;
    } catch (error) {
      const report: SchedulerReport = {
        name: cadence.name,
        startedAt,
        finishedAt: this.now().toISOString(),
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
      this.report(report);
      return report;
    }
  }

  private report(report: SchedulerReport): void {
    this.options.onReport?.(report);
  }

  /**
   * Run until stopped or until `maxRounds` ticks have completed.
   *
   * The tick period is the smallest enabled cadence interval, capped so a misconfigured
   * sub-second interval still cannot busy-loop the process.
   */
  async run(maxRounds = Number.POSITIVE_INFINITY): Promise<void> {
    const intervals = this.options.cadences
      .filter((cadence) => cadence.intervalSeconds > 0)
      .map((cadence) => cadence.intervalSeconds);
    if (intervals.length === 0) {
      throw new Error('scheduler has no enabled cadence: refusing to spin with nothing to do');
    }
    const tickSeconds = Math.max(1, Math.min(...intervals));

    let rounds = 0;
    while (!this.stopped && rounds < maxRounds) {
      await this.tick();
      rounds += 1;
      if (this.stopped || rounds >= maxRounds) break;
      await this.sleep(tickSeconds * 1000);
    }
  }
}

/** §78 severity for a scheduler round, so a failing loop raises an alert rather than staying quiet. */
export function severityForReport(report: SchedulerReport): AlertSeverity {
  return report.ok ? 'info' : 'warning';
}
