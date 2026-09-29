import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import {
  DEFAULT_KEYSTORE_CHAIN_ID,
  KEYSTORE_VERSION,
  KeystoreError,
  SCRYPT_MAXMEM,
  buildAad,
  decryptPrivateKey,
  encryptPrivateKey,
  parseAad,
  parseEnvelope,
  readKeystoreFile,
  serializeEnvelope,
  writeKeystoreFile,
  zeroize,
} from '../../src/security/keystore.ts';
import type { KeystoreEnvelope } from '../../src/security/keystore.ts';

/** Deterministic, obviously-fake key material. Never a real wallet. */
const TEST_PRIVATE_KEY = `0x${'11'.repeat(32)}`;
const TEST_PRIVATE_KEY_2 = `0x${'22'.repeat(31)}ab`;
const TEST_PASSPHRASE = 'test-passphrase-not-a-real-secret';

/**
 * Production scrypt parameters (N=2^17) cost ~1.5s per derivation and 128 MiB per call, so most
 * cases use a still-legitimate-but-cheaper N while the production parameter path is verified once.
 * `maxmem` is always passed explicitly (research §5) — that assertion is what these tests protect.
 */
const FAST_KDF = { N: 2 ** 14, r: 8, p: 1 };

function base64ToBuffer(value: string): Buffer {
  return Buffer.from(value, 'base64');
}

/** Replace one byte of a base64 payload, preserving its length. */
function flipByte(value: string, index = 0): string {
  const buffer = base64ToBuffer(value);
  buffer[index] = (buffer[index]! ^ 0xff) & 0xff;
  return buffer.toString('base64');
}

describe('keystore envelope format', () => {
  it('is versioned and self-describing with an explicit maxmem', async () => {
    const envelope = await encryptPrivateKey(TEST_PRIVATE_KEY, TEST_PASSPHRASE, {
      kdfParams: FAST_KDF,
    });
    expect(envelope.v).toBe(KEYSTORE_VERSION);
    expect(envelope.kdf).toBe('scrypt');
    expect(envelope.kdfParams.maxmem).toBeGreaterThanOrEqual(
      128 * envelope.kdfParams.N * envelope.kdfParams.r,
    );
    // Production defaults must be the ones the research doc demands: explicit, not Node's 32 MiB.
    expect(SCRYPT_MAXMEM).toBeGreaterThan(128 * 2 ** 17 * 8);
    expect(base64ToBuffer(envelope.salt)).toHaveLength(16);
    expect(base64ToBuffer(envelope.iv)).toHaveLength(12);
    expect(base64ToBuffer(envelope.tag)).toHaveLength(16);
    expect(envelope.aad).toBe(
      buildAad(DEFAULT_KEYSTORE_CHAIN_ID, privateKeyToAccount(TEST_PRIVATE_KEY as `0x${string}`).address.toLowerCase() as `0x${string}`),
    );
  });

  it('never stores the key or passphrase in any field of the serialised envelope', async () => {
    const envelope = await encryptPrivateKey(TEST_PRIVATE_KEY, TEST_PASSPHRASE, {
      kdfParams: FAST_KDF,
    });
    const serialised = serializeEnvelope(envelope);
    expect(serialised).not.toContain(TEST_PRIVATE_KEY);
    expect(serialised).not.toContain(TEST_PRIVATE_KEY.slice(2));
    expect(serialised).not.toContain(TEST_PASSPHRASE);
    expect(serialised).not.toContain('11'.repeat(32));
  });
});

describe('encrypt/decrypt round trip', () => {
  it('recovers the private key and its address', async () => {
    const expected = privateKeyToAccount(TEST_PRIVATE_KEY as `0x${string}`).address.toLowerCase();
    const envelope = await encryptPrivateKey(TEST_PRIVATE_KEY, TEST_PASSPHRASE, {
      kdfParams: FAST_KDF,
    });
    const decrypted = await decryptPrivateKey(envelope, TEST_PASSPHRASE);
    expect(decrypted.privateKeyHex).toBe(TEST_PRIVATE_KEY);
    expect(decrypted.address).toBe(expected);
  });

  it('uses a fresh IV and salt per encryption, so identical input yields different ciphertext', async () => {
    const first = await encryptPrivateKey(TEST_PRIVATE_KEY, TEST_PASSPHRASE, {
      kdfParams: FAST_KDF,
    });
    const second = await encryptPrivateKey(TEST_PRIVATE_KEY, TEST_PASSPHRASE, {
      kdfParams: FAST_KDF,
    });
    expect(first.iv).not.toBe(second.iv);
    expect(first.salt).not.toBe(second.salt);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(first.tag).not.toBe(second.tag);
    // Both still decrypt to the same key.
    await expect(decryptPrivateKey(second, TEST_PASSPHRASE)).resolves.toMatchObject({
      privateKeyHex: TEST_PRIVATE_KEY,
    });
  });

  it('produces production parameters when no override is given', async () => {
    const envelope = await encryptPrivateKey(TEST_PRIVATE_KEY, TEST_PASSPHRASE);
    expect(envelope.kdfParams.N).toBe(2 ** 17);
    expect(envelope.kdfParams.r).toBe(8);
    expect(envelope.kdfParams.p).toBe(1);
    expect(envelope.kdfParams.keyLength).toBe(32);
  }, 60_000);
});

describe('hard failures', () => {
  it('rejects a wrong passphrase and leaks neither the key nor the passphrase in the error', async () => {
    const envelope = await encryptPrivateKey(TEST_PRIVATE_KEY, TEST_PASSPHRASE, {
      kdfParams: FAST_KDF,
    });
    const wrongPassphrase = 'definitely-not-the-passphrase';
    let caught: unknown;
    try {
      await decryptPrivateKey(envelope, wrongPassphrase);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(KeystoreError);
    const error = caught as KeystoreError;
    expect(error.code).toBe('DECRYPT_FAILED');

    const message = error.message;
    expect(message).not.toContain(TEST_PRIVATE_KEY);
    expect(message).not.toContain(TEST_PRIVATE_KEY.slice(2));
    expect(message).not.toContain('1111111111111111');
    expect(message).not.toContain(wrongPassphrase);
    expect(message).not.toContain(TEST_PASSPHRASE);
    // The stack must not carry secret material either.
    expect(error.stack ?? '').not.toContain(TEST_PRIVATE_KEY.slice(2));
    expect(error.stack ?? '').not.toContain(wrongPassphrase);
  });

  it('rejects an empty passphrase', async () => {
    await expect(
      encryptPrivateKey(TEST_PRIVATE_KEY, '', { kdfParams: FAST_KDF }),
    ).rejects.toMatchObject({ code: 'INVALID_PASSPHRASE' });
  });

  it('rejects tampered ciphertext', async () => {
    const envelope = await encryptPrivateKey(TEST_PRIVATE_KEY, TEST_PASSPHRASE, {
      kdfParams: FAST_KDF,
    });
    const tampered: KeystoreEnvelope = { ...envelope, ciphertext: flipByte(envelope.ciphertext) };
    await expect(decryptPrivateKey(tampered, TEST_PASSPHRASE)).rejects.toMatchObject({
      code: 'DECRYPT_FAILED',
    });
  });

  it('rejects a tampered authentication tag', async () => {
    const envelope = await encryptPrivateKey(TEST_PRIVATE_KEY, TEST_PASSPHRASE, {
      kdfParams: FAST_KDF,
    });
    const tampered: KeystoreEnvelope = { ...envelope, tag: flipByte(envelope.tag) };
    await expect(decryptPrivateKey(tampered, TEST_PASSPHRASE)).rejects.toMatchObject({
      code: 'DECRYPT_FAILED',
    });
  });

  it('rejects tampered AAD metadata (address substitution)', async () => {
    const envelope = await encryptPrivateKey(TEST_PRIVATE_KEY, TEST_PASSPHRASE, {
      kdfParams: FAST_KDF,
    });
    const other = privateKeyToAccount(TEST_PRIVATE_KEY_2 as `0x${string}`).address;
    const tampered: KeystoreEnvelope = { ...envelope, aad: buildAad(56, other) };
    await expect(decryptPrivateKey(tampered, TEST_PASSPHRASE)).rejects.toMatchObject({
      code: 'DECRYPT_FAILED',
    });
  });

  it('rejects tampered AAD chain id', async () => {
    const envelope = await encryptPrivateKey(TEST_PRIVATE_KEY, TEST_PASSPHRASE, {
      kdfParams: FAST_KDF,
    });
    const parsed = parseAad(envelope.aad);
    expect(parsed).not.toBeNull();
    const tampered: KeystoreEnvelope = {
      ...envelope,
      aad: buildAad(97, parsed!.address),
    };
    await expect(decryptPrivateKey(tampered, TEST_PASSPHRASE)).rejects.toMatchObject({
      code: 'DECRYPT_FAILED',
    });
  });

  it('rejects a chain id that disagrees with the envelope metadata', async () => {
    const envelope = await encryptPrivateKey(TEST_PRIVATE_KEY, TEST_PASSPHRASE, {
      kdfParams: FAST_KDF,
      chainId: 56,
    });
    await expect(
      decryptPrivateKey(envelope, TEST_PASSPHRASE, { chainId: 97 }),
    ).rejects.toMatchObject({ code: 'INVALID_ENVELOPE' });
    await expect(
      decryptPrivateKey(envelope, TEST_PASSPHRASE, { chainId: 56 }),
    ).resolves.toMatchObject({ privateKeyHex: TEST_PRIVATE_KEY });
  });

  it('does not fall back to plaintext when the envelope is malformed', async () => {
    for (const malformed of [null, {}, [], 'not-an-envelope', 42]) {
      await expect(decryptPrivateKey(malformed, TEST_PASSPHRASE)).rejects.toBeInstanceOf(
        KeystoreError,
      );
    }
  });

  it('rejects an unsupported version and an unsupported kdf', async () => {
    const envelope = await encryptPrivateKey(TEST_PRIVATE_KEY, TEST_PASSPHRASE, {
      kdfParams: FAST_KDF,
    });
    expect(() => parseEnvelope({ ...envelope, v: 99 })).toThrow(/unsupported keystore version/u);
    expect(() => parseEnvelope({ ...envelope, kdf: 'pbkdf2' })).toThrow(/unsupported keystore kdf/u);
  });

  it('refuses weak or under-specified scrypt parameters', async () => {
    // The documented trap (research §5): Node's default maxmem is 32 MiB, but N=2^17, r=8 needs
    // 128 MiB. Passing the framework default must be rejected, not silently accepted.
    await expect(
      encryptPrivateKey(TEST_PRIVATE_KEY, TEST_PASSPHRASE, {
        kdfParams: { N: 2 ** 17, r: 8, p: 1, maxmem: 32 * 1024 * 1024 },
      }),
    ).rejects.toMatchObject({ code: 'WEAK_KDF_PARAMS' });
    // Even an explicit maxmem is rejected when it cannot cover 128*N*r.
    await expect(
      encryptPrivateKey(TEST_PRIVATE_KEY, TEST_PASSPHRASE, {
        kdfParams: { N: 2 ** 14, r: 8, p: 1, maxmem: 8 * 1024 * 1024 },
      }),
    ).rejects.toMatchObject({ code: 'WEAK_KDF_PARAMS' });
    await expect(
      encryptPrivateKey(TEST_PRIVATE_KEY, TEST_PASSPHRASE, { kdfParams: { N: 1024 } }),
    ).rejects.toMatchObject({ code: 'WEAK_KDF_PARAMS' });
    await expect(
      encryptPrivateKey(TEST_PRIVATE_KEY, TEST_PASSPHRASE, { kdfParams: { keyLength: 16 } }),
    ).rejects.toMatchObject({ code: 'WEAK_KDF_PARAMS' });
  });

  it('rejects invalid private key input without echoing it', async () => {
    for (const bad of ['', '0x', 'not-a-key', `0x${'11'.repeat(31)}`, `0x0${'0'.repeat(63)}`]) {
      let caught: unknown;
      try {
        await encryptPrivateKey(bad, TEST_PASSPHRASE, { kdfParams: FAST_KDF });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(KeystoreError);
      // No recognisable fragment of the rejected input may be echoed back.
      if (bad.length >= 8) {
        expect((caught as KeystoreError).message).not.toContain(bad);
      }
    }
  });
});

describe('zeroize', () => {
  it('overwrites the buffer in place and tolerates nullish input', () => {
    const buffer = Buffer.from('sensitive-derived-key-material');
    zeroize(buffer);
    expect(buffer.every((byte) => byte === 0)).toBe(true);
    expect(() => zeroize(null)).not.toThrow();
    expect(() => zeroize(undefined)).not.toThrow();
  });
});

describe('keystore files', () => {
  it('round-trips through disk and writes mode 0600', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lptrader-keystore-'));
    const filePath = path.join(dir, 'wallet.enc');
    const envelope = await encryptPrivateKey(TEST_PRIVATE_KEY, TEST_PASSPHRASE, {
      kdfParams: FAST_KDF,
    });
    await writeKeystoreFile(filePath, envelope);

    const mode = (await stat(filePath)).mode & 0o777;
    expect(mode).toBe(0o600);

    const raw = await readFile(filePath, 'utf8');
    expect(raw).not.toContain(TEST_PRIVATE_KEY.slice(2));
    expect(raw).not.toContain(TEST_PASSPHRASE);

    const reloaded = await readKeystoreFile(filePath);
    await expect(decryptPrivateKey(reloaded, TEST_PASSPHRASE)).resolves.toMatchObject({
      privateKeyHex: TEST_PRIVATE_KEY,
    });
  });

  it('rejects a non-JSON and a structurally invalid file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lptrader-keystore-'));
    const notJson = path.join(dir, 'bad.enc');
    await writeFile(notJson, 'this is not json');
    await expect(readKeystoreFile(notJson)).rejects.toMatchObject({ code: 'INVALID_ENVELOPE' });

    const wrongShape = path.join(dir, 'shape.enc');
    await writeFile(wrongShape, JSON.stringify({ v: 1, kdf: 'scrypt' }));
    await expect(readKeystoreFile(wrongShape)).rejects.toMatchObject({ code: 'INVALID_ENVELOPE' });

    await expect(readKeystoreFile(path.join(dir, 'missing.enc'))).rejects.toMatchObject({
      code: 'INVALID_ENVELOPE',
    });
  });
});
