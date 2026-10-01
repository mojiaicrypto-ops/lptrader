import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * An update must not be lost when handling it fails.
 *
 * Telegram deletes an update once `getUpdates` is called past its id. Advancing the offset BEFORE handling
 * therefore destroys the update if anything throws — no redelivery, and the operator's button click
 * silently vanishes. Reported symptom: "I click Approve and nothing happens, as if I had not clicked".
 */
describe('the poll loop does not lose an update it failed to handle', () => {
  const source = readFileSync('src/notify/telegram.ts', 'utf8');
  const loop = source.slice(source.indexOf('private async pollLoop'));

  it('advances the offset only after handleUpdate returns', () => {
    const handleAt = loop.indexOf('await this.handleUpdate(update);');
    const offsetAt = loop.indexOf('this.offset = Math.max(');
    expect(handleAt).toBeGreaterThan(-1);
    expect(offsetAt).toBeGreaterThan(-1);
    // The ordering is the whole property: handling first, then committing the offset.
    expect(handleAt).toBeLessThan(offsetAt);
  });

  it('contains a handling failure instead of letting it escape the loop', () => {
    // A throw that reaches the outer catch would abandon the rest of this batch too.
    expect(loop).toMatch(/try \{\s*await this\.handleUpdate\(update\);/);
    expect(loop).toMatch(/handling an update failed; it will be retried/);
  });
});

describe('the notifier reports its own diagnostics', () => {
  it('is constructed with a logger that writes, not the silent default', () => {
    // `createNotifierFromConfig` defaults to a logger whose methods are empty. With nothing overriding it,
    // every Telegram warning — failed polls, ignored callbacks, refused decisions — went nowhere, which is
    // what made "clicked and nothing happened" impossible to diagnose.
    const runtime = readFileSync('src/runtime.ts', 'utf8');
    const construction = runtime.slice(runtime.indexOf('createNotifierFromConfig(config, env, {'));
    expect(construction.slice(0, 1200)).toMatch(/logger: \{/);
    expect(construction.slice(0, 1200)).toMatch(/process\.stderr\.write/);
  });
});
