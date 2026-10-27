import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { Storage } from '../src/services/storage.js';
import { diskUsage } from '../src/routes/storage.js';
import { createDatabase } from '../src/db/index.js';
import { ensureStorage, migrateToS3 } from '../src/services/storage-migration.js';
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

test('offline S3 migration verifies bytes, commits locations atomically, retries copies and keeps originals', async () => {
  const { ListObjectVersionsCommand, GetObjectCommand, PutObjectCommand } =
    await import('@aws-sdk/client-s3');
  const { Readable } = await import('node:stream');
  const directory = await mkdtemp(path.join(tmpdir(), 'grt-s3-migration-'));
  const c = loadConfig({
    NODE_ENV: 'test',
    SQLITE_FILENAME: path.join(directory, 'db.sqlite'),
    STORAGE_DIRECTORY: directory,
    STORAGE_SIGNING_KEY: 'k'.repeat(32),
  });
  const db = createDatabase(c);
  const source = new Storage(c);
  const destination = new Storage({ ...c, STORAGE_DRIVER: 's3', S3_BUCKET: 'migration-test' });
  const objects = new Map<string, { version: string; data: Buffer }>();
  let failKey = 'grt/exp_test',
    writes = 0;
  (destination as any).s3 = {
    send: async (command: any) => {
      const key = command.input.Key || command.input.Prefix;
      if (command instanceof ListObjectVersionsCommand) {
        const object = objects.get(key);
        return {
          Versions: object ? [{ Key: key, VersionId: object.version, IsLatest: true }] : [],
        };
      }
      if (command instanceof PutObjectCommand) {
        if (key === failKey) throw new Error('simulated upload failure');
        const chunks = [];
        for await (const chunk of command.input.Body) chunks.push(Buffer.from(chunk));
        const object = { version: `s3-version-${++writes}`, data: Buffer.concat(chunks) };
        objects.set(key, object);
        return { VersionId: object.version };
      }
      assert.ok(command instanceof GetObjectCommand);
      const object = objects.get(key)!;
      assert.equal(command.input.VersionId, object.version);
      return { Body: Readable.from([object.data]) };
    },
  };
  try {
    await db.migrate();
    const file = Buffer.from('original prepared/checkpoint bytes');
    const zip = Buffer.from('original ZIP and historical manifest bytes');
    await writeFile(source.localPath('art_test'), file);
    await writeFile(source.localPath('exp_test'), zip);
    await db.write(async (tx) => {
      await tx.put('artifacts', {
        id: 'art_test',
        created_at: now(),
        status: 'verified',
        object_version: 'local-immutable-v1',
        sha256: hash(file),
        size_bytes: file.length,
      });
      await tx.put('exports', {
        id: 'exp_test',
        created_at: now(),
        status: 'ready',
        object_version: 'local-immutable-v1',
        sha256: hash(zip),
        size_bytes: zip.length,
        artifacts: [{ id: 'art_test', object_version: 'local-immutable-v1' }],
      });
      await tx.put('jobs', { id: 'job_test', created_at: now(), status: 'running' });
    });
    await ensureStorage(db, c);
    await assert.rejects(migrateToS3(db, source, destination), { code: 'storage_busy' });
    assert.equal(writes, 0);
    await db.write(async (tx) => {
      await tx.put('jobs', { ...(await tx.get('jobs', 'job_test'))!, status: 'succeeded' });
    });
    await assert.rejects(ensureStorage(db, destination.config), {
      code: 'storage_location_changed',
    });
    await writeFile(source.localPath('art_test'), 'corrupt source');
    await assert.rejects(migrateToS3(db, source, destination), { code: 'source_hash_mismatch' });
    assert.equal(writes, 0);
    await writeFile(source.localPath('art_test'), file);
    await assert.rejects(migrateToS3(db, source, destination), /simulated upload failure/);
    assert.equal((await db.get('artifacts', 'art_test'))!.object_version, 'local-immutable-v1');
    assert.equal(writes, 1);
    // A corrupt destination is never overwritten or accepted.
    objects.get('grt/art_test')!.data = Buffer.from('corrupt');
    await assert.rejects(migrateToS3(db, source, destination), {
      code: 'destination_hash_mismatch',
    });
    objects.get('grt/art_test')!.data = file;
    failKey = '';
    assert.deepEqual(await migrateToS3(db, source, destination), {
      migrated: 2,
      already_migrated: false,
    });
    assert.equal(writes, 2); // The previously verified copy was reused, not versioned again.
    const artifact = (await db.get('artifacts', 'art_test'))!;
    assert.equal(artifact.object_version, 's3-version-1');
    assert.deepEqual(await destination.digest(artifact), {
      sha256: hash(file),
      size_bytes: file.length,
    });
    assert.deepEqual(await readFile(source.localPath('art_test')), file);
    assert.deepEqual(await readFile(source.localPath('exp_test')), zip);
    assert.equal(
      (await db.get('exports', 'exp_test'))!.artifacts[0].object_version,
      'local-immutable-v1',
    );
    await ensureStorage(db, destination.config);
    await assert.rejects(ensureStorage(db, c), { code: 'storage_location_changed' });
    await assert.rejects(ensureStorage(db, { ...destination.config, S3_BUCKET: 'other' }), {
      code: 'storage_location_changed',
    });
    assert.deepEqual(await migrateToS3(db, source, destination), {
      migrated: 0,
      already_migrated: true,
    });
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
