import { loadConfig } from '../server/src/config.js';
import { createDatabase } from '../server/src/db/index.js';
import { Storage } from '../server/src/services/storage.js';
import { checkS3Versioning, migrateToS3 } from '../server/src/services/storage-migration.js';
import { ApiError } from '../server/src/util.js';

// This is an offline operator command, never an API or an automatic startup migration.
const config = loadConfig();
if (!process.argv.includes('--confirm-stopped') || config.STORAGE_DRIVER !== 's3') {
  console.error(
    'Stop grt, back up the DB/files, set STORAGE_DRIVER=s3, then run npm run storage:migrate -- --confirm-stopped',
  );
  process.exit(1);
}
const host = ['0.0.0.0', '::'].includes(config.HOST) ? '127.0.0.1' : config.HOST;
let reachable = false;
try {
  await fetch(`http://${host.includes(':') ? `[${host}]` : host}:${config.PORT}/healthz`, {
    signal: AbortSignal.timeout(1500),
  });
  reachable = true;
} catch {
  /* The operator must also stop any other server process using this DB. */
}
if (reachable) {
  console.error('The server is still reachable. Stop grt before migrating.');
  process.exit(1);
}
const db = createDatabase(config);
try {
  await checkS3Versioning(config);
  await db.migrate();
  const result = await migrateToS3(
    db,
    new Storage({ ...config, STORAGE_DRIVER: 'local' }),
    new Storage(config),
    (id) => console.log(`Verified ${id}`),
  );
  console.log(JSON.stringify(result));
  console.log(
    'Local originals retained. Start grt and verify downloads, ZIP, resume and deletion before removing backup files.',
  );
} catch (error: any) {
  if (error instanceof ApiError) console.error(error.message);
  console.error(
    `Migration failed (${error.code || error.name || 'error'}). DB file locations were not partially committed; local originals are retained.`,
  );
  process.exitCode = 1;
} finally {
  await db.close();
}
