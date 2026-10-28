import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { Storage } from '../src/services/storage.js';
import { diskUsage } from '../src/routes/storage.js';
import { createDatabase } from '../src/db/index.js';
import { ensureStorage } from '../src/services/storage-state.js';
import { cleanupLocalFiles } from '../src/services/storage-cleanup.js';
import { hash, now } from '../src/util.js';

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

test('local cleanup deletes only matching pinned S3 copies and preserves metadata and unrelated files', async () => {
  const { GetObjectCommand } = await import('@aws-sdk/client-s3');
  const { Readable } = await import('node:stream');
  const directory = await mkdtemp(path.join(tmpdir(), 'grt-local-cleanup-'));
  const c = loadConfig({
    NODE_ENV: 'test',
    SQLITE_FILENAME: path.join(directory, 'art_database'),
    STORAGE_DIRECTORY: directory,
    STORAGE_DRIVER: 's3',
    S3_BUCKET: 'cleanup-test',
    STORAGE_SIGNING_KEY: 'k'.repeat(32),
  });
  const db = createDatabase(c);
  const remote = new Storage(c);
  const objects = new Map<string, Buffer>();
  const reads: string[] = [];
  let changeRecord = false,
    changeFile = false;
  (remote as any).s3 = {
    send: async (command: any) => {
      assert.ok(command instanceof GetObjectCommand); // Cleanup must never write or delete S3 bytes.
      const id = command.input.Key.slice(c.S3_PREFIX.length);
      assert.equal(command.input.VersionId, `version-${id}`);
      reads.push(id);
      if (id === 'art_missing_remote')
        throw Object.assign(new Error('sensitive SDK diagnostic'), { name: 'NoSuchVersion' });
      if (id === 'art_changed' && changeRecord)
        await db.write(async (tx) => {
          await tx.put('artifacts', { ...(await tx.get('artifacts', id))!, status: 'purged' });
        });
      if (id === 'art_changed_file' && changeFile)
        await writeFile(remote.localPath(id), 'changed after hashing');
      return { Body: Readable.from([objects.get(id)!]) };
    },
  };
  const data = Buffer.from('verified original bytes');
  const ids = [
    'art_match',
    'exp_match',
    'art_bad_local',
    'art_bad_remote',
    'art_bad_metadata',
    'art_missing_remote',
    'art_changed',
    'art_changed_file',
    'art_symlink',
    'art_failed',
  ];
  try {
    await db.migrate();
    await ensureStorage(db, c);
    for (const id of ids) {
      objects.set(id, data);
      if (id !== 'art_symlink') await writeFile(remote.localPath(id), data);
      await db.write((tx) =>
        tx.put(id.startsWith('exp_') ? 'exports' : 'artifacts', {
          id,
          created_at: now(),
          status: id.startsWith('exp_') ? 'ready' : id === 'art_failed' ? 'failed' : 'verified',
          object_version: `version-${id}`,
          sha256: ['art_bad_metadata', 'art_failed'].includes(id) ? 'invalid-metadata' : hash(data),
          size_bytes: id === 'art_failed' ? 999 : data.length,
        }),
      );
    }
    await writeFile(path.join(directory, 'unregistered-file'), 'keep unrelated bytes');
    await writeFile(path.join(directory, '.env'), 'keep settings');
    await symlink(path.join(directory, '.env'), remote.localPath('art_symlink'));
    await writeFile(remote.localPath('art_bad_local'), 'wrong local bytes');
    objects.set('art_bad_remote', Buffer.from('wrong S3 bytes'));
    // Even if the SQLite filename looks like an artifact ID, it must never be removed.
    await db.write((tx) =>
      tx.put('artifacts', {
        id: 'art_database',
        created_at: now(),
        status: 'verified',
        object_version: 'version-art_database',
        sha256: 'not-important',
        size_bytes: 1,
      }),
    );
    const snapshot = {
      artifacts: await db.list('artifacts'),
      exports: await db.list('exports'),
      location: await db.get('settings', 'storage'),
    };
    const preview = await cleanupLocalFiles(db, remote, true);
    assert.equal(preview.deleted_files, 0);
    assert.equal(preview.verified_files, 5);
    assert.ok(preview.errors.some((e) => e.code === 'copy_mismatch'));
    assert.ok(preview.errors.some((e) => e.code === 'metadata_mismatch'));
    assert.ok(preview.errors.some((e) => e.code === 'NoSuchVersion'));
    assert.ok(preview.errors.some((e) => e.code === 'not_regular_file'));
    assert.ok(!JSON.stringify(preview).includes('sensitive'));
    assert.deepEqual(await readFile(remote.localPath('art_match')), data);
    const removed = await cleanupLocalFiles(db, remote);
    assert.equal(removed.deleted_files, 5);
    assert.equal(removed.deleted_bytes, 5 * data.length);
    assert.equal(removed.skipped_files, 1);
    await assert.rejects(readFile(remote.localPath('art_match')), { code: 'ENOENT' });
    await assert.rejects(readFile(remote.localPath('exp_match')), { code: 'ENOENT' });
    assert.deepEqual(await db.list('artifacts'), snapshot.artifacts);
    assert.deepEqual(await db.list('exports'), snapshot.exports);
    assert.deepEqual(await db.get('settings', 'storage'), snapshot.location);
    assert.equal(await readFile(path.join(directory, '.env'), 'utf8'), 'keep settings');
    assert.equal(
      await readFile(path.join(directory, 'unregistered-file'), 'utf8'),
      'keep unrelated bytes',
    );
    assert.ok((await stat(c.SQLITE_FILENAME)).isFile());
    assert.ok(!reads.includes('art_database') && !reads.includes('art_symlink'));
    assert.equal((await cleanupLocalFiles(db, remote)).deleted_files, 0);
    // A concurrent DB retirement or local rewrite after hashing must prevent unlinking.
    for (const id of ['art_changed', 'art_changed_file'])
      await writeFile(remote.localPath(id), data);
    changeRecord = true;
    changeFile = true;
    const raced = await cleanupLocalFiles(db, remote);
    assert.ok(raced.errors.some((e) => e.id === 'art_changed' && e.code === 'record_changed'));
    assert.ok(
      raced.errors.some((e) => e.id === 'art_changed_file' && e.code === 'local_file_changed'),
    );
    assert.deepEqual(await readFile(remote.localPath('art_changed')), data);
    assert.equal(
      await readFile(remote.localPath('art_changed_file'), 'utf8'),
      'changed after hashing',
    );
    await assert.rejects(cleanupLocalFiles(db, new Storage({ ...c, S3_BUCKET: 'wrong' })), {
      code: 'storage_location_changed',
    });
    await assert.rejects(cleanupLocalFiles(db, new Storage({ ...c, STORAGE_DRIVER: 'local' })), {
      code: 's3_required',
    });
    await ensureStorage(db, c);
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
