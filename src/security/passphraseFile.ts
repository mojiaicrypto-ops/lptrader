/**
 * Reading the keystore passphrase from a file, for unattended operation.
 *
 * ## Why this exists
 *
 * The signing key is needed to trade, and the passphrase was only obtainable from a terminal. That made
 * every non-interactive start impossible: `systemd`, `nohup` and any process manager run without a TTY, so
 * the bot would block forever on a prompt nobody could see, or refuse outright. The alternative in practice
 * was `tmux` — which loses its scrollback, dies with the machine, and restarts nothing.
 *
 * ## The permission rule is not decoration
 *
 * A passphrase on disk is a private key on disk: anyone who can read the file can decrypt the wallet. So the
 * file MUST NOT be group- or world-readable, and a file with wider permissions is REFUSED rather than
 * accepted with a warning. Warning-and-continuing would mean the system trades happily while its key is
 * exposed, and the exposure is discovered only after the funds are gone.
 *
 * The check is on the file's mode at read time, not on what it was created as — a file is exactly as
 * readable as it is now.
 *
 * ## What this does NOT do
 *
 * It does not encrypt anything, and it is not a substitute for `systemd-creds` on a host where other users
 * have root. It removes a terminal requirement; it does not change the threat model of a passphrase at rest.
 */
import { readFile, stat } from 'node:fs/promises';
import { KeystoreError } from './keystore.ts';

/** Modes that are acceptable: owner read only. Anything with group or other bits set is refused. */
const FORBIDDEN_BITS = 0o077;

export interface PassphraseFileOptions {
  /** Injected for tests: the mode to assume, instead of the real one. */
  readonly modeOverride?: number;
}

/**
 * Read the passphrase from `filePath`, or `null` when the variable is unset.
 *
 * Throws rather than falling back to the terminal prompt: a process that was configured for unattended
 * operation and silently starts asking for input is a process that hangs in a supervisor's log with no
 * explanation.
 */
export async function readPassphraseFile(
  filePath: string | undefined,
  options: PassphraseFileOptions = {},
): Promise<string | null> {
  if (filePath === undefined || filePath.length === 0) return null;

  let mode: number;
  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      throw new KeystoreError(
        'PASSPHRASE_FILE_UNREADABLE',
        `${filePath} is not a regular file; refusing to read a passphrase from it`,
      );
    }
    mode = options.modeOverride ?? info.mode;
  } catch (error) {
    if (error instanceof KeystoreError) throw error;
    throw new KeystoreError(
      'PASSPHRASE_FILE_UNREADABLE',
      `cannot read the passphrase file ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if ((mode & FORBIDDEN_BITS) !== 0) {
    // The keystore's own code for a permission problem: the same rule and the same remedy, so an operator
    // who has seen it once recognises it.
    throw new KeystoreError(
      'WEAK_FILE_PERMISSIONS',
      `the passphrase file ${filePath} has mode ${(mode & 0o777).toString(8)}; it must not be readable by ` +
        'group or others. Anyone who can read it can decrypt the wallet. Run: ' +
        `chmod 600 ${filePath}`,
    );
  }

  const contents = await readFile(filePath, 'utf8');
  // Only the FIRST line: a trailing newline is normal in a file, and an editor that appends one must not
  // silently change the passphrase into an invalid one.
  const passphrase = contents.split('\n')[0] ?? '';
  if (passphrase.length === 0) {
    throw new KeystoreError(
      'PASSPHRASE_FILE_EMPTY',
      `the passphrase file ${filePath} is empty; refusing to start with an empty passphrase`,
    );
  }
  return passphrase;
}
