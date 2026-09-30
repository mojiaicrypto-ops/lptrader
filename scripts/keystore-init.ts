/**
 * CLI: create `secrets/wallet.enc` (AES-256-GCM + scrypt) from an interactively typed private key.
 *
 * Usage:
 *   npm run keystore:init                 # interactive
 *   node scripts/keystore-init.ts --force  # overwrite an existing keystore
 *
 * Safety properties of this script:
 * - The private key and passphrase are read with echo DISABLED on a TTY, are never written to disk,
 *   and are never printed — not on success, not in an error message.
 * - The output file is created with mode 0600 inside a directory created with mode 0700.
 * - The written keystore is decrypted once before the script reports success, so a corrupted write
 *   fails immediately instead of being discovered on the next live start.
 * - An existing keystore is never silently replaced (`--force` required).
 *
 * Non-interactive use (CI/smoke tests) works by piping stdin; echo suppression is only needed on a
 * TTY because a pipe does not echo.
 */
import { mkdir, chmod, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  MIN_PASSPHRASE_LENGTH,
  SECRETS_DIR_MODE,
  SECRETS_FILE_MODE,
  fail,
  fileExists,
  promptSecret,
} from './lib/prompt.ts';
import {
  DEFAULT_KEYSTORE_CHAIN_ID,
  decryptPrivateKey,
  encryptPrivateKey,
  readKeystoreFile,
  writeKeystoreFile,
} from '../src/security/keystore.ts';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from '../src/types/primitives.ts';

const DEFAULT_KEYSTORE_PATH = path.join('secrets', 'wallet.enc');

async function main(): Promise<void> {
  const force = process.argv.includes('--force');
  const keystorePath = process.env['KEYSTORE_PATH'] ?? DEFAULT_KEYSTORE_PATH;
  const chainId = Number(process.env['KEYSTORE_CHAIN_ID'] ?? DEFAULT_KEYSTORE_CHAIN_ID);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    fail(`KEYSTORE_CHAIN_ID must be a positive integer, received "${process.env['KEYSTORE_CHAIN_ID']}"`);
  }

  const absolutePath = path.resolve(process.cwd(), keystorePath);
  if ((await fileExists(absolutePath)) && !force) {
    fail(
      `${absolutePath} already exists. Refusing to overwrite a keystore (use --force if you are ` +
        `certain, and make sure the current file is backed up).`,
    );
  }

  process.stdout.write(
    [
      '',
      'lptrader keystore initialisation',
      '--------------------------------',
      `  output     : ${absolutePath}`,
      `  format     : AES-256-GCM, scrypt (N=2^17, r=8, p=1, maxmem explicit)`,
      `  chainId    : ${chainId} (bound into the authenticated data)`,
      '',
      'The private key and passphrase are read with echo disabled. Neither is ever written to disk.',
      'Use a DEDICATED strategy wallet holding only funds the strategy may lose (baseline §92).',
      '',
      '',
    ].join('\n'),
  );

  const privateKeyInput = (await promptSecret('Private key (0x + 64 hex, hidden): ')).trim();
  if (!/^0x[0-9a-fA-F]{64}$/u.test(privateKeyInput)) {
    fail('private key must be 0x followed by exactly 64 hex characters');
  }
  const privateKeyHex = privateKeyInput.toLowerCase() as Hex;

  let address: string;
  try {
    address = privateKeyToAccount(privateKeyHex).address;
  } catch {
    fail('the supplied private key is not a valid secp256k1 key');
  }

  const passphrase = await promptSecret('Passphrase (hidden): ');
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    fail(`passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
  }
  const confirmation = await promptSecret('Repeat passphrase  : ');
  if (confirmation !== passphrase) {
    fail('passphrases did not match');
  }

  process.stdout.write('\nDeriving key (scrypt, ~1-2s) and encrypting...\n');
  const envelope = await encryptPrivateKey(privateKeyHex, passphrase, { chainId });

  await mkdir(path.dirname(absolutePath), { recursive: true, mode: SECRETS_DIR_MODE });
  await writeKeystoreFile(absolutePath, envelope);
  await chmod(absolutePath, SECRETS_FILE_MODE);

  // Self-check: read the file back and decrypt it. A corrupt write or a mode problem surfaces now.
  process.stdout.write('Verifying the written keystore (re-decrypting)...\n');
  const reloaded = await readKeystoreFile(absolutePath);
  const verified = await decryptPrivateKey(reloaded, passphrase, { chainId });
  if (verified.address.toLowerCase() !== address.toLowerCase()) {
    fail('verification failed: the decrypted key does not match the key that was encrypted');
  }

  const mode = (await stat(absolutePath)).mode & 0o777;
  if (mode !== SECRETS_FILE_MODE) {
    fail(`verification failed: expected file mode 0600, found 0${mode.toString(8)}`);
  }

  process.stdout.write(
    [
      '',
      'Keystore created and verified.',
      `  file    : ${absolutePath} (mode 0${mode.toString(8)})`,
      `  address : ${address}`,
      '',
      'Reminders:',
      '  - The passphrase is NOT stored anywhere. If it is lost the key is unrecoverable.',
      '  - Start the bot with the same KEYSTORE_CHAIN_ID you used here.',
      '  - Never send funds to this wallet beyond what the strategy may lose.',
      '',
      '',
    ].join('\n'),
  );
}

try {
  await main();
} catch (error) {
  // Only the error message is printed; keystore errors never carry key/passphrase material.
  fail(error instanceof Error ? error.message : 'unexpected failure');
}
