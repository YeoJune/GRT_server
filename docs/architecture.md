# 구현 구조와 설계 적용

```text
web (React) ── /v1 ── Express
CLI / worker ───────────┤
                       ├─ routes: 인증·검증·권한·HTTP
                       ├─ services/experiments: claim·lease·호환 조건
                       ├─ services/background: 검증·완료·ZIP
                       ├─ db: Knex / SQLite 또는 PostgreSQL
                       └─ services/storage: local 또는 S3
```

## 저장 구조

단일 소유자, 작은 연구 큐를 위한 초기 구현입니다. `accounts`, `sessions`, `tokens`, `settings`, `schemas`, `queues`, `workers`, `jobs`, `attempts`, `artifacts`, `exports`, `requests`, `audit` 테이블을 분리하고, 각 테이블은 `id`, `created_at`, `body`를 가집니다. 확장 JSON을 SQLite/PostgreSQL에서 동일하게 보존하기 위해 payload를 JSON text로 저장합니다.

ID·생성 시각에는 SQL index가 있으며, 현재 상태·campaign·호환 필터는 서비스에서 수행합니다. 따라서 데이터가 커지면 `status`, `queue`, `job_id` 등을 SQL 열로 추출하고 repository에서 필터·pagination을 처리하는 migration이 필요합니다. 현재 구현을 대규모 분산 scheduler로 사용하지 마세요.

DB 변경은 Knex migration으로 관리합니다. SQLite는 WAL + 단일 연결, PostgreSQL은 transaction의 singleton row lock으로 제어 변경·claim·중복 키 저장을 직렬화합니다. 다중 프로세스 운영은 현재 범위가 아닙니다. 백그라운드 검증기는 서버 프로세스 하나에서 실행하세요.

## 인증과 로그

원문 API 토큰과 lease는 난수이며 DB에는 SHA256 해시만 저장합니다. 비밀번호는 Argon2id를 사용합니다. 브라우저 세션도 서버에서 매 요청 검증합니다. Bearer 헤더가 있으면 cookie보다 우선하며, 잘못된 Bearer에서 cookie로 fallback하지 않습니다.

변경 요청의 cookie 인증에는 일치하는 Origin과 `X-CSRF-Token`이 필요합니다. 읽기 의미의 POST도 cookie를 사용하면 CSRF 검사를 받습니다. Bearer 요청의 권한은 HTTP method에 의존하지 않습니다. `/jobs/validate`, `/exports`, Vast offer 검색은 read-only에 허용합니다.

토큰의 원문, lease 원문, 서명 URL은 멱등 응답 기록에서 제외합니다. 토큰 발급 응답 유실은 기록의 token ID를 폐기하고 새로 발급하세요. Claim / attached 응답 재생에는 `lease_recovery_required=true`가 붙습니다. 이미 가진 lease는 그대로 사용하고, lease를 잃었다면 기존 실행 종료 확인 후 retry해야 합니다. 원문 lease를 재조회해 새 프로세스에 복제하지 않습니다.

감사 로그는 로그인 성공·실패, token·계정·schema·설정·queue 변경과 job 취소·복구 근거를 기록합니다. 운영 access log에는 Authorization, cookie, request body, 서명 URL query를 남기지 마세요.

## 상태 전이

`queued → running → finalizing → succeeded`가 정상 흐름입니다. 예외 상태는 `failed`, `interrupted`, `cancelled`입니다. Heartbeat lease가 끊겨도 job을 자동 재배정하지 않습니다. `GET /jobs/{id}`의 attempt에 `stale=true`를 표시하고, retry에는 종료 근거가 필요합니다.

Finish는 generation과 필수 파일 ID·manifest를 고정하고 202를 반환합니다. 이후에는 worker heartbeat가 없어도 서버가 검증하며, token이 만료되어도 이미 받은 검증은 계속됩니다. 재시작 시 DB의 verifying / finalizing / preparing 항목을 다시 처리합니다.

`generic/1`은 config 파일의 hash·resolved spec 필드 일치, provenance의 spec/config/runner, report schema·spec hash·완료 step, 필수 posthoc 선언을 검증합니다. `spec.target_steps`는 양의 정수여야 합니다. 과학적 학습 결과의 진실성이나 GRT budget/world size 의미까지 증명하는 검증기가 아닙니다. 전용 runner를 추가하기 전 `grt/1`은 거부합니다.

Retry는 불변 spec의 새 attempt를 대기열에 넣고, 다음 claim에서 generation을 증가시킵니다. 기존 checkpoint는 조회·다운로드할 수 있지만 자동 학습 복원은 하지 않습니다. 연결과 secret 설정은 spec·결과에 포함하지 마세요.

## 파일·비동기 작업

로컬 업로드는 임시 파일에 streaming 후 hard link로 한 번만 확정합니다. 사용자 파일명은 저장 경로로 사용하지 않습니다. S3는 업로드를 예약하고 client가 직접 전송합니다. 검증기는 실제 bytes를 SHA256으로 읽으며, 검증한 object version만 이후 다운로드합니다.

Export는 요청 시 verified artifact ID/hash/version 집합을 고정합니다. 하나의 ZIP에 원본 파일과 manifest를 담고 fingerprint가 같으면 기존 결과를 재사용합니다. 초기 제한은 preparing 2개, 총 원본 bytes 한도입니다. Export API의 24시간 만료는 접근·재사용 기간이며 자동 파일 삭제 작업은 아직 없습니다.

검증은 별도 broker 없이 DB 기반 polling으로 실행합니다. 파일 검증 중 일시적인 object 미존재·저장 장애는 최대 10분 재시도합니다. Finalizing에서 미검증 파일 대기는 최대 24시간입니다. 크기/hash/schema 불일치는 실패 사유를 보존합니다.

## 설계와 차이

FastAPI 대신 Express를 사용합니다. 초기 운영을 간단히 하기 위해 로컬 저장소를 기본 제공하고 S3를 선택 가능하게 했습니다. 임대 비용이 발생하는 Vast 조작, independent watchdog, GRT helper 수정, checkpoint 복원, 자동 retention은 구현하지 않았고 capabilities에 공개했습니다. 무한 성공 응답이나 가짜 allocation을 반환하지 않습니다.
