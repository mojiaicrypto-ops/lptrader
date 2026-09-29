import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt as scryptCallback,
} from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from '../types/primitives.ts';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Versioned, self-describing keystore envelope (AGENTS.md 密钥管理: private keys are AES-256-GCM
 * encrypted at rest with a passphrase-derived key).
 *
 * Invariants that make this file safe to depend on:
 * - The signing key NEVER appears in source, logs, git or exception messages; only `ciphertext` is
 *   persisted, and the passphrase is never stored anywhere.
 * - Every failure is a hard failure. There is no plaintext fallback, no "try the legacy format",
 *   no "return the input on error" path — a failed decrypt throws and the caller must stop (§96).
 * - All metadata used for authentication (`aad`) is bound into the GCM tag, so tampering with the
 *   address/chain/version is detected exactly like tampering with the ciphertext.
 */
export const KEYSTORE_VERSION = 1 as const;
export const KEYSTORE_KDF = 'scrypt' as const;

/**
 * scrypt parameters. `N = 2^17, r = 8, p = 1` needs 128 * N * r = 128 MiB.
 *
 * `maxmem` MUST be passed explicitly: Node's default is 32 MiB, so the default parameters fail with
 * "Invalid scrypt params" unless the limit is raised (research §5). `maxmem` is a local resource
 * cap only — it is not part of the derived key — so the stored value never affects decryption.
 */
export const SCRYPT_N = 2 ** 17;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
export const SCRYPT_KEY_LENGTH = 32;
export const SCRYPT_MAXMEM = 128 * SCRYPT_N * SCRYPT_R + 8 * 1024 * 1024; // ~136 MiB

/** Bounds accepted when reading an envelope, so a hostile file cannot cause a huge allocation. */
const MIN_N = 2 ** 14;
const MAX_N = 2 ** 21;
const MAX_R = 32;
const MAX_P = 16;
const MAX_MEM_CEILING = 1024 * 1024 * 1024; // 1 GiB

export const SALT_BYTES = 16;
export const IV_BYTES = 12; // GCM standard nonce length
export const TAG_BYTES = 16;

/** BNB Chain. Overridable at the call site; bound into the AAD so it cannot be swapped silently. */
export const DEFAULT_KEYSTORE_CHAIN_ID = 56;

export interface ScryptParams {
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly maxmem: number;
  readonly keyLength: number;
}

/** Mutable working copy used while resolving overrides. */
interface MutableScryptParams {
  N: number;
  r: number;
  p: number;
  maxmem: number;
  keyLength: number;
}

export interface KeystoreEnvelope {
  readonly v: typeof KEYSTORE_VERSION;
  readonly kdf: typeof KEYSTORE_KDF;
  readonly kdfParams: ScryptParams;
  /** base64, `SALT_BYTES` bytes. */
  readonly salt: string;
  /** base64, `IV_BYTES` bytes; a fresh random IV per encryption. */
  readonly iv: string;
  /** base64, AES-256-GCM ciphertext of the private key. */
  readonly ciphertext: string;
  /** base64, `TAG_BYTES` byte GCM authentication tag. */
  readonly tag: string;
  /**
   * Additional authenticated data: a canonical, non-secret string binding the derivation to a
   * specific address/chain/format version. Because it is authenticated, a mismatch is a hard error.
   * Shape: `lptrader-keystore:v<version>:chainId=<id>:address=<lowercase address>`.
   */
  readonly aad: string;
}

export interface DecryptedPrivateKey {
  /** 0x-prefixed 32-byte private key, in memory only. Callers must not persist or log it. */
  readonly privateKeyHex: Hex;
  /** Lowercased address derived from the key (viem `privateKeyToAccount`). */
  readonly address: Address;
}

/** Thrown for every keystore failure. Messages NEVER contain key or passphrase material. */
export class KeystoreError extends Error {
  readonly code: KeystoreErrorCode;

  constructor(code: KeystoreErrorCode, message: string) {
    super(message);
    this.name = 'KeystoreError';
    this.code = code;
  }
}

export type KeystoreErrorCode =
  | 'INVALID_PASSPHRASE'
  | 'INVALID_PRIVATE_KEY'
  | 'INVALID_ENVELOPE'
  | 'UNSUPPORTED_VERSION'
  | 'UNSUPPORTED_KDF'
  | 'WEAK_KDF_PARAMS'
  | 'DECRYPT_FAILED'
  | 'ADDRESS_MISMATCH'
  | 'WEAK_FILE_PERMISSIONS';

/** Canonical AAD string for an address/chain pair. Deterministic and safe to store in cleartext. */
export function buildAad(chainId: number, address: Address): string {
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new KeystoreError('INVALID_ENVELOPE', `chainId must be a positive integer`);
  }
  return `lptrader-keystore:v${KEYSTORE_VERSION}:chainId=${chainId}:address=${address.toLowerCase()}`;
}

/** Parse the address (and version) back out of an AAD string; `null` when the shape is unknown. */
export function parseAad(aad: string): { version: number; chainId: number; address: Address } | null {
  const match = /^lptrader-keystore:v(\d+):chainId=(\d+):address=(0x[0-9a-f]{40})$/u.exec(aad);
  if (match === null) return null;
  const [, version, chainId, address] = match;
  if (version === undefined || chainId === undefined || address === undefined) return null;
  return {
    version: Number(version),
    chainId: Number(chainId),
    address: address as Address,
  };
}

/**
 * Zero a buffer in place. Used to clear derived key material / plaintext private keys after use.
 * Best-effort by nature (V8 may have copied the bytes), which is why the plaintext is never
 * written to disk or a log in the first place.
 */
export function zeroize(buffer: Buffer | Uint8Array | null | undefined): void {
  if (buffer === null || buffer === undefined) return;
  buffer.fill(0);
}

/**
 * Derive the AES-256 key from the passphrase. The passphrase is normalised (NFKC) so that the same
 * typed characters produce the same key across keyboards/IMEs; it is never trimmed or truncated.
 */
async function deriveKey(passphrase: string, params: ScryptParams, salt: Buffer): Promise<Buffer> {
  if (passphrase.length === 0) {
    throw new KeystoreError('INVALID_PASSPHRASE', 'passphrase must not be empty');
  }
  // maxmem is passed explicitly: N=2^17, r=8 needs 128 MiB and Node defaults to 32 MiB.
  return scrypt(passphrase.normalize('NFKC'), salt, params.keyLength, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: params.maxmem,
  });
}

function assertParams(params: ScryptParams): void {
  const { N, r, p, maxmem, keyLength } = params;
  const isPow2 = Number.isInteger(N) && N > 0 && (N & (N - 1)) === 0;
  if (!isPow2 || N < MIN_N || N > MAX_N) {
    throw new KeystoreError(
      'WEAK_KDF_PARAMS',
      `scrypt N must be a power of two in [${MIN_N}, ${MAX_N}], received ${N}`,
    );
  }
  if (!Number.isInteger(r) || r < 1 || r > MAX_R) {
    throw new KeystoreError('WEAK_KDF_PARAMS', `scrypt r must be an integer in [1, ${MAX_R}]`);
  }
  if (!Number.isInteger(p) || p < 1 || p > MAX_P) {
    throw new KeystoreError('WEAK_KDF_PARAMS', `scrypt p must be an integer in [1, ${MAX_P}]`);
  }
  if (keyLength !== 32) {
    throw new KeystoreError('WEAK_KDF_PARAMS', 'AES-256-GCM requires a 32-byte key');
  }
  const required = 128 * N * r;
  if (!Number.isInteger(maxmem) || maxmem < required) {
    throw new KeystoreError(
      'WEAK_KDF_PARAMS',
      `maxmem must be at least 128*N*r (${required} bytes) for these parameters (research §5)`,
    );
  }
  if (required > MAX_MEM_CEILING) {
    throw new KeystoreError(
      'WEAK_KDF_PARAMS',
      `refusing parameters that would need more than ${MAX_MEM_CEILING} bytes of memory`,
    );
  }
}

function decodeExact(value: unknown, bytes: number, field: string): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    throw new KeystoreError('INVALID_ENVELOPE', `envelope field ${field} is not valid base64`);
  }
  const buffer = Buffer.from(value, 'base64');
  if (buffer.length !== bytes) {
    throw new KeystoreError(
      'INVALID_ENVELOPE',
      `envelope field ${field} must decode to exactly ${bytes} bytes`,
    );
  }
  return buffer;
}

/** Structural validation of an untrusted envelope object. */
export function parseEnvelope(value: unknown): KeystoreEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new KeystoreError('INVALID_ENVELOPE', 'keystore envelope must be a JSON object');
  }
  const record = value as Record<string, unknown>;

  const version = record['v'];
  if (version !== KEYSTORE_VERSION) {
    throw new KeystoreError(
      'UNSUPPORTED_VERSION',
      `unsupported keystore version ${String(version)} (this build writes v${KEYSTORE_VERSION})`,
    );
  }
  const kdf = record['kdf'];
  if (kdf !== KEYSTORE_KDF) {
    throw new KeystoreError(
      'UNSUPPORTED_KDF',
      `unsupported keystore kdf ${String(kdf)} (only "${KEYSTORE_KDF}" is accepted)`,
    );
  }

  const rawParams = record['kdfParams'];
  if (typeof rawParams !== 'object' || rawParams === null) {
    throw new KeystoreError('INVALID_ENVELOPE', 'envelope field kdfParams is missing');
  }
  const paramsRecord = rawParams as Record<string, unknown>;
  const params: ScryptParams = {
    N: Number(paramsRecord['N']),
    r: Number(paramsRecord['r']),
    p: Number(paramsRecord['p']),
    maxmem: Number(paramsRecord['maxmem']),
    keyLength: Number(paramsRecord['keyLength']),
  };
  assertParams(params);

  const aad = record['aad'];
  if (typeof aad !== 'string' || parseAad(aad) === null) {
    throw new KeystoreError('INVALID_ENVELOPE', 'envelope field aad is missing or malformed');
  }
  if (parseAad(aad)?.version !== version) {
    throw new KeystoreError('INVALID_ENVELOPE', 'envelope aad version does not match envelope v');
  }

  // Fail fast on sizes so nothing downstream works with a truncated salt/iv/tag.
  decodeExact(record['salt'], SALT_BYTES, 'salt');
  decodeExact(record['iv'], IV_BYTES, 'iv');
  decodeExact(record['tag'], TAG_BYTES, 'tag');
  const ciphertext = record['ciphertext'];
  if (typeof ciphertext !== 'string' || ciphertext.length === 0) {
    throw new KeystoreError('INVALID_ENVELOPE', 'envelope field ciphertext is empty');
  }

  return {
    v: KEYSTORE_VERSION,
    kdf: KEYSTORE_KDF,
    kdfParams: params,
    salt: record['salt'] as string,
    iv: record['iv'] as string,
    ciphertext,
    tag: record['tag'] as string,
    aad,
  };
}

/** Normalise a 32-byte private key. Never includes the key in the error message. */
function assertPrivateKey(privateKeyHex: string): Hex {
  if (typeof privateKeyHex !== 'string' || !/^0x[0-9a-fA-F]{64}$/u.test(privateKeyHex)) {
    throw new KeystoreError(
      'INVALID_PRIVATE_KEY',
      'private key must be a 0x-prefixed 32-byte hex string',
    );
  }
  if (/^0x0{64}$/u.test(privateKeyHex)) {
    throw new KeystoreError('INVALID_PRIVATE_KEY', 'private key must not be all zeroes');
  }
  return privateKeyHex.toLowerCase() as Hex;
}

export interface EncryptOptions {
  readonly chainId?: number;
  /** Test-only override; validated by `assertParams` (production defaults are the constants above). */
  readonly kdfParams?: Partial<ScryptParams>;
}

export interface DecryptOptions {
  /**
   * When provided, the decrypted address must be derivable for this chain's AAD; a mismatch between
   * the envelope AAD and this chainId is a hard error (metadata substitution attempt).
   */
  readonly chainId?: number;
}

function resolveParams(override?: Partial<ScryptParams>): ScryptParams {
  const params: MutableScryptParams = {
    N: override?.N ?? SCRYPT_N,
    r: override?.r ?? SCRYPT_R,
    p: override?.p ?? SCRYPT_P,
    keyLength: override?.keyLength ?? SCRYPT_KEY_LENGTH,
    maxmem: override?.maxmem ?? SCRYPT_MAXMEM,
  };
  // A caller may lower N for tests; maxmem must still cover whatever was chosen.
  if (override?.maxmem === undefined) {
    params.maxmem = Math.max(SCRYPT_MAXMEM, 128 * params.N * params.r + 8 * 1024 * 1024);
  }
  assertParams(params);
  return params;
}

/**
 * Encrypt a private key into a versioned envelope.
 *
 * AAD binds the envelope to `chainId + keystore version + derived address`, so a swapped envelope
 * (or a swapped chain id) fails authentication instead of decrypting "successfully" to the wrong key.
 */
export async function encryptPrivateKey(
  privateKeyHex: Hex | string,
  passphrase: string,
  options: EncryptOptions = {},
): Promise<KeystoreEnvelope> {
  const key = assertPrivateKey(privateKeyHex);
  const chainId = options.chainId ?? DEFAULT_KEYSTORE_CHAIN_ID;

  let address: Address;
  try {
    address = privateKeyToAccount(key).address.toLowerCase() as Address;
  } catch {
    // Deliberately not forwarding the cause: viem's error can quote the key material.
    throw new KeystoreError('INVALID_PRIVATE_KEY', 'private key cannot be turned into an account');
  }

  const params = resolveParams(options.kdfParams);
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES); // fresh per encryption: IV reuse would break GCM
  const aad = buildAad(chainId, address);

  const derivedKey = await deriveKey(passphrase, params, salt);
  try {
    const cipher = createCipheriv('aes-256-gcm', derivedKey, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(key, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      v: KEYSTORE_VERSION,
      kdf: KEYSTORE_KDF,
      kdfParams: params,
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      tag: tag.toString('base64'),
      aad,
    };
  } finally {
    zeroize(derivedKey);
    zeroize(salt);
  }
}

/**
 * Decrypt an envelope. Any failure — wrong passphrase, tampered ciphertext, tampered tag, tampered
 * AAD, unsupported format — throws a `KeystoreError` with a message that contains no key material.
 */
export async function decryptPrivateKey(
  envelope: KeystoreEnvelope | unknown,
  passphrase: string,
  options: DecryptOptions = {},
): Promise<DecryptedPrivateKey> {
  const parsed = parseEnvelope(envelope);
  const aad = parseAad(parsed.aad);
  if (aad === null) {
    throw new KeystoreError('INVALID_ENVELOPE', 'envelope aad is malformed');
  }
  if (options.chainId !== undefined && options.chainId !== aad.chainId) {
    throw new KeystoreError(
      'INVALID_ENVELOPE',
      `envelope was created for chain ${aad.chainId} but chain ${options.chainId} was requested`,
    );
  }

  const salt = decodeExact(parsed.salt, SALT_BYTES, 'salt');
  const iv = decodeExact(parsed.iv, IV_BYTES, 'iv');
  const tag = decodeExact(parsed.tag, TAG_BYTES, 'tag');
  const derivedKey = await deriveKey(passphrase, parsed.kdfParams, salt);

  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv('aes-256-gcm', derivedKey, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(parsed.aad, 'utf8'));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(parsed.ciphertext, 'base64')),
      decipher.final(),
    ]);
  } catch {
    // Single opaque failure for every authentication problem: no oracle, no key material, and no
    // wording that could be confused with the supplied secret itself.
    throw new KeystoreError(
      'DECRYPT_FAILED',
      'keystore decryption failed: authentication tag mismatch — the envelope is corrupt, was ' +
        'modified, or was encrypted with a different secret',
    );
  } finally {
    zeroize(derivedKey);
    zeroize(salt);
  }

  try {
    const privateKeyHex = plaintext.toString('utf8');
    const key = assertPrivateKey(privateKeyHex);

    let derivedAddress: Address;
    try {
      derivedAddress = privateKeyToAccount(key).address.toLowerCase() as Address;
    } catch {
      throw new KeystoreError('DECRYPT_FAILED', 'decrypted material is not a valid private key');
    }
    if (derivedAddress !== aad.address) {
      throw new KeystoreError(
        'ADDRESS_MISMATCH',
        `decrypted key does not match the address bound to this envelope (expected ${aad.address})`,
      );
    }
    return { privateKeyHex: key, address: derivedAddress };
  } finally {
    zeroize(plaintext);
  }
}

/** Serialise an envelope for disk. Never includes anything but ciphertext + public metadata. */
export function serializeEnvelope(envelope: KeystoreEnvelope): string {
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

/**
 * Write an envelope with mode 0600. Existing files are re-created (not truncated in place) so the
 * restrictive mode cannot be inherited from a previously wider file.
 */
export async function writeKeystoreFile(
  filePath: string,
  envelope: KeystoreEnvelope,
): Promise<void> {
  await writeFile(filePath, serializeEnvelope(envelope), { encoding: 'utf8', mode: 0o600 });
}

/** Read + structurally validate an envelope from disk. */
export async function readKeystoreFile(filePath: string): Promise<KeystoreEnvelope> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    throw new KeystoreError(
      'INVALID_ENVELOPE',
      `cannot read keystore file ${filePath}: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw) as unknown;
  } catch {
    throw new KeystoreError('INVALID_ENVELOPE', `keystore file ${filePath} is not valid JSON`);
  }
  return parseEnvelope(json);
}
