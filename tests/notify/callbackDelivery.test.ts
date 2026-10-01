import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * A blocking command must not stop the channel from reading the next update.
 *
 * Measured symptom, reported twice: `/start` produced an Approve/Reject button, and after that NOTHING
 * worked — clicking the button did nothing, and `/help` or `/status` got no reply either. The channel was
 * not broken; it was blocked.
 *
 * `/start` does not return until the build it triggers has passed the approval gate, which waits for the
 * operator's click — up to 30 minutes. Awaiting it inside the poll loop meant the loop never went back to
 * `getUpdates`, so the click it was waiting for sat unread in Telegram's queue. The deadlock was total and
 * self-inflicted: the thing being awaited could only arrive through the loop being awaited in.
 */

/** The poll loop's code with comments removed.
 *
 * Stripping is necessary, not cosmetic: the comment explaining this bug NAMES the pattern that caused it
 * (`await this.handleUpdate`), so matching against prose would fail on the documentation of the fix.
 */
function pollLoopCode(): string {
  const source = readFileSync('src/notify/telegram.ts', 'utf8');
  const start = source.indexOf('private async pollLoop');
  // Up to the NEXT method: `dispatch` legitimately awaits handleUpdate, and including it would make this
  // assertion fail on code that is correct.
  const end = source.indexOf('private async dispatch', start);
  const raw = source.slice(start, end);
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

describe('the poll loop keeps reading while a command is still running', () => {
  it('does NOT await the handler inside the loop', () => {
    // `await this.handleUpdate(...)` here is the deadlock. Dispatch must be fire-and-forget.
    expect(pollLoopCode()).not.toMatch(/await this\.handleUpdate\(/);
    expect(pollLoopCode()).toMatch(/void this\.dispatch\(update\)/);
  });

  it('commits the offset before dispatching, so the update is not re-read', () => {
    const loop = pollLoopCode();
    const offsetAt = loop.indexOf('this.offset = Math.max(');
    const dispatchAt = loop.indexOf('void this.dispatch(update)');
    expect(offsetAt).toBeGreaterThan(-1);
    expect(dispatchAt).toBeGreaterThan(-1);
    expect(offsetAt).toBeLessThan(dispatchAt);
  });

  it('reports a handler failure instead of losing it silently', () => {
    expect(readFileSync('src/notify/telegram.ts', 'utf8')).toMatch(/handling an update failed/);
  });
});

describe('the notifier reports its own diagnostics', () => {
  it('is constructed with a logger that writes, not the silent default', () => {
    // `createNotifierFromConfig` defaults to a logger whose methods are empty. With nothing overriding it,
    // every Telegram warning — failed polls, ignored callbacks, refused decisions — went nowhere, which is
    // what made "clicked and nothing happened" impossible to diagnose.
    const runtime = readFileSync('src/runtime.ts', 'utf8');
    const construction = runtime.slice(runtime.indexOf('createNotifierFromConfig(config, env, {'));
    const head = construction.slice(0, 1500);
    expect(head).toMatch(/logger: \{/);
    expect(head).toMatch(/process\.stderr\.write/);
  });
});
