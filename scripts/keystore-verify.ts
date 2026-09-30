/**
 * CLI: verify a keystore and (optionally) export the private key for backup.
 *
 * ## Why this exists
 * `keystore-init.ts` can create a key but there was no way to read one back, which makes three things
 * impossible: verifying that a **backup** is actually decryptable, recovering onto a new machine, and
 * exporting the key into another wallet. Backups that were never restored are not backups, so the
 * verification path has to exist.
 *
 * ## The two modes, and why verification is the default
 * ```text
 * node scripts/keystore-verify.ts              # verify only (default, SAFE)
 * node scripts/keystore-verify.ts --export     # print the private key (SENSITIVE)
 * ```
 * Default is verify-only: it proves the file decrypts and reports the address **without** putting key
 * material on the screen, in scroll-back, or in a terminal multiplexer's buffer. Export requires an
 * explicit flag plus typing a confirmation word, because the output of `--export` is enough to take the
 * wallet and is by far the most dangerous thing this repository can print.
 *
 * ## The rules this file enforces
 * - **Never write the key anywhere.** No file, no log, no temp file. Only stdout, and only in `--export`.
 * - **Never echo the passphrase.** Read with echo disabled (TTY) or piped (non-TTY, for automation).
 * - **Report the address, not the key**, in verify mode — the address is what you compare against your
 *   records to prove you restored the right wallet.
 * - **Fail hard and specifically**: a wrong passphrase, a tampered envelope, or a chainId mismatch must be
 *   distinguishable, because in a recovery situation the difference between "wrong passphrase" and
 *   "corrupted backup" changes what you do next.
 *
 * Run from the repository root. Use the same `KEYSTORE_PATH` / `KEYSTORE_CHAIN_ID` as the bot.
 */
import { createInterface } from 'node:readline';
import path from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import {
  DEFAULT_KEYSTORE_CHAIN_ID,
  KeystoreError,
  decryptPrivateKey,
  readKeystoreFile,
} from '../src/security/keystore.ts';

const DEFAULT_KEYSTORE_PATH = path.join('secrets', 'wallet.enc');

/** Typed verbatim to unlock `--export`. Not a passphrase check — a "are you somewhere private" check. */
const EXPORT_CONFIRMATION = 'EXPORT';

const pipedLines: string[] = [];
let pipedLinesLoaded = false;

/**
 * Piped input is drained ONCE into a queue: creating a fresh readline per prompt loses buffered lines
 * when more than one prompt is answered from a pipe.
 */
async function ensurePipedLines(): Promise<void> {
  if (pipedLinesLoaded) return;
  pipedLinesLoaded = true;
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) pipedLines.push(line);
  rl.close();
}

async function promptHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    await ensurePipedLines();
    const line = pipedLines.shift();
    if (line === undefined) throw new Error('no more piped input for the passphrase prompt');
    return line;
  }
  process.stdout.write(prompt);
  return new Promise<string>((resolve, reject) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    let value = '';
    const onData = (chunk: Buffer | string): void => {
      const text = chunk.toString('utf8');
      for (const char of text) {
        if (char === '\u0003') {
          cleanup();
          reject(new Error('interrupted'));
          return;
        }
        if (char === '\r' || char === '\n') {
          cleanup();
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };
    const cleanup = (): void => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(wasRaw ?? false);
      stdin.pause();
    };
    stdin.on('data', onData);
  });
}

async function promptVisible(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    await ensurePipedLines();
    const line = pipedLines.shift();
    if (line === undefined) throw new Error('no more piped input for the confirmation prompt');
    return line;
  }
  process.stdout.write(prompt);
  return new Promise<string>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    rl.once('line', (line) => {
      rl.close();
      resolve(line);
    });
  });
}

function fail(message: string): never {
  process.stderr.write(`\nFAILED: ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const exportMode = process.argv.includes('--export');
  const keystorePath = process.env['KEYSTORE_PATH'] ?? DEFAULT_KEYSTORE_PATH;
  const chainId = Number(process.env['KEYSTORE_CHAIN_ID'] ?? DEFAULT_KEYSTORE_CHAIN_ID);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    fail(
      `KEYSTORE_CHAIN_ID must be a positive integer, received "${process.env['KEYSTORE_CHAIN_ID']}"`,
    );
  }
  const absolutePath = path.resolve(process.cwd(), keystorePath);

  process.stdout.write(
    [
      '',
      exportMode ? 'lptrader keystore EXPORT (sensitive)' : 'lptrader keystore verification',
      '-------------------------------------------------',
      `  file     : ${absolutePath}`,
      `  chainId  : ${chainId}`,
      `  mode     : ${exportMode ? 'EXPORT — the private key will be printed' : 'verify only (nothing secret is printed)'}`,
      '',
    ].join('\n'),
  );

  let envelope: unknown;
  try {
    envelope = await readKeystoreFile(absolutePath);
  } catch (error) {
    // `readKeystoreFile` reports a missing file as INVALID_ENVELOPE carrying the underlying read error, so
    // the message is inspected rather than the code: the actionable advice differs (copy the backup into
    // place vs. the file exists but is malformed), and in a restore you need to know which one it is.
    const message = error instanceof Error ? error.message : String(error);
    if (/ENOENT|no such file/i.test(message)) {
      fail(
        `no keystore at ${absolutePath}. If you are restoring, put the backup at this path first ` +
          '(see docs/OPS.md 「私钥备份与恢复」). If you are creating one, run `npm run keystore:init`.',
      );
    }
    fail(`could not read the keystore: ${message}`);
  }

  if (exportMode) {
    process.stdout.write(
      [
        'You are about to print a private key. Anyone who sees it — over your shoulder, in scroll-back,',
        'in a terminal recording, in a shared session — can take the wallet.',
        '',
        'Make sure: nobody is watching; this is not being recorded or streamed; you will clear the',
        'scroll-back afterwards; and you have a reason (migrating to another wallet, or saving an',
        'offline backup) rather than curiosity.',
        '',
      ].join('\n'),
    );
    const answer = (await promptVisible(`Type ${EXPORT_CONFIRMATION} to continue: `)).trim();
    if (answer !== EXPORT_CONFIRMATION) {
      fail('export not confirmed — nothing was printed');
    }
  }

  const passphrase = await promptHidden('Passphrase (hidden): ');
  if (passphrase.length === 0) {
    fail('no passphrase supplied');
  }

  process.stdout.write('\nDeriving key (scrypt, ~1-2s)...\n');

  let decrypted: { privateKeyHex: string; address: string };
  try {
    decrypted = await decryptPrivateKey(envelope, passphrase, { chainId });
  } catch (error) {
    // The three failure modes lead to different next actions, so they are named distinctly rather than
    // collapsed into "decryption failed".
    if (error instanceof KeystoreError) {
      if (error.message.includes('chain')) {
        fail(
          `this keystore was created for a different chain id than KEYSTORE_CHAIN_ID=${chainId}. ` +
            'Set KEYSTORE_CHAIN_ID to the value used at creation (56 for BNB Chain).',
        );
      }
      if (error.code === 'DECRYPT_FAILED') {
        fail(
          'decryption failed. Either the passphrase is wrong, or the file is damaged/tampered. ' +
            'Try another passphrase; if none works, restore from a backup rather than editing this file.',
        );
      }
      fail(`${error.code}: ${error.message}`);
    }
    fail(`unexpected error: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Derive the address independently of what the envelope claims: a mismatch would mean the stored
  // metadata does not describe the key, which is a tampering signal worth refusing over.
  const derived = privateKeyToAccount(decrypted.privateKeyHex as `0x${string}`).address;

  if (derived.toLowerCase() !== decrypted.address.toLowerCase()) {
    fail(
      'the decrypted key does not match the address stored in the envelope. The file may have been ' +
        'edited by hand. Do not use this keystore; restore from a backup.',
    );
  }

  process.stdout.write(
    [
      '',
      'Verification PASSED. The passphrase decrypts this keystore.',
      `  address : ${derived}`,
      '',
    ].join('\n'),
  );

  if (!exportMode) {
    process.stdout.write(
      [
        'To prove this is the SAME wallet as your records, compare the address above with the one',
        'printed by `npm run keystore:init` when you created it (or with the wallet in your wallet app).',
        '',
        'To print the private key for a backup or migration, re-run with --export.',
        '',
      ].join('\n'),
    );
    return;
  }

  process.stdout.write(
    [
      'Private key (this is the ONLY thing you need to restore the wallet):',
      '',
      `  ${decrypted.privateKeyHex}`,
      '',
      `  address ${derived}`,
      '',
      'Distribute it now: paper or a password manager, ideally in two separate physical locations.',
      'Then CLEAR your terminal scroll-back.',
      '',
      'Do NOT paste it into a chat, an issue, a screenshot, or a cloud note. Do NOT leave it in a shell',
      'history file — the command above contains no key, only the output does, so clearing the screen is',
      'sufficient as long as you are not recording.',
      '',
    ].join('\n'),
  );
}

try {
  await main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
