import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { Storage } from '../src/services/storage.js';
import { diskUsage } from '../src/routes/storage.js';
import { createDatabase } from '../src/db/index.js';
import { ensureStorage } from '../src/services/storage-state.js';
import { now } from '../src/util.js';

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

test('S3 usage counts all versions across pages, caches scans, and distinguishes failure from zero', async () => {
  const { ListObjectVersionsCommand } = await import('@aws-sdk/client-s3');
  const c = loadConfig({
    STORAGE_DRIVER: 's3',
    S3_BUCKET: 'usage-test',
    STORAGE_SIGNING_KEY: 'k'.repeat(32),
  });
  const storage = new Storage(c);
  let calls = 0;
  (storage as any).s3 = {
    send: async (command: any) => {
      assert.ok(command instanceof ListObjectVersionsCommand);
      assert.equal(command.input.Prefix, 'grt/');
      calls++;
      if (calls === 1)
        return {
          Versions: [
            { Size: 5, IsLatest: true },
            { Size: 7, IsLatest: false },
          ],
          IsTruncated: true,
          NextKeyMarker: 'grt/a',
          NextVersionIdMarker: 'v2',
        };
      assert.equal(command.input.KeyMarker, 'grt/a');
      assert.equal(command.input.VersionIdMarker, 'v2');
      return { Versions: [{ Size: 11, IsLatest: true }], DeleteMarkers: [{ Key: 'grt/old' }] };
    },
  };
  const [first, concurrent] = await Promise.all([storage.usage(), storage.usage()]);
  assert.deepEqual(first, concurrent);
  assert.deepEqual(await storage.usage(), first);
  assert.equal(calls, 2);
  assert.equal((first as any).used_bytes, 23);
  assert.equal((first as any).current_bytes, 16);
  assert.equal((first as any).noncurrent_bytes, 7);
  assert.equal((first as any).object_count, 2);
  assert.equal((first as any).delete_markers, 1);
  const broken = new Storage(c);
  (broken as any).s3 = {
    send: async () => {
      throw new Error('sensitive AWS diagnostic');
    },
  };
  const error = (await broken.usage()) as any;
  assert.equal(error.status, 'error');
  assert.equal(error.used_bytes, undefined);
  assert.ok(!JSON.stringify(error).includes('sensitive'));
  const local = new Storage({ ...c, STORAGE_DRIVER: 'local' });
  assert.deepEqual(await local.usage(), { status: 'disabled' });
  const disk = await diskUsage(local.config);
  assert.equal(disk.errors.length, 0);
  assert.ok(disk.filesystems.length > 0);
  assert.ok(disk.filesystems.every((d) => d.total_bytes >= d.used_bytes && d.available_bytes >= 0));
});

test('storage identity rejects a driver/bucket change and old local file references', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'grt-storage-state-'));
  const c = loadConfig({
    NODE_ENV: 'test',
    SQLITE_FILENAME: path.join(directory, 'db.sqlite'),
    STORAGE_SIGNING_KEY: 'k'.repeat(32),
  });
  const db = createDatabase(c);
  try {
    await db.migrate();
    await ensureStorage(db, c);
    await assert.rejects(ensureStorage(db, { ...c, STORAGE_DRIVER: 's3', S3_BUCKET: 'other' }), {
      code: 'storage_location_changed',
    });
    await db.write(async (tx) => {
      await tx.remove('settings', 'storage');
      await tx.put('artifacts', {
        id: 'art_local',
        created_at: now(),
        status: 'verified',
        object_version: 'local-immutable-v1',
      });
    });
    await assert.rejects(ensureStorage(db, { ...c, STORAGE_DRIVER: 's3', S3_BUCKET: 'other' }), {
      code: 'storage_migration_required',
    });
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
