import { stat } from 'node:fs/promises';
import { GetBucketVersioningCommand, S3Client } from '@aws-sdk/client-s3';
import type { Config } from '../config.js';
import type { Database, RecordData } from '../db/index.js';
import { assert, canonical, id, now } from '../util.js';
import { Storage } from './storage.js';

function location(c: Config) {
  return c.STORAGE_DRIVER === 's3'
    ? { driver: 's3', bucket: c.S3_BUCKET, prefix: c.S3_PREFIX, region: c.AWS_REGION }
    : { driver: 'local' };
}

// Fail before serving requests when an operator changes the driver/bucket without migration.
export async function ensureStorage(db: Database, c: Config) {
  await db.write(async (tx) => {
    const saved = await tx.get('settings', 'storage');
    const target = location(c);
    assert(
      !saved || canonical(saved.location) === canonical(target),
      409,
      'storage_location_changed',
      'Storage location changed. Stop the server and run storage:migrate before starting with S3.',
    );
    for (const a of [...(await tx.list('artifacts')), ...(await tx.list('exports'))]) {
      if (!['verified', 'ready'].includes(a.status)) continue;
      assert(
        a.object_version &&
          (a.object_version === 'local-immutable-v1') === (c.STORAGE_DRIVER === 'local'),
        409,
        'storage_migration_required',
        'Stored files use another driver. Stop the server and run storage:migrate.',
      );
    }
    if (!saved) await tx.put('settings', { id: 'storage', created_at: now(), location: target });
  });
}

export async function migrateToS3(
  db: Database,
  source: Storage,
  destination: Storage,
  progress: (id: string) => void = () => {},
) {
  assert(
    source.config.STORAGE_DRIVER === 'local' && destination.config.STORAGE_DRIVER === 's3',
    422,
    'invalid_storage_migration',
    'Only offline local-to-S3 migration is supported',
  );
  const before = {
    artifacts: await db.list('artifacts'),
    exports: await db.list('exports'),
    jobs: await db.list('jobs'),
    attempts: await db.list('attempts'),
    storage: await db.get('settings', 'storage'),
  };
  const target = location(destination.config);
  if (before.storage?.location?.driver === 's3') {
    assert(
      canonical(before.storage.location) === canonical(target),
      409,
      'storage_location_changed',
      'Database already points to another S3 location',
    );
    return { migrated: 0, already_migrated: true };
  }
  assert(
    !before.jobs.some((j) => ['running', 'finalizing', 'deleting'].includes(j.status)) &&
      !before.attempts.some((a) => ['running', 'finalizing'].includes(a.status)) &&
      !before.artifacts.some((a) => ['verifying', 'retired'].includes(a.status)) &&
      !before.exports.some((e) => ['preparing', 'deleting'].includes(e.status)),
    409,
    'storage_busy',
    'Finish/cancel active experiments and wait for verification, ZIP creation and deletion before stopping the server.',
  );
  const changes: { table: 'artifacts' | 'exports'; record: RecordData; version: string }[] = [];
  for (const table of ['artifacts', 'exports'] as const) {
    for (const record of before[table]) {
      if (record.status === 'purged') continue;
      assert(
        !record.object_version || record.object_version === 'local-immutable-v1',
        409,
        'mixed_storage',
        'Database contains S3 files without a matching migration record',
      );
      const filename = source.localPath(record.id);
      try {
        await stat(filename);
      } catch (error: any) {
        if (error.code === 'ENOENT' && !['verified', 'ready'].includes(record.status)) continue;
        throw error;
      }
      const original = await source.digest(record);
      if (['verified', 'ready'].includes(record.status))
        assert(
          original.sha256 === record.sha256 && original.size_bytes === record.size_bytes,
          409,
          'source_hash_mismatch',
          `Local file differs from its verified metadata: ${record.id}`,
        );
      const object_version =
        (await destination.existingVersion(record.id)) ||
        (await destination.storeFile(record.id, filename));
      const verified = await destination.digest({ ...record, object_version });
      assert(
        verified.sha256 === original.sha256 && verified.size_bytes === original.size_bytes,
        409,
        'destination_hash_mismatch',
        `S3 object differs from local file; no DB changes made: ${record.id}`,
      );
      changes.push({ table, record, version: object_version });
      progress(record.id);
    }
  }
  await db.write(async (tx) => {
    for (const table of ['artifacts', 'exports', 'jobs', 'attempts'] as const)
      assert(
        canonical(await tx.list(table)) === canonical(before[table]),
        409,
        'storage_changed',
        'Database changed during migration. Stop all server processes and retry.',
      );
    assert(
      canonical((await tx.get('settings', 'storage')) ?? null) ===
        canonical(before.storage ?? null),
      409,
      'storage_changed',
      'Storage configuration changed during migration',
    );
    for (const change of changes)
      await tx.put(change.table, { ...change.record, object_version: change.version });
    // Existing ZIP bytes/manifests remain immutable historical exports. New exports use new versions.
    await tx.put('settings', {
      id: 'storage',
      created_at: before.storage?.created_at || now(),
      location: target,
    });
    await tx.put('audit', {
      id: id('audit'),
      created_at: now(),
      action: 'storage.migrate',
      location: target,
      migrated: changes.length,
    });
  });
  return { migrated: changes.length, already_migrated: false };
}

export async function checkS3Versioning(c: Config) {
  const client = new S3Client({ region: c.AWS_REGION });
  try {
    const result = await client.send(new GetBucketVersioningCommand({ Bucket: c.S3_BUCKET }));
    assert(
      result.Status === 'Enabled',
      422,
      's3_versioning_required',
      'Enable bucket versioning before migration',
    );
  } finally {
    client.destroy();
  }
}
