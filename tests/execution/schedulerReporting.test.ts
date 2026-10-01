import { describe, expect, it } from 'vitest';
import { Scheduler } from '../../src/execution/scheduler.ts';

/**
 * The reporting contract the startup handler depends on.
 *
 * Measured failure this prevents: an operator launched a healthy process, saw no output for several
 * minutes, and concluded it was stuck — because the handler printed only failures while the first scan
 * takes ~4 minutes. Silence meant "working", and nothing distinguished it from "dead".
 *
 * Asserted here on the REPORT rather than on the printed line: the formatting lives in `main.ts`, and what
 * the scheduler owes its callers is a report for every beat, carrying whether it succeeded and when it ran.
 */
describe('the scheduler reports every beat, not only the failures', () => {
  it('emits a report for a successful beat, with timing', async () => {
    const reports: unknown[] = [];
    const scheduler = new Scheduler({
      // A positive interval: `0` means DISABLED, so a zero here would skip the beat and assert nothing.
      cadences: [{ name: 'test-beat', intervalSeconds: 1, run: async () => {} }],
      onReport: (report) => reports.push(report),
    });

    await scheduler.tick();

    expect(reports).toHaveLength(1);
    const report = reports[0] as { name: string; ok: boolean; startedAt: string; finishedAt: string };
    expect(report.name).toBe('test-beat');
    // The success signal the old handler discarded.
    expect(report.ok).toBe(true);
    // Both timestamps, so a caller can report elapsed time without owning a clock.
    expect(Date.parse(report.finishedAt)).toBeGreaterThanOrEqual(Date.parse(report.startedAt));
  });

  it('emits a report carrying the error when a beat fails', async () => {
    const reports: unknown[] = [];
    const scheduler = new Scheduler({
      cadences: [
        {
          name: 'failing-beat',
          intervalSeconds: 1,
          run: async () => {
            throw new Error('provider unreachable');
          },
        },
      ],
      onReport: (report) => reports.push(report),
    });

    await scheduler.tick();

    expect(reports).toHaveLength(1);
    const report = reports[0] as { ok: boolean; error?: string };
    expect(report.ok).toBe(false);
    expect(report.error).toMatch(/provider unreachable/);
  });

  it('the main handler prints on success — the regression that caused the silence', async () => {
    // Read the source rather than the process: asserting the actual stdout of `main.ts` would need a full
    // runtime, a chain and a keystore, and the property under test is that the success branch writes.
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/main.ts', 'utf8');
    const handler = source.slice(source.indexOf('const scheduler = new Scheduler('));
    const body = handler.slice(0, handler.indexOf('});'));

    expect(body).toMatch(/if \(report\.ok\) \{/);
    expect(body).toMatch(/process\.stdout\.write\(`\[\$\{stamp\}\] \$\{report\.name\} ok/);
  });
});
