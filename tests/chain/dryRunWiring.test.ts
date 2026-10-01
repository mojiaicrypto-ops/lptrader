import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * `DRY_RUN=1` must reach the ONLY layer that can refuse to broadcast.
 *
 * The regression this pins: `BscAdapter` was constructed without `dryRun`, so it defaulted to `false` and
 * would have sent every transaction for real — while the startup banner printed
 * `dry-run: yes (no transaction will be sent)`. A safety switch that reports itself as on and is off is
 * worse than no switch, because it is trusted.
 *
 * Asserted by reading the source rather than by exercising a broadcast: sending a real transaction needs a
 * funded key on a live chain, and the property under test is one constructor argument. The adapter's own
 * behaviour (refuse before broadcast when `dryRun` is set) is covered by its own tests.
 */
describe('the dry-run flag is plumbed to the chain adapter', () => {
  const source = readFileSync('src/runtime.ts', 'utf8');

  it('constructs the chain adapter with the resolved dryRun', () => {
    const construction = source.slice(source.indexOf('const chain = new BscAdapter('));
    const body = construction.slice(0, construction.indexOf('});'));
    expect(body).toMatch(/dryRun,/);
  });

  it('resolves it from the caller-supplied env, not from process.env', () => {
    // `buildRuntime` takes an explicit env. Consulting the global one would let the two disagree about
    // whether real money may move — and the global one is what a test would silently be reading.
    expect(source).toMatch(/const dryRun = \(env\['DRY_RUN'\] \?\? '1'\) !== '0';/);
    expect(source).not.toMatch(/dryRun: \(process\.env\['DRY_RUN'\]/);
  });

  it('reports and enforces the same value', () => {
    // The banner and the adapter must not be able to diverge.
    expect(source).toMatch(/dryRun: runtime\.dryRun/);
  });
});
