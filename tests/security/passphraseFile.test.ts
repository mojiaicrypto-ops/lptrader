import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPassphraseFile } from '../../src/security/passphraseFile.ts';

const dirs: string[] = [];
async function tempFile(contents: string, mode: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pass-'));
  dirs.push(dir);
  const file = join(dir, 'passphrase');
  await writeFile(file, contents, { mode });
  await chmod(file, mode); // writeFile's mode is masked by umask on some systems
  return file;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('passphrase file: unattended start, without weakening the key', () => {
  it('reads the first line of a 0600 file', async () => {
    const file = await tempFile('correct horse battery staple\n', 0o600);
    expect(await readPassphraseFile(file)).toBe('correct horse battery staple');
  });

  it('is null when unset, so the interactive path still works', async () => {
    expect(await readPassphraseFile(undefined)).toBeNull();
    expect(await readPassphraseFile('')).toBeNull();
  });

  it('tolerates a trailing newline from an editor', async () => {
    // An editor that appends a newline must not silently change the passphrase into an invalid one.
    const file = await tempFile('secret\n\n', 0o600);
    expect(await readPassphraseFile(file)).toBe('secret');
  });

  it('REFUSES a group- or world-readable file instead of warning', async () => {
    // Warning-and-continuing would let the bot trade happily while its key is exposed, and the exposure
    // would be discovered only after the funds were gone. The refusal is the point of this module.
    const file = await tempFile('secret\n', 0o644);
    await expect(readPassphraseFile(file)).rejects.toThrow(/mode 644/);
  });

  it('refuses a file readable by group alone', async () => {
    const file = await tempFile('secret\n', 0o640);
    await expect(readPassphraseFile(file)).rejects.toThrow(/chmod 600/);
  });

  it('names the remedy in the error, because an operator needs the fix not the diagnosis', async () => {
    const file = await tempFile('secret\n', 0o604);
    await expect(readPassphraseFile(file)).rejects.toThrow(new RegExp(`chmod 600 ${file}`));
  });

  it('refuses an empty file rather than starting with an empty passphrase', async () => {
    const file = await tempFile('', 0o600);
    await expect(readPassphraseFile(file)).rejects.toThrow(/empty/);
  });

  it('reports an unreadable path with the path in the message', async () => {
    await expect(readPassphraseFile('/nonexistent/passphrase')).rejects.toThrow(/\/nonexistent\/passphrase/);
  });

  it('refuses a directory, which would otherwise read as a mysterious failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pass-dir-'));
    dirs.push(dir);
    await expect(readPassphraseFile(dir)).rejects.toThrow(/not a regular file/);
  });
});
