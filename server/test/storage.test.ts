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

test('revoked uploads cannot publish bytes and local deletion is idempotent', async () => {
  const { Readable } = await import('node:stream');
  const directory = await mkdtemp(path.join(tmpdir(), 'grt-delete-'));
  const storage = new Storage(
    loadConfig({
      NODE_ENV: 'test',
      STORAGE_DIRECTORY: directory,
      STORAGE_SIGNING_KEY: 'test-key-'.repeat(8),
    }),
  );
  try {
    await assert.rejects(
      storage.receive('art_revoked', Readable.from([Buffer.from('bytes')]), 5, async () => false),
      { code: 'upload_closed' },
    );
    assert.equal(storage.receiving.size, 0);
    assert.deepEqual(await readdir(directory), []);
    await writeFile(storage.localPath('art_delete'), 'result');
    await storage.remove({ id: 'art_delete' });
    await storage.remove({ id: 'art_delete' });
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('S3 deletion removes only the exact key, all versions and markers, and reports partial failures', async () => {
  const { ListObjectVersionsCommand, DeleteObjectsCommand } = await import('@aws-sdk/client-s3');
  const storage = new Storage(
    loadConfig({
      NODE_ENV: 'test',
      STORAGE_DRIVER: 's3',
      S3_BUCKET: 'test-bucket',
      STORAGE_SIGNING_KEY: 'test-key-'.repeat(8),
    }),
  );
  const deleted: any[] = [];
  const pages = [
    {
      Versions: [
        { Key: 'grt/art_test', VersionId: 'v1' },
        { Key: 'grt/art_test_other', VersionId: 'keep' },
      ],
      DeleteMarkers: [{ Key: 'grt/art_test', VersionId: 'marker' }],
      IsTruncated: true,
    },
    { Versions: [{ Key: 'grt/art_test', VersionId: 'v2' }] },
    {},
  ];
  (storage as any).s3 = {
    send: async (command: any) => {
      if (command instanceof ListObjectVersionsCommand) return pages.shift();
      assert.ok(command instanceof DeleteObjectsCommand);
      deleted.push(...command.input.Delete.Objects);
      return {};
    },
  };
  await storage.remove({ id: 'art_test' });
  assert.deepEqual(deleted, [
    { Key: 'grt/art_test', VersionId: 'v1' },
    { Key: 'grt/art_test', VersionId: 'marker' },
    { Key: 'grt/art_test', VersionId: 'v2' },
  ]);
  (storage as any).s3 = {
    send: async (command: any) =>
      command instanceof ListObjectVersionsCommand
        ? { Versions: [{ Key: 'grt/art_test', VersionId: 'v1' }] }
        : { Errors: [{ Code: 'AccessDenied' }] },
  };
  await assert.rejects(storage.remove({ id: 'art_test' }), { code: 'storage_delete_failed' });
});
