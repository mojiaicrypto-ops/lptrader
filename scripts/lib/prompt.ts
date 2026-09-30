/**
 * Shared interactive-prompt helpers for the keystore CLIs.
 *
 * Extracted rather than duplicated because three scripts now need the same behaviour, and the behaviour
 * is security-relevant: a prompt that echoes, or a pipe that loses a line, changes what lands on disk.
 *
 * ## The two input modes, and why both exist
 * - **TTY** → raw-mode reading with echo disabled. A passphrase typed into a terminal must not appear on
 *   screen: screen content survives in scroll-back, screen recordings and shared sessions.
 * - **Pipe** (non-interactive / CI / smoke tests) → lines are drained once into a queue. Echo suppression
 *   is unnecessary because a pipe does not echo, but the *draining* matters: creating a fresh `readline`
 *   per prompt consumes the whole buffered chunk on close, so the second prompt would see end-of-stream
 *   instead of the next line.
 *
 * `readVisible` exists for the one prompt that is deliberately not secret (the EXPORT confirmation word),
 * so that the "no echo" rule stays attached to things that are actually secret.
 */
import { createInterface } from 'node:readline';
import { stat } from 'node:fs/promises';

/** Lines buffered from a pipe, drained once for the whole process. */
const pipedLines: string[] = [];
let pipedLinesLoaded = false;

async function ensurePipedLines(): Promise<void> {
  if (pipedLinesLoaded) return;
  pipedLinesLoaded = true;
  const rl = createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) {
    pipedLines.push(line);
  }
}

async function nextPipedLine(): Promise<string> {
  await ensurePipedLines();
  const next = pipedLines.shift();
  if (next === undefined) {
    throw new Error('stdin closed before a value was provided');
  }
  return next;
}

/** Read a secret from a TTY with echo disabled (raw mode; no private readline API involved). */
function readHiddenFromTty(prompt: string): Promise<string> {
  const { promise, resolve } = Promise.withResolvers<string>();
  const stdin = process.stdin;
  process.stdout.write(prompt);
  const previousRaw = stdin.isRaw === true;
  stdin.setRawMode(true);
  stdin.resume();
  const decoder = new TextDecoder('utf-8');
  let value = '';
  let done = false;

  const cleanup = (): void => {
    if (done) return;
    done = true;
    stdin.off('data', onData);
    stdin.setRawMode(previousRaw);
    stdin.pause();
  };

  const onData = (chunk: Buffer): void => {
    const text = decoder.decode(chunk, { stream: true });
    for (const char of text) {
      if (char === '\u0003') {
        // Ctrl-C: leave the terminal in a usable state before exiting.
        cleanup();
        process.stdout.write('\n');
        process.exit(130);
      } else if (char === '\r' || char === '\n') {
        cleanup();
        process.stdout.write('\n');
        resolve(value);
        return;
      } else if (char === '\u007f' || char === '\b') {
        value = [...value].slice(0, -1).join('');
      } else if (char >= ' ') {
        value += char;
      }
    }
  };

  stdin.on('data', onData);
  return promise;
}

/**
 * Prompt for a SECRET: echo disabled on a TTY, one line from a pipe otherwise.
 *
 * Use only for values that must not be seen (private key, passphrase). For a confirmation word that the
 * user should be able to see while typing, use `promptVisible` — hiding a non-secret only makes typos
 * more likely and dilutes what "hidden" is for.
 */
export async function promptSecret(prompt: string): Promise<string> {
  if (process.stdin.isTTY === true) {
    return readHiddenFromTty(prompt);
  }
  process.stdout.write(prompt);
  return nextPipedLine();
}

/** Prompt for a NON-secret value: visible typing on a TTY, one line from a pipe otherwise. */
export async function promptVisible(prompt: string): Promise<string> {
  if (process.stdin.isTTY === true) {
    const { promise, resolve } = Promise.withResolvers<string>();
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    process.stdout.write(prompt);
    rl.once('line', (line) => {
      rl.close();
      resolve(line);
    });
    return promise;
  }
  process.stdout.write(prompt);
  return nextPipedLine();
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Print an error and exit non-zero. Errors must never carry key or passphrase material. */
export function fail(message: string): never {
  process.stderr.write(`\nERROR: ${message}\n`);
  process.exit(1);
}

/** Directory for the keystore; created with mode 0700 (file itself is 0600). */
export const SECRETS_DIR_MODE = 0o700;
export const SECRETS_FILE_MODE = 0o600;
export const MIN_PASSPHRASE_LENGTH = 12;
