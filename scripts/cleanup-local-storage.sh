#!/bin/sh
# Remove only local copies that still match their recorded, immutable S3 version.
set -eu
cd "$(dirname "$0")/.."
exec 9>"${TMPDIR:-/tmp}/grt-server-local-cleanup.lock"
flock -n 9 || { echo '다른 로컬 파일 정리가 진행 중입니다.' >&2; exit 1; }
node --import tsx --input-type=module - "$@" <<'JS'
import { loadConfig } from './server/src/config.ts';
import { createDatabase } from './server/src/db/index.ts';
import { Storage } from './server/src/services/storage.ts';
import { cleanupLocalFiles } from './server/src/services/storage-cleanup.ts';
import { ApiError } from './server/src/util.ts';
const args = process.argv.slice(2);
if (args.length > 1 || (args.length && args[0] !== '--dry-run')) {
  console.error('Usage: sh scripts/cleanup-local-storage.sh [--dry-run]');
  process.exit(1);
}
const config = loadConfig();
const db = createDatabase(config);
try {
  const result = await cleanupLocalFiles(db, new Storage(config), args.includes('--dry-run'),
    (event, id) => console.log(`${event}: ${id}`));
  console.log(JSON.stringify(result, null, 2));
  if (result.errors.length) process.exitCode = 1;
  console.log('DB·설정·S3 원본은 유지했습니다. 검증하지 못한 로컬 파일과 미등록 항목은 삭제하지 않습니다.');
} catch (error) {
  console.error(error instanceof ApiError ? error.message : '정리를 완료하지 못했습니다. DB·S3 권한과 파일 접근 권한을 확인하세요.');
  process.exitCode = 1;
} finally { await db.close(); }
JS
