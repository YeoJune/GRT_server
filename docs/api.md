# API / 실행기 연결 가이드

기준 URL은 `/v1`이며 인증은 `Authorization: Bearer <GRT_SERVER_TOKEN>` 또는 브라우저 session cookie입니다. UTC ISO8601, 초·byte, 소문자 hex SHA256을 사용합니다.

생성·실험 삭제·claim·finish·complete·batch·export에는 8~128자 `Idempotency-Key`를 보냅니다. 같은 키와 본문이면 기존 결과를 반환하고, 같은 키의 다른 본문은 409입니다. 키는 token ID와 분리된 소유자 namespace에 있으므로 토큰 교체에도 중복 실행을 만들지 않습니다. 빈 claim 뒤에는 새 키로 poll하세요.

`GET /requests/{client_request_id}`는 비밀값을 제외한 접수 결과를 조회합니다. 토큰/lease/서명 URL은 재생하지 않습니다. 토큰 발급 응답 유실은 해당 ID를 폐기·재발급하고, 업로드 URL은 upload ID로 갱신합니다. Claim 응답을 잃고 원래 lease도 보유하지 않았다면 종료 확인 뒤 retry합니다.

오류:

```json
{
  "code": "validation_error",
  "message": "Invalid request fields",
  "request_id": "req_...",
  "retryable": false,
  "field_errors": []
}
```

삭제된 실험을 포함한 과거 요청 응답은 정보 재노출·재생성을 막기 위해 제거하고, 같은 키의 재요청은 410 `resource_deleted`를 반환합니다.

상태는 401 인증, 403 권한·CSRF, 409 정합성 충돌, 413 크기, 422 검증, 429 호출 제한입니다. 일반 GET 목록은 `?limit=50&cursor=...`를 받으며 `{data,next_cursor}`를 반환합니다. `GET /datasets`는 현재 전체 목록 `{data}`를 반환하며 pagination은 지원하지 않습니다. 추가 core 요청 필드는 422입니다. 자유 필드는 JSON Schema가 허용한 spec과 extensions/metrics/summary에 둡니다.

## 로그인 / 토큰

```http
POST /sessions
Content-Type: application/json

{"username":"owner","password":"..."}
```

또는 `{"token":"..."}`를 사용합니다. 응답의 `csrf_token`을 메모리에 보관하고 cookie 변경 요청에서 `X-CSRF-Token`과 올바른 `Origin`을 함께 보냅니다. `GET /me`로 세션의 CSRF token을 다시 얻을 수 있습니다. LocalStorage에 자격을 저장하지 않습니다.

| 경로                       | 본문 / 의미                                                                                                                                   |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /me`                  | kind, token_id, expires_at, API/server version, cookie 인증의 csrf_token                                                                      |
| `DELETE /sessions/current` | 현재 브라우저 session 폐기                                                                                                                    |
| `POST /account/actions`    | `{action:"change_password",new_password,password}` 또는 `{action:"revoke_sessions",password}`. Token session은 password 대신 token으로 재인증 |
| `GET /tokens`              | 원문·해시 없는 메타데이터                                                                                                                     |
| `POST /tokens`             | `{name,kind:"write"\|"read-only",expires_at?}`. 기본 7일, 원문 `token`은 한 번 공개                                                           |
| `PATCH /tokens/{id}`       | `{expires_at}`. 활성 토큰만 변경 가능                                                                                                         |
| `DELETE /tokens/{id}`      | 즉시 폐기                                                                                                                                     |
| `GET /audit`               | 비밀값 없는 감사 로그                                                                                                                         |

Cookie 세션은 기본 절대 8시간 / idle 30분입니다. Token session은 원 token의 폐기·만료를 매 요청 검사하며 생성 시 만료 상한도 유지합니다. 이미 폐기·만료한 token은 재활성화할 수 없습니다.

## 설정 / Schema / 큐

| 경로                                 | 본문 / 의미                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------ |
| `GET /capabilities`                  | 기능·한도·heartbeat·lease·저장소 종류                                                      |
| `GET/PATCH /settings`                | `max_attempt_seconds,upload_margin_seconds`. PATCH는 일부 필드만 가능                      |
| `GET /storage/usage`                 | 인증된 조회. 저장소 종류, S3 경로의 전체 버전 데이터량·1TB 관리 기준, 서버 파일시스템 용량 |
| `GET /schemas` / `GET /schemas/{id}` | 불변 schema 조회                                                                           |
| `POST /schemas`                      | `{id,name,runner,json_schema,report_schema,extensions?}`. [예제](../examples/schema.json)  |
| `GET/POST /queues`                   | 생성 `{name}`                                                                              |
| `POST /queues/{id}/actions`          | `{action:"pause"\|"resume"}`                                                               |

현재 실행 adapter는 `generic/1`만 지원합니다. JSON Schema draft-07 strict mode를 사용하며 schema의 default를 복제한 spec에 적용합니다. Schema를 나중에 바꾸지 않고 새 ID를 등록합니다. `spec.target_steps`는 양의 정수여야 합니다.

설정은 새 작업에 적용합니다. 자동 삭제와 보관 일수 설정은 제공하지 않으며, 지원하지 않는 설정 필드는 422입니다.

`GET /storage/usage`는 read-only도 허용합니다. `driver`, `s3`, `disk`를 반환합니다. S3는 `status=ok|disabled|error`이며 ok일 때 `used_bytes`(현재+이전 버전), `current_bytes`, `noncurrent_bytes`, `object_count`, `version_count`, `delete_markers`, `budget_bytes`, `checked_at`을 제공합니다. 설정한 bucket/prefix만 집계하며 응답을 최대 5분 재사용합니다. 조회 실패 시 error 상태와 안내를 반환하고 0으로 처리하지 않습니다. `budget_bytes`는 제한·예약 용량이 아닌 관리 기준입니다.

`disk.filesystems[]`는 같은 파일시스템을 합쳐 `paths,total_bytes,used_bytes,available_bytes`를 제공합니다. 코드·DB·파일 저장 경로·OS 임시 경로를 확인하며, 애플리케이션 외의 사용량도 포함합니다. `available_bytes`는 서버 계정이 쓸 수 있는 공간이므로 전체−사용량과 다를 수 있습니다. 조회 불가 경로는 `disk.errors[]`에 남깁니다. S3 version 목록은 순차 집계이므로 업로드·삭제 중의 값은 순간적인 근사치이며, delete marker의 키·부가 메타데이터 비용까지 계산하는 청구 API는 아닙니다.

## 실험

[전체 제출 예제](../examples/experiment.json)를 참고하세요.

| 경로                      | 의미                                                                                                  |
| ------------------------- | ----------------------------------------------------------------------------------------------------- |
| `POST /jobs/validate`     | Job JSON 검증, resolved / compatible_workers / warnings 반환. Read-only 허용                          |
| `POST /jobs`              | Job 제출. `dispatch=attached`는 worker_id 필수, job+attempt를 원자 할당                               |
| `POST /jobs/batch`        | `{jobs:[...]}`. Queued만 허용, 최대50개, 오류 시 전체 rollback                                        |
| `GET /jobs`               | `queue,status,campaign` 필터                                                                          |
| `GET /jobs/{id}`          | attempts / artifacts / summary 포함, lease hash 제외                                                  |
| `PATCH /jobs/{id}`        | `{name?,campaign?,wandb_url?,queue?,priority?}`. campaign:null로 해제, queue/priority는 queued만 허용 |
| `DELETE /jobs/{id}`       | write·멱등 키 필수. 정보·이력·파일·관련 ZIP 영구 삭제, 202 deleting / 없는 ID는 204                   |
| `POST /jobs/{id}/actions` | `{action:"cancel"\|"retry"\|"resume"\|"clone",termination_evidence?,overrides?}`                      |

W&B 링크는 `summary.wandb_url`에 저장하며 HTTPS `wandb.ai` URL을 사용합니다. 실험 수정으로 기존 실행의 링크도 등록·해제할 수 있습니다. GRT는 online run 링크를 heartbeat와 완료 시 자동 전송합니다.

Queued 취소는 즉시 cancelled, running 취소는 cancel_requested만 기록합니다. Stale running retry는 lease 만료와 10자 이상 종료 근거가 필요합니다. 근거는 사람이 이전 process/runtime 종료를 확인한 기록입니다. 서버가 단순 timeout을 종료 증거로 간주하지 않습니다. Failed/interrupted/cancelled는 이미 finish되었으므로 별도 근거 없이 retry할 수 있습니다. Resume은 `grt.resume/1`의 같은 job·verified snapshot을 선택해 새 attempt에 연결합니다. `checkpoint_artifact_id`로 지정하거나 최신 보존 snapshot을 선택합니다. 없으면 409 resume_checkpoint_missing입니다. Stale running의 lease·종료 근거 검사는 retry와 같습니다. Claim의 resume_mode=checkpoint, resume_artifact_ids를 사용하고 worker가 Config·manifest·world size·last/best 관계를 확인합니다. Resume 후 각 attempt에 원본 artifact ID를 보존합니다.

Clone은 새로운 job을 만들며 overrides는 다시 schema 검증합니다.

삭제는 running/finalizing이면 409 `job_active`, 관련 ZIP이 preparing이면 409 `export_busy`입니다. 취소·종료 또는 ZIP 완료 후 새 키로 요청하세요. 접수 즉시 API 파일 접근과 수정·재실행을 차단하고, 비동기 정리 후 GET은 404가 됩니다. `deletion_error`가 있으면 자동 재시도하며 새 DELETE 키로 즉시 재시도를 요청할 수 있습니다. S3는 기존 서명 URL 유효기간만큼 대기합니다. 감사 로그와 중복 방지용 최소 기록, 공유 dataset은 유지합니다. 다중 실험 ZIP은 통째로 삭제하며 다른 실험 원본은 유지합니다.

Policy는 `max_attempt_seconds,eta_seconds,checkpointable,preflight_seconds,required_artifact_kinds,require_posthoc`를 받습니다. 기본 필수 파일은 report/config/provenance이고 이 세 증거는 generic adapter에서 항상 필수입니다. ETA 미측정은 checkpointable=true인 작업에만 claim을 허용합니다. 서버가 checkpoint 기능을 worker에 대신 구현하지 않습니다.

재개용 snapshot은 최근 2개와 현재 배정·실행에 필요한 원본을 보존합니다. 나머지는 retired → purged로 bytes를 제거하며 metadata는 유지합니다. S3 URL 대기·파일 삭제 재시도를 적용하고 preparing ZIP이 원본을 읽는 동안은 정리를 기다립니다. 이 규칙은 snapshot 전용이며 일반 결과의 기간별 자동 삭제는 제공하지 않습니다.

## 실행기 / Claim / Heartbeat

1. Secret source를 `env`, Colab userdata, Kaggle secrets 중 명시적으로 선택해 `GRT_SERVER_TOKEN`을 읽습니다. 실패하면 오류로 처리하고 다른 source로 fallback하지 마세요.
2. `GET /me`로 write와 만료·API 버전을 확인합니다. Secret은 로그·연구 Config·결과에 포함하지 않습니다.
3. Worker를 등록합니다. Worker ID는 token ID와 독립이며, 같은 runtime은 고정 session_key를 사용합니다.

```json
{
  "name": "colab-session",
  "session_key": "client-generated-runtime-uuid",
  "environment": "colab",
  "runners": ["generic/1"],
  "schema_ids": ["generic_v1"],
  "gpu_count": 1,
  "world_size": 1,
  "labels": [],
  "deadline_at": "2030-01-01T12:00:00Z",
  "extensions": {}
}
```

4. `POST /workers/{id}/claim`에 `{"queue":"research"}`와 새 Idempotency-Key를 보냅니다. 없으면 204 / Retry-After:10입니다. 있으면 job, attempt_id, lease_token, generation, lease_expires_at, deadline_at를 받습니다. lease는 안전한 로컬 전송 journal에만 저장하고 public output에 표시하지 않습니다.
5. 반환된 불변 spec을 사용합니다. Notebook의 연구 조건으로 덮어쓰지 않습니다. Attached는 같은 worker 등록 후 `POST /jobs`에 `dispatch:"attached",worker_id`를 넣고 응답의 assignment를 사용합니다.
6. 기본 30초마다 heartbeat를 보냅니다.

```json
{
  "worker_id": "worker_...",
  "lease_token": "...",
  "generation": 1,
  "stage": "training",
  "progress": { "current": 100, "total": 1000, "unit": "step" },
  "eta_seconds": 1800,
  "metrics": { "loss": 3.2 },
  "summary": { "best_loss": 3.2 },
  "last_verified_checkpoint_id": null
}
```

`POST /attempts/{id}/heartbeat`의 command는 continue/cancel/drain입니다. Stage는 preparing/preflight/training/posthoc/uploading입니다. Total/ETA 미측정은 null을 사용합니다. `last_verified_checkpoint_id`는 해당 attempt의 verified checkpoint만 허용합니다.

| 경로                         | 의미                                                 |
| ---------------------------- | ---------------------------------------------------- |
| `GET/POST /workers`          | 등록 / 재연결. 동일 session_key는 기존 worker를 반환 |
| `GET /workers/{id}`          | 현재 active_attempt 메타데이터, lease 원문 없음      |
| `POST /workers/{id}/actions` | `{action:"drain"\|"resume"}`                         |
| `POST /workers/{id}/claim`   | 현재 worker의 active attempt가 있으면 409            |

토큰이 만료되거나 쓰기 권한을 잃으면 신규 claim/서버 쓰기를 멈추고 worker가 로컬 저장·안전 중단해야 합니다. 서버가 외부 notebook 프로세스를 강제로 종료하지 않습니다. 기존 lease를 가진 동일 worker는 토큰 교체 후 다시 연결할 수 있지만, lease 없는 새 프로세스는 종료 확인 후 retry해야 합니다.

## 파일 업로드 / 완료 검증

예약:

```http
POST /artifacts/uploads
Idempotency-Key: <uuid>
```

```json
{
  "name": "report.json",
  "job_id": "job_...",
  "attempt_id": "att_...",
  "kind": "report",
  "size_bytes": 123,
  "sha256": "<64 lowercase hex>",
  "format": "json",
  "format_version": "1",
  "extensions": {}
}
```

Kind는 report/config/provenance/checkpoint/log/result/dataset입니다. Dataset은 공유 입력으로 job_id/attempt_id 없이 등록합니다. 출력 파일은 현재 running attempt에 연결해야 합니다. 파일명은 경로가 아닌 단일 이름입니다.

응답의 `upload.url`에 **Bearer 헤더 없이** 원본 bytes를 PUT합니다. S3일 때는 `upload.headers`도 함께 전달합니다. `POST /artifacts/uploads`에 `{upload_id}`를 보내 같은 예약의 URL을 갱신합니다.

이후 `POST /artifacts/uploads/{id}/complete`에 `{}`와 Idempotency-Key를 보내고 `GET /artifacts/uploads/{id}`를 poll합니다. 202 verifying 후 실제 크기와 SHA256이 일치해야 verified입니다. 실패한 파일은 새 예약으로 다시 업로드합니다. ETag는 hash로 사용하지 않습니다.

종료:

```json
{
  "worker_id": "worker_...",
  "lease_token": "...",
  "generation": 1,
  "outcome": "completed",
  "stage": "uploading",
  "error": null,
  "artifact_ids": ["art_config", "art_provenance", "art_report"],
  "manifest": {
    "spec_sha256": "<job.spec_sha256>",
    "config_sha256": "<config file SHA256>",
    "completed_steps": 1000,
    "target_steps": 1000,
    "posthoc_completed": false
  }
}
```

`POST /attempts/{id}/finish`는 202를 반환합니다. Outcome은 completed/interrupted/failed/cancelled입니다. 이후에는 heartbeat를 종료해도 서버가 finalizing 검증을 계속합니다.

Completed에 필요한 report JSON:

```json
{
  "spec_sha256": "...",
  "config_sha256": "...",
  "completed_steps": 1000,
  "posthoc_completed": false
}
```

Provenance JSON:

```json
{ "spec_sha256": "...", "config_sha256": "...", "runner": "generic/1" }
```

실제 Config는 원본 JSON 파일로 보존합니다. generic/1은 Config의 각 resolved spec 필드가 불변 spec과 같은지도 검사합니다. 환경 metadata는 추가 필드 또는 provenance에 기록할 수 있습니다. Manifest와 report의 완료 step은 불변 spec.target_steps를 충족하고, spec/config hash·runner·report schema와 필요한 posthoc를 모두 통과해야 합니다. 과학적 타당성 판정은 수행하지 않습니다. 명시적 resume snapshot 복원은 GRT worker가 담당합니다.

## Prepared 공유 캐시

`GET /datasets`는 검증된 `grt.prepared/1` dataset 목록, `GET /datasets/{manifest_sha256}`는 정확한 manifest hash의 캐시를 반환합니다. 읽기 전용 토큰도 조회·다운로드할 수 있습니다. 기존 artifact 업로드 API에 kind=dataset, format=zip, extensions={cache_format:"grt.prepared/1",manifest_sha256:"<64 hex>"}를 사용합니다. 같은 manifest의 예약·검증 중·완료 항목은 같은 archive hash/size일 때 재사용합니다. 충돌은 409이며 실패한 업로드는 새로 예약할 수 있습니다. 전송·SHA256 검증은 기존 파일 API와 같고 archive 내용·manifest 파일별 검사는 GRT client가 수행합니다.

## 조회 / 결과 ZIP

- `GET /artifacts/{id}/download`: verified object version의 짧은 다운로드 URL, sha256, size_bytes. Read-only 허용.
- `POST /exports`: `{job_ids:[...],artifact_ids:[...]}`. Verified 파일 집합을 고정해 비동기 ZIP 생성, read-only 허용.
- `GET /exports/{id}`: preparing/ready/failed. Ready 응답의 download.url 사용.
- `GET /allocations`: 현재 empty / enabled:false.
- `POST /providers/vast/offers/search`: `{query:{...}}`. Read-only 허용, 서버 VAST_API_KEY 필요.
- `POST /allocations`, `/allocations/{id}/actions`, `/workers/enroll`: write 권한 검사 후 501, 유료 작업 없음.

서명 URL은 token 폐기 후에도 자체 만료까지 유효할 수 있습니다. API 폐기와 이미 발급된 URL의 수명을 구분하세요.

ZIP 요청 접수는 생성 성공을 뜻하지 않습니다. `ready`까지 조회하고 `failed`이면 `error`를 확인합니다. 원인을 해결한 뒤 새 Idempotency-Key로 다시 요청하세요. 같은 파일 집합의 preparing/ready ZIP은 재사용하지만 실패한 ZIP은 재사용하지 않습니다. 학습·원본 업로드를 다시 수행할 필요는 없습니다.

## CLI

연결 URL·토큰을 설정한 뒤 `npm run cli -- storage usage`로 S3와 디스크 사용량을 JSON으로 확인할 수 있습니다.

환경별 준비·관리 예제는 [사용 가이드](environments.md)를 따릅니다. `metadata.json`에는 변경할 name/campaign/wandb_url 또는 대기 작업의 queue/priority만 넣습니다.

토큰은 환경 secret으로 주입하고 명령행 인자로 전달하지 않습니다. `.env`에 GRT_SERVER_URL / GRT_SERVER_TOKEN을 적어도 되지만 Git에 올리지 마세요.

```bash
npm run cli -- me
npm run cli -- queues create research
npm run cli -- schemas register examples/schema.json
npm run cli -- jobs validate examples/experiment.json
npm run cli -- jobs submit examples/experiment.json
npm run cli -- jobs list --queue research --json
npm run cli -- jobs update job_123 --file metadata.json
npm run cli -- jobs delete job_123 --yes
npm run cli -- jobs clone job_123
npm run cli -- jobs resume job_123 --checkpoint art_123
npm run cli -- jobs retry job_123 --evidence "이전 runtime 종료를 확인했습니다"
npm run cli -- queues pause research
npm run cli -- workers drain worker_123
npm run cli -- results collect --campaign baseline --new --output ./results
npm run cli -- exports create --jobs job_123,job_456
npm run cli -- exports get exp_123
npm run cli -- requests get client-request-id
npm run cli -- tokens create --name codex --kind read-only --expires-at 2030-01-01T00:00:00Z
```

CLI는 기본 JSON을 출력하며 `--json`을 지원합니다. Token 발급 원문은 interactive terminal에서 한 번만 표시하므로 출력 redirect는 거부합니다. `results collect --new`는 기존 로컬 파일의 SHA256까지 확인하고 일치할 때만 건너뜁니다. 파일명은 artifact ID/hash로 정해 원본 파일명 충돌을 피하고 metadata를 별도 JSON으로 저장합니다.

특정 작업 재시도에 같은 키를 사용하려면 `GRT_REQUEST_ID` 환경변수를 고정합니다. 다른 명령에 같은 키를 재사용하면 409이므로 작업 단위로 설정하세요. 내장 shell·SSH·임의 Python 실행은 제공하지 않습니다. 브라우저는 GUI를 통해 동일 API를 사용하며 텍스트 명령 콘솔은 별도로 제공하지 않습니다.

`jobs list` CLI 필터는 현재 `--queue`만 지원합니다. Campaign·status 조합 조회는 웹 또는 `GET /jobs?campaign=...&status=...`를 사용하세요. `results collect --campaign`은 succeeded 작업의 verified 파일만 수집합니다. 부분 결과는 웹·파일 API로 받습니다.
