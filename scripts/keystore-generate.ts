/**
 * CLI: create a NEW wallet and encrypt it — the private key is generated locally, never typed, never printed.
 *
 * ```text
 * npm run keystore:generate              # new wallet, you supply only the passphrase
 * npm run keystore:generate -- --force   # overwrite an existing keystore
 * ```
 *
 * ## Why this exists next to `keystore:init`
 * `keystore:init` imports a key you already have (a wallet you exported from elsewhere). This script is
 * for the case where you simply want a fresh strategy wallet: you should not have to go to an external
 * site, generate a key, and paste it into a terminal — every extra place a key is rendered is an extra
 * place it can be captured. Here the key is created and sealed without ever being displayed.
 *
 * ## Where the key comes from, and what that does and does not buy
 * `viem.generatePrivateKey()` is a thin wrapper over `node:crypto`'s CSPRNG — the OS entropy source. There
 * is no network call and no third-party service, so the key never leaves this machine.
 *
 * **What this does NOT give you:** protection against a compromised machine, a malicious `node_modules`,
 * or someone reading the process memory. This is a **hot wallet** in every configuration (§92): keep only
 * funds the strategy may lose. Generating locally removes the *transmission* risk, not the *host* risk.
 *
 * ## The private key is never printed — and that has a consequence you must handle
 * After this script succeeds, the only copy of the key is inside `secrets/wallet.enc`, protected by the
 * passphrase. **Forget the passphrase and the wallet is gone.** So the script ends by telling you to run
 * `keystore:verify -- --export` and write the key down. Until you have done that and verified it, you do
 * not have a backup — you have a single point of failure.
 *
 * Sharing the prompt handling with the other keystore CLIs is deliberate: echo suppression and the
 * pipe-draining rule are either applied everywhere or they are wrong somewhere.
 */
import { mkdir, chmod, stat } from 'node:fs/promises';
import path from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  DEFAULT_KEYSTORE_CHAIN_ID,
  decryptPrivateKey,
  encryptPrivateKey,
  readKeystoreFile,
  writeKeystoreFile,
} from '../src/security/keystore.ts';
import {
  MIN_PASSPHRASE_LENGTH,
  SECRETS_DIR_MODE,
  SECRETS_FILE_MODE,
  fail,
  fileExists,
  promptSecret,
} from './lib/prompt.ts';

const DEFAULT_KEYSTORE_PATH = path.join('secrets', 'wallet.enc');

/** Printed before the passphrase prompt so the operator sees the destination before committing to it. */
function renderBanner(keystorePath: string, chainId: number): string {
  return [
    '',
    'lptrader — generate a NEW strategy wallet',
    '-----------------------------------------',
    `  output     : ${keystorePath}`,
    `  chainId    : ${chainId} (bound into the authenticated data)`,
    '  format     : AES-256-GCM, scrypt (N=2^17, r=8, p=1)',
    '  entropy    : node:crypto CSPRNG, generated locally (no network)',
    '',
    'The private key is generated on this machine and is NEVER printed or written in the clear.',
    'You only need to supply a passphrase for the encrypted keystore.',
    '',
    'This is a HOT WALLET: keep only funds the strategy may lose (baseline §92).',
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const force = process.argv.includes('--force');
  const keystorePath = process.env['KEYSTORE_PATH'] ?? DEFAULT_KEYSTORE_PATH;
  const chainId = Number(process.env['KEYSTORE_CHAIN_ID'] ?? DEFAULT_KEYSTORE_CHAIN_ID);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    fail(
      `KEYSTORE_CHAIN_ID must be a positive integer, received "${process.env['KEYSTORE_CHAIN_ID']}"`,
    );
  }

  const absolutePath = path.resolve(process.cwd(), keystorePath);
  if ((await fileExists(absolutePath)) && !force) {
    fail(
      `${absolutePath} already exists. Refusing to overwrite a keystore — doing so would destroy the only ` +
        'copy of the current key unless you exported it first. Back it up (`npm run keystore:verify -- ' +
        '--export`), then re-run with --force if you are certain.',
    );
  }

  process.stdout.write(renderBanner(absolutePath, chainId));

  // Generate FIRST so the address can be shown before the passphrase is chosen. Showing it afterwards
  // would force the operator to re-run the whole flow just to learn where their funds should go.
  const privateKeyHex = generatePrivateKey();
  const address = privateKeyToAccount(privateKeyHex).address;

  const passphrase = await promptSecret('Passphrase for the encrypted keystore (hidden): ');
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    // The key has already been generated; discarding it is correct and cheap (another can be made),
    // whereas a weak passphrase would sit in front of real funds indefinitely.
    fail(
      `passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters. This wallet's only protection ` +
        'at rest is this passphrase — the generated key has been discarded, nothing was written.',
    );
  }
  const confirmation = await promptSecret('Repeat passphrase                    : ');
  if (confirmation !== passphrase) {
    fail('passphrases did not match — nothing was written; the generated key has been discarded.');
  }

  process.stdout.write('\nDeriving key (scrypt, ~1-2s) and encrypting...\n');
  const envelope = await encryptPrivateKey(privateKeyHex, passphrase, { chainId });

  await mkdir(path.dirname(absolutePath), { recursive: true, mode: SECRETS_DIR_MODE });
  await writeKeystoreFile(absolutePath, envelope);
  await chmod(absolutePath, SECRETS_FILE_MODE);

  // Self-check: read the file back and decrypt it with the same passphrase. A bad write, a mode problem or
  // a wrong address derivation fails HERE, while the operator is still watching, rather than on the next
  // live start when funds may already be en route.
  process.stdout.write('Verifying the written keystore (re-decrypting)...\n');
  const reloaded = await readKeystoreFile(absolutePath);
  const verified = await decryptPrivateKey(reloaded, passphrase, { chainId });
  if (verified.address.toLowerCase() !== address.toLowerCase()) {
    fail(
      'verification failed: the decrypted key does not match the generated key. Do NOT use this file; ' +
        're-run the generator.',
    );
  }
  if (verified.privateKeyHex.toLowerCase() !== privateKeyHex.toLowerCase()) {
    fail(
      'verification failed: the decrypted key differs from the generated key. Do NOT send funds to this ' +
        'wallet; re-run the generator.',
    );
  }

  const mode = (await stat(absolutePath)).mode & 0o777;
  if (mode !== SECRETS_FILE_MODE) {
    fail(`verification failed: expected file mode 0600, found 0${mode.toString(8)}`);
  }

  process.stdout.write(
    [
      '',
      'Wallet generated, encrypted and verified.',
      '',
      `  address : ${address}`,
      `  file    : ${absolutePath} (mode 0${mode.toString(8)})`,
      '',
      '── Do these next, in this order ──────────────────────────────────────────',
      '',
      '  1. Uncomment KEYSTORE_PATH in .env so the bot can find the keystore:',
      '         KEYSTORE_PATH=secrets/wallet.enc',
      '',
      '  2. FUND THIS ADDRESS. Send it USDT or USDC (for the position) plus a small',
      '     amount of BNB (for gas — a few cents is plenty):',
      `         ${address}`,
      '',
      '  3. BACK THE KEY UP. Right now the ONLY copy of the private key is inside',
      '     that encrypted file. If you forget the passphrase, the wallet is',
      '     unrecoverable and any funds in it are lost:',
      '         npm run keystore:verify -- --export',
      '     Write the key down (paper, two locations) or store it in a password',
      '     manager, then CLEAR your screen.',
      '',
      '  4. PROVE the backup works (the address must match the one above):',
      '         npm run keystore:verify',
      '',
      '──────────────────────────────────────────────────────────────────────────',
      '',
      'Send only what this strategy may lose. It is a hot wallet: its key is',
      'decrypted into process memory on every run.',
      '',
    ].join('\n'),
  );
}

try {
  await main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
