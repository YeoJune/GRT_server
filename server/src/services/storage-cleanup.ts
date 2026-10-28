import { lstat, readdir, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { Database } from '../db/index.js';
import { resolveRoot } from '../config.js';
import { ApiError, assert, canonical } from '../util.js';
import { Storage } from './storage.js';
import { storageLocation } from './storage-state.js';

export async function cleanupLocalFiles(
  db: Database,
  remote: Storage,
  dryRun = false,
  report: (event: string, id: string) => void = () => {},
) {
  const c = remote.config;
  const target = storageLocation(c);
  assert(c.STORAGE_DRIVER === 's3', 409, 's3_required', 'Local cleanup requires STORAGE_DRIVER=s3');
  assert(
    canonical((await db.get('settings', 'storage'))?.location ?? null) === canonical(target),
    409,
    'storage_location_changed',
    'DB storage location does not match the configured S3 bucket/prefix/region',
  );
  const local = new Storage({ ...c, STORAGE_DRIVER: 'local' });
  const protectedPaths = new Set([resolveRoot('.env')]);
  if (c.DB_CLIENT === 'sqlite') {
    const filename = resolveRoot(c.SQLITE_FILENAME);
    for (const suffix of ['', '-wal', '-shm', '-journal']) protectedPaths.add(filename + suffix);
  }
  for (const filename of [...protectedPaths]) {
    try {
      protectedPaths.add(await realpath(filename));
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const result = {
    dry_run: dryRun,
    verified_files: 0,
    verified_bytes: 0,
    deleted_files: 0,
    deleted_bytes: 0,
    skipped_files: 0,
    errors: [] as { id: string; code: string }[],
    remaining_entries: 0,
  };
  for (const table of ['artifacts', 'exports'] as const) {
    for (const record of await db.list(table)) {
      // Only server-generated IDs can identify old artifact bytes; never scan/remove a whole directory.
      if (!(table === 'artifacts' ? /^art_[\w-]+$/ : /^exp_[\w-]+$/).test(record.id)) continue;
      const filename = local.localPath(record.id);
      try {
        let before;
        try {
          before = await lstat(filename, { bigint: true });
        } catch (error: any) {
          if (error.code === 'ENOENT') continue;
          throw error;
        }
        if (
          protectedPaths.has(path.resolve(filename)) ||
          protectedPaths.has(await realpath(filename)) ||
          !record.object_version ||
          ['local-immutable-v1', 'null'].includes(record.object_version) ||
          ['deleting', 'retired', 'purged', 'verifying', 'preparing'].includes(record.status)
        ) {
          result.skipped_files++;
          report('skipped', record.id);
          continue;
        }
        assert(
          before.isFile() && !before.isSymbolicLink(),
          409,
          'not_regular_file',
          'Only regular local files can be cleaned',
        );
        report('checking', record.id);
        const original = await local.digest(record);
        const stored = await remote.digest(record); // Always reads the exact VersionId recorded in the DB.
        assert(
          original.sha256 === stored.sha256 && original.size_bytes === stored.size_bytes,
          409,
          'copy_mismatch',
          'Local and S3 bytes differ',
        );
        if (['verified', 'ready'].includes(record.status))
          assert(
            stored.sha256 === record.sha256 && stored.size_bytes === record.size_bytes,
            409,
            'metadata_mismatch',
            'S3 bytes differ from verified metadata',
          );
        await db.write(async (tx) => {
          assert(
            canonical((await tx.get('settings', 'storage'))?.location ?? null) ===
              canonical(target),
            409,
            'storage_location_changed',
            'Storage location changed during cleanup',
          );
          const current = await tx.get(table, record.id);
          assert(
            current && canonical(current) === canonical(record),
            409,
            'record_changed',
            'File record changed during verification',
          );
          if (current.job_id)
            assert(
              (await tx.get('jobs', current.job_id))?.status !== 'deleting',
              409,
              'job_deleting',
              'Job deletion is in progress',
            );
          const after = await lstat(filename, { bigint: true });
          assert(
            after.isFile() &&
              before.dev === after.dev &&
              before.ino === after.ino &&
              before.size === after.size &&
              before.mtimeNs === after.mtimeNs &&
              before.ctimeNs === after.ctimeNs,
            409,
            'local_file_changed',
            'Local file changed during verification',
          );
          if (!dryRun) await unlink(filename);
        });
        result.verified_files++;
        result.verified_bytes += original.size_bytes;
        if (!dryRun) {
          result.deleted_files++;
          result.deleted_bytes += original.size_bytes;
        }
        report(dryRun ? 'would_delete' : 'deleted', record.id);
      } catch (error: any) {
        const diagnostic = error?.code || error?.name || '';
        const code =
          error instanceof ApiError
            ? error.code
            : /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(diagnostic)
              ? diagnostic
              : 'storage_check_failed';
        result.errors.push({ id: record.id, code });
        report(code, record.id);
      }
    }
  }
  try {
    result.remaining_entries = (await readdir(local.directory)).length;
  } catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
  }
  return result;
}
