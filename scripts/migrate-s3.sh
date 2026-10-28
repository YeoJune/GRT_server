#!/bin/sh
# One-time EC2 migration to the existing grt-server bucket. No backup archive is created.
set -eu
cd "$(dirname "$0")/.."

[ -f .env ] || { echo '.env 파일이 필요합니다.' >&2; exit 1; }
exec 9>"${TMPDIR:-/tmp}/grt-server-s3-migration.lock"
flock -n 9 || { echo '다른 S3 전환이 진행 중입니다.' >&2; exit 1; }
npm ci
npm run build

export STORAGE_DRIVER=s3 AWS_REGION=ap-northeast-2 S3_BUCKET=grt-server S3_PREFIX=grt/
export S3_BUDGET_BYTES=1000000000000

echo 'S3 권한·Versioning과 진행 중인 작업을 확인합니다.'
node --import tsx --input-type=module <<'JS'
import { loadConfig } from './server/src/config.ts';
import { createDatabase } from './server/src/db/index.ts';
import { checkS3Versioning } from './server/src/services/storage-migration.ts';
const config = loadConfig();
const db = createDatabase(config);
try {
  await checkS3Versioning(config);
  await db.migrate();
  for (const [table, states] of [
    ['jobs', ['running', 'finalizing', 'deleting']],
    ['attempts', ['running', 'finalizing']],
    ['artifacts', ['verifying', 'retired']],
    ['exports', ['preparing', 'deleting']],
  ]) {
    if ((await db.list(table)).some(row => states.includes(row.status)))
      throw Object.assign(new Error(), { code: 'storage_busy' });
  }
} catch (error) {
  console.error(`사전 확인 실패 (${error.code || error.name}). IAM·Versioning을 확인하고 실행·검증·ZIP·삭제 작업이 끝난 뒤 다시 실행하세요.`);
  process.exitCode = 1;
} finally { await db.close(); }
JS

stopped=0
on_exit() {
  grt_result=$?
  if [ "$grt_result" -ne 0 ] && [ "$stopped" -eq 1 ]; then
    echo 'S3 전환 실패: grt는 정지 상태입니다. 오류를 해결한 뒤 같은 스크립트를 다시 실행하세요.' >&2
  fi
  exit "$grt_result"
}
trap on_exit EXIT
trap 'exit 1' HUP INT TERM
sudo -n systemctl stop grt
stopped=1

node --input-type=module <<'JS'
import { readFileSync, mkdtempSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { parse } from 'dotenv';
const updates = {
  STORAGE_DRIVER: 's3', AWS_REGION: 'ap-northeast-2', S3_BUCKET: 'grt-server',
  S3_PREFIX: 'grt/', S3_BUDGET_BYTES: '1000000000000',
};
const original = readFileSync('.env', 'utf8');
let content = original;
for (const key of Object.keys(updates))
  content = content.replace(new RegExp(`^[\\t ]*(?:export[\\t ]+)?${key}[\\t ]*=[^\\r\\n]*(?:\\r?\\n|$)`, 'gm'), '');
content += (content.endsWith('\n') || !content ? '' : '\n')
  + Object.entries(updates).map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
const before = parse(original), after = parse(content);
const untouched = values => Object.entries(values).filter(([key]) => !Object.hasOwn(updates, key));
if (untouched(before).length !== untouched(after).length
  || untouched(before).some(([key, value]) => after[key] !== value))
  throw new Error('기존 설정을 유지할 수 없어 .env 수정을 중단했습니다.');
const temporary = mkdtempSync('.env.s3-');
try {
  writeFileSync(`${temporary}/env`, content, { mode: 0o600 });
  renameSync(`${temporary}/env`, '.env');
} finally { rmSync(temporary, { recursive: true, force: true }); }
console.log('.env의 S3 설정을 적용했습니다.');
JS

npm run storage:migrate -- --confirm-stopped
sudo -n systemctl start grt
stopped=0
curl --fail --silent --show-error \
  --retry 10 --retry-delay 1 --retry-connrefused --max-time 5 \
  https://grt.grtserver.cloud/healthz
printf '\n'

node --import tsx --input-type=module <<'JS'
import { loadConfig } from './server/src/config.ts';
import { Storage } from './server/src/services/storage.ts';
const usage = await new Storage(loadConfig()).usage();
if (usage.status !== 'ok') {
  console.error('S3 사용량 조회 실패. IAM의 ListBucketVersions 권한을 확인하세요.');
  process.exitCode = 1;
} else {
  console.log(`S3 전환 완료: ${usage.bucket}/${usage.prefix} · ${usage.used_bytes} bytes`);
  console.log('웹 설정 → 저장공간에서 확인하세요. 별도 백업은 생성하지 않았으며 기존 로컬 원본은 유지했습니다.');
}
JS
