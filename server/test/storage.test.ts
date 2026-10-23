import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { Storage } from '../src/services/storage.js';

test('local exports publish complete immutable bytes, including across filesystems', async () => {
  const source = await mkdtemp(path.join(tmpdir(), 'grt-export-source-'));
  const destination = await mkdtemp(
    path.join(process.env.GRT_TEST_SECOND_FILESYSTEM || tmpdir(), 'grt-export-storage-'),
  );
  try {
    if (process.env.GRT_TEST_SECOND_FILESYSTEM)
      assert.notEqual((await stat(source)).dev, (await stat(destination)).dev);
    const storage = new Storage(
      loadConfig({
        NODE_ENV: 'test',
        STORAGE_SIGNING_KEY: 'export-test-key-'.repeat(4),
        STORAGE_DIRECTORY: destination,
      }),
    );
    const filename = path.join(source, 'result.zip');
    const original = Buffer.from('complete export bytes');
    await writeFile(filename, original, { mode: 0o600 });
    assert.equal(await storage.storeFile('exp_test', filename), 'local-immutable-v1');
    await unlink(filename);
    assert.deepEqual(await readFile(storage.localPath('exp_test')), original);
    assert.equal((await stat(storage.localPath('exp_test'))).mode & 0o777, 0o600);

    await writeFile(filename, 'replacement bytes', { mode: 0o600 });
    await assert.rejects(storage.storeFile('exp_test', filename), { code: 'EEXIST' });
    assert.deepEqual(await readFile(storage.localPath('exp_test')), original);
    await assert.rejects(storage.storeFile('exp_missing', path.join(source, 'missing.zip')), {
      code: 'ENOENT',
    });
    assert.deepEqual(await readdir(destination), ['exp_test']);
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(destination, { recursive: true, force: true });
  }
});
