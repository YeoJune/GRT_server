import type { Config } from '../config.js';
import type { Database } from '../db/index.js';
import { assert, canonical, now } from '../util.js';

export function storageLocation(c: Config) {
  return c.STORAGE_DRIVER === 's3'
    ? { driver: 's3', bucket: c.S3_BUCKET, prefix: c.S3_PREFIX, region: c.AWS_REGION }
    : { driver: 'local' };
}

// Changing environment variables must not silently point existing records at another store.
export async function ensureStorage(db: Database, c: Config) {
  await db.write(async (tx) => {
    const saved = await tx.get('settings', 'storage');
    const target = storageLocation(c);
    assert(
      !saved || canonical(saved.location) === canonical(target),
      409,
      'storage_location_changed',
      'Storage location differs from this database. Restore the configured location; automatic data migration is not supported.',
    );
    for (const file of [...(await tx.list('artifacts')), ...(await tx.list('exports'))]) {
      if (!['verified', 'ready'].includes(file.status)) continue;
      assert(
        file.object_version &&
          (file.object_version === 'local-immutable-v1') === (c.STORAGE_DRIVER === 'local'),
        409,
        'storage_migration_required',
        'Stored files use another driver. Configure the original storage location before starting.',
      );
    }
    if (!saved) await tx.put('settings', { id: 'storage', created_at: now(), location: target });
  });
}
