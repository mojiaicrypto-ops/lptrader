import { describe, expect, it, vi } from 'vitest';
import { Scheduler, severityForReport } from '../../src/execution/scheduler.ts';

/** A clock the test drives explicitly, so cadence behaviour never depends on wall time. */
function fakeClock(startMs = 1_700_000_000_000) {
  let nowMs = startMs;
  return {
    now: () => new Date(nowMs),
    advance(seconds: number) {
      nowMs += seconds * 1000;
    },
  };
}

describe('Scheduler (§89 cadences)', () => {
  it('runs a cadence when it is due and records a successful round', async () => {
    const clock = fakeClock();
    const run = vi.fn(async () => {});
    const scheduler = new Scheduler({
      cadences: [{ name: 'monitor', intervalSeconds: 300, run }],
      now: clock.now,
    });

    const reports = await scheduler.tick();

    expect(run).toHaveBeenCalledTimes(1);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.ok).toBe(true);
  });

  it('does NOT run a cadence before its interval elapses', async () => {
    const clock = fakeClock();
    const run = vi.fn(async () => {});
    const scheduler = new Scheduler({
      cadences: [{ name: 'monitor', intervalSeconds: 300, run }],
      now: clock.now,
    });

    await scheduler.tick();
    clock.advance(299);
    const second = await scheduler.tick();

    expect(run).toHaveBeenCalledTimes(1);
    expect(second).toEqual([]);
  });

  it('runs again once the interval has elapsed', async () => {
    const clock = fakeClock();
    const run = vi.fn(async () => {});
    const scheduler = new Scheduler({
      cadences: [{ name: 'monitor', intervalSeconds: 300, run }],
      now: clock.now,
    });

    await scheduler.tick();
    clock.advance(300);
    await scheduler.tick();

    expect(run).toHaveBeenCalledTimes(2);
  });

  it('never overlaps a cadence with itself, even when a round outlives its interval', async () => {
    // The safety property: a hung or rate-limited round must not stack up behind itself. A 10 req/min
    // source plus a short interval would otherwise self-inflict a 429 storm.
    const clock = fakeClock();
    let release: (() => void) | undefined;
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const scheduler = new Scheduler({
      cadences: [{ name: 'monitor', intervalSeconds: 1, run }],
      now: clock.now,
    });

    const first = scheduler.tick();
    clock.advance(600);
    // Second tick while the first is still in flight: must be a no-op for this cadence.
    const second = await scheduler.tick();
    expect(second).toEqual([]);
    expect(run).toHaveBeenCalledTimes(1);

    release?.();
    await first;
  });

  it('records a failed round and keeps going instead of killing the loop', async () => {
    const clock = fakeClock();
    let calls = 0;
    const reports: string[] = [];
    const scheduler = new Scheduler({
      cadences: [
        {
          name: 'flaky',
          intervalSeconds: 1,
          run: async () => {
            calls += 1;
            if (calls === 1) throw new Error('source unreachable');
          },
        },
      ],
      now: clock.now,
      onReport: (report) => {
        reports.push(report.ok ? 'ok' : `fail:${report.error ?? ''}`);
      },
    });

    const first = await scheduler.tick();
    expect(first[0]?.ok).toBe(false);
    expect(first[0]?.error).toBe('source unreachable');

    clock.advance(1);
    const second = await scheduler.tick();
    expect(second[0]?.ok).toBe(true);

    // The failure was surfaced, not swallowed.
    expect(reports).toEqual(['fail:source unreachable', 'ok']);
  });

  it('skips disabled cadences (interval 0) entirely', async () => {
    const clock = fakeClock();
    const disabled = vi.fn(async () => {});
    const enabled = vi.fn(async () => {});
    const scheduler = new Scheduler({
      cadences: [
        { name: 'off', intervalSeconds: 0, run: disabled },
        { name: 'on', intervalSeconds: 60, run: enabled },
      ],
      now: clock.now,
    });

    await scheduler.tick();

    expect(disabled).not.toHaveBeenCalled();
    expect(enabled).toHaveBeenCalledTimes(1);
  });

  it('runs only the cadences whose own interval is due', async () => {
    const clock = fakeClock();
    const fast = vi.fn(async () => {});
    const slow = vi.fn(async () => {});
    const scheduler = new Scheduler({
      cadences: [
        { name: 'portfolio', intervalSeconds: 300, run: fast },
        { name: 'scan', intervalSeconds: 3600, run: slow },
      ],
      now: clock.now,
    });

    await scheduler.tick();
    clock.advance(300);
    await scheduler.tick();

    expect(fast).toHaveBeenCalledTimes(2);
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it('marks a cadence as run before awaiting it, so a slow round cannot be re-entered', async () => {
    const clock = fakeClock();
    let entered = 0;
    let release: (() => void) | undefined;
    const scheduler = new Scheduler({
      cadences: [
        {
          name: 'slow',
          intervalSeconds: 1,
          run: async () => {
            entered += 1;
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          },
        },
      ],
      now: clock.now,
    });

    const first = scheduler.tick();
    clock.advance(10);
    await scheduler.tick();

    expect(entered).toBe(1);
    release?.();
    await first;
  });

  it('ties the tick period to the smallest enabled cadence and does not busy-loop', async () => {
    const clock = fakeClock();
    const sleeps: number[] = [];
    const run = vi.fn(async () => {});
    const scheduler = new Scheduler({
      cadences: [{ name: 'monitor', intervalSeconds: 300, run }],
      now: clock.now,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock.advance(ms / 1000);
      },
    });

    await scheduler.run(2);

    // 300s cadence → 300s tick period; two rounds means exactly one sleep between them.
    expect(sleeps).toEqual([300_000]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('refuses to spin when nothing is enabled rather than looping on a no-op', async () => {
    const scheduler = new Scheduler({
      cadences: [{ name: 'off', intervalSeconds: 0, run: async () => {} }],
      now: fakeClock().now,
    });

    await expect(scheduler.run(1)).rejects.toThrow(/no enabled cadence/);
  });

  it('stop() ends run() early', async () => {
    const clock = fakeClock();
    const scheduler = new Scheduler({
      cadences: [{ name: 'monitor', intervalSeconds: 300, run: async () => {} }],
      now: clock.now,
      sleep: async (ms) => {
        clock.advance(ms / 1000);
      },
    });

    const running = scheduler.run(10);
    scheduler.stop();
    await running;

    expect(scheduler.history().length).toBeLessThanOrEqual(2);
  });

  it('keeps a history of every round, in order, as the loop audit trail', async () => {
    const clock = fakeClock();
    const scheduler = new Scheduler({
      cadences: [
        { name: 'a', intervalSeconds: 1, run: async () => {} },
        { name: 'b', intervalSeconds: 1, run: async () => {} },
      ],
      now: clock.now,
    });

    await scheduler.tick();
    expect(scheduler.history().map((report) => report.name)).toEqual(['a', 'b']);
  });

  it('grades a failed round as a warning so a broken loop is visible', () => {
    const base = { name: 'x', startedAt: 't', finishedAt: 't' } as const;
    expect(severityForReport({ ...base, ok: true })).toBe('info');
    expect(severityForReport({ ...base, ok: false, error: 'boom' })).toBe('warning');
  });
});
