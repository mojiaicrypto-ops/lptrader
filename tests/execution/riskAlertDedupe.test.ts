import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * The risk beats share one reporter, and that reporter must pass a dedupe key.
 *
 * Both `portfolio-monitor` (5m) and `pool-health` (15m) call `reportRiskRound`, so a condition that
 * persists produced two byte-identical messages seconds apart — observed live. The notifier's dedupe
 * machinery already existed and had never fired, because no production caller supplied a key.
 *
 * Asserted by reading the source rather than by exercising the cadences: constructing two beats needs a
 * chain, a store and a live scan, and the property under test is a single call-site argument. The
 * behavioural half (a repeated key collapses, changed text does not) is covered in the notifier's own
 * tests.
 */
describe('risk alerts are deduplicated across the two beats that share the reporter', () => {
  it('passes a dedupeKey derived from the action, not from the message text', () => {
    const source = readFileSync('src/runtime.ts', 'utf8');
    const send = source.slice(source.indexOf('async function reportRiskRound'));

    // A key derived from the action: the same condition with a marginally different NAV is still one thing
    // to report. Keying on the text would let every beat through, since NAV moves between them.
    expect(send).toMatch(/dedupeKey:\s*`risk:\$\{plan\.action\}`/);
  });

  it('does not forward the engine\'s raw reasons to the operator', () => {
    const source = readFileSync('src/execution/riskWiring.ts', 'utf8');
    const fn = source.slice(source.indexOf('export function describeRiskAction'));

    // The reasons carry clause numbers (`§105 below the 20.00% warning floor`). They belong in the audit
    // trail, which the caller writes; showing them on a phone is how an alert stops being read.
    expect(fn).not.toMatch(/note:\s*reasons/);
    expect(fn).toContain('plan.reasons');
  });
});
