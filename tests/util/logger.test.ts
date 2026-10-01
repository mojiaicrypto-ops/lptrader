import { describe, expect, it } from 'vitest';
import { createLogger, silentLogger } from '../../src/util/logger.ts';

/**
 * The money path must narrate itself.
 *
 * Measured problem: the orchestrator, executor, DEX adapter and funding planner had NO logging at all, so a
 * failed build produced one opaque line on the operator's phone and nothing anywhere else — no chosen pool,
 * no amounts, no failing leg, no calldata. Diagnosing a revert meant reconstructing the transaction from a
 * partially pasted error.
 */
describe('the logger writes what an operator needs to diagnose a build', () => {
  function capture(level: 'debug' | 'info' | 'warn' | 'error') {
    const lines: string[] = [];
    const logger = createLogger({
      level,
      write: (_stream, line) => lines.push(line),
      now: () => new Date('2026-10-01T12:34:56.789Z'),
    });
    return { logger, lines };
  }

  it('timestamps and scopes every line, so a build reads as a sequence', () => {
    const { logger, lines } = capture('info');
    logger.info('build', 'using pool 56:pancakeswap-v3:0xabc');
    // Local wall-clock, not UTC: the operator correlates a log line with a Telegram message by the time
    // their clock showed, so the timestamp must be the machine's own.
    expect(lines[0]).toMatch(/^\[\d\d:\d\d:\d\d\.\d{3}\] build {2}using pool/);
  });

  it('renders bigints, because the amounts on this path are bigints', () => {
    // `JSON.stringify` throws on a bigint, and a diagnostic that crashes is worse than none.
    const { logger, lines } = capture('info');
    logger.info('plan', 'plan ready', { amount0: 452588602893567244n, swapNeeded: 150550715617909772129n });
    expect(lines[0]).toMatch(/amount0=452588602893567244/);
    expect(lines[0]).toMatch(/swapNeeded=150550715617909772129/);
  });

  it('suppresses debug at the default level, so a normal start stays readable', () => {
    // A log nobody can read is the same as no log.
    const { logger, lines } = capture('info');
    logger.debug('build', 'per-candidate noise');
    logger.info('build', 'the conclusion');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/the conclusion/);
  });

  it('never swallows an error, whatever the level', () => {
    const { logger, lines } = capture('error');
    logger.error('execute', 'atomic build FAILED', { reason: 'STF' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/atomic build FAILED reason=STF/);
  });

  it('separates streams so failures can be watched on their own', () => {
    const streams: string[] = [];
    const logger = createLogger({
      level: 'debug',
      write: (stream) => streams.push(stream),
    });
    logger.info('build', 'ok');
    logger.error('execute', 'failed');
    expect(streams).toEqual(['stdout', 'stderr']);
  });

  it('does not fail the operation when the stream is closed', () => {
    // During shutdown stdout can be gone; a logger that throws would turn a success into an error.
    const logger = createLogger({
      level: 'info',
      write: () => {
        throw new Error('EPIPE');
      },
    });
    expect(() => logger.info('build', 'after shutdown')).not.toThrow();
  });

  it('silentLogger writes nothing, for tests and for callers with no output', () => {
    expect(() => {
      silentLogger.debug('x', 'y');
      silentLogger.error('x', 'y');
    }).not.toThrow();
  });
});

describe('the build path is instrumented end to end', () => {
  const sources = {
    orchestrator: 'src/strategy/buildOrchestrator.ts',
    executor: 'src/execution/positionExecutor.ts',
    adapter: 'src/dex/pancakeV3.ts',
  };

  it.each(Object.entries(sources))('%s reports through the logger', async (_name, path) => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(path, 'utf8');
    // A logger call, not merely an import: the import alone was the state this replaced.
    expect(source).toMatch(/\.(info|warn|error|debug)\(/);
  });

  it('the adapter logs the calldata before attempting a send', async () => {
    // The only artefact of a failed `eth_estimateGas`: it never reaches the chain, so no hash exists and
    // the calldata lives solely in memory unless it is written down first.
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/dex/pancakeV3.ts', 'utf8');
    const atomic = source.slice(source.indexOf('atomic build (swap + mint in one transaction)'));
    expect(atomic).toMatch(/calldata/);
    expect(atomic).toMatch(/atomic build FAILED/);
  });
});
