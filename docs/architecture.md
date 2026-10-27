# 구현 구조

```text
web (React) ── /v1 ── Express
CLI / worker ───────────┤
                       ├─ routes: 인증·검증·권한·HTTP
                       ├─ services/experiments: claim·lease·호환 조건
                       ├─ services/background: 검증·완료·ZIP·삭제
                       ├─ db: Knex / SQLite 또는 PostgreSQL
                       └─ services/storage: local 또는 S3
```

## 저장 구조

단일 소유자, 작은 연구 큐를 위한 초기 구현입니다. `accounts`, `sessions`, `tokens`, `settings`, `schemas`, `queues`, `workers`, `jobs`, `attempts`, `artifacts`, `exports`, `requests`, `audit` 테이블을 분리하고, 각 테이블은 `id`, `created_at`, `body`를 가집니다. 확장 JSON을 SQLite/PostgreSQL에서 동일하게 보존하기 위해 payload를 JSON text로 저장합니다.

ID·생성 시각에는 SQL index가 있으며 상태·campaign·호환 필터와 pagination은 서비스에서 수행합니다. 현재 구현은 단일 소유자의 작은 연구 큐를 대상으로 합니다.

DB 변경은 Knex migration으로 관리합니다. SQLite는 WAL + 단일 연결, PostgreSQL은 transaction의 singleton row lock으로 제어 변경·claim·중복 키 저장을 직렬화합니다. 다중 프로세스 운영은 현재 범위가 아닙니다. 백그라운드 검증기는 서버 프로세스 하나에서 실행하세요.

운영 설정은 최대 실행 시간과 전송 여유를 제공합니다. 기간에 따른 자동 삭제와 보관 일수 설정은 제공하지 않습니다. 재개 snapshot만 별도의 최근 2개 보존 규칙을 적용합니다.

## 인증과 로그

원문 API 토큰과 lease는 난수이며 DB에는 SHA256 해시만 저장합니다. 비밀번호는 Argon2id를 사용합니다. 브라우저 세션도 서버에서 매 요청 검증합니다. Bearer 헤더가 있으면 cookie보다 우선하며, 잘못된 Bearer에서 cookie로 fallback하지 않습니다.

변경 요청의 cookie 인증에는 일치하는 Origin과 `X-CSRF-Token`이 필요합니다. 읽기 의미의 POST도 cookie를 사용하면 CSRF 검사를 받습니다. Bearer 요청의 권한은 HTTP method에 의존하지 않습니다. `/jobs/validate`, `/exports`, Vast offer 검색은 read-only에 허용합니다.

토큰의 원문, lease 원문, 서명 URL은 멱등 응답 기록에서 제외합니다. 토큰 발급 응답 유실은 기록의 token ID를 폐기하고 새로 발급하세요. Claim / attached 응답 재생에는 `lease_recovery_required=true`가 붙습니다. 이미 가진 lease는 그대로 사용하고, lease를 잃었다면 기존 실행 종료 확인 후 retry해야 합니다. 원문 lease를 재조회해 새 프로세스에 복제하지 않습니다.

감사 로그는 로그인 성공·실패, token·계정·schema·설정·queue 변경과 job 수정·삭제·취소·복구 근거를 기록합니다. 운영 access log에는 Authorization, cookie, request body, 서명 URL query를 남기지 마세요.

## 상태 전이

`queued → running → finalizing → succeeded`가 정상 흐름입니다. 예외 상태는 `failed`, `interrupted`, `cancelled`입니다. Heartbeat lease가 끊겨도 job을 자동 재배정하지 않습니다. `GET /jobs/{id}`의 attempt에 `stale=true`를 표시하고, retry에는 종료 근거가 필요합니다.

Finish는 generation과 필수 파일 ID·manifest를 고정하고 202를 반환합니다. 이후에는 worker heartbeat가 없어도 서버가 검증하며, token이 만료되어도 이미 받은 검증은 계속됩니다. 재시작 시 DB의 verifying / finalizing / preparing 항목을 다시 처리합니다.

`generic/1`은 config 파일의 hash·resolved spec 필드 일치, provenance의 spec/config/runner, report schema·spec hash·완료 step, 필수 posthoc 선언을 검증합니다. `spec.target_steps`는 양의 정수여야 합니다. 과학적 학습 결과의 진실성이나 GRT budget/world size 의미까지 증명하는 검증기가 아닙니다. 전용 runner를 추가하기 전 `grt/1`은 거부합니다.

Retry는 불변 spec의 fresh attempt를 대기열에 넣습니다. Resume은 같은 실험의 verified `grt.resume/1` snapshot ID를 연결하고 다음 claim에서 generation을 증가시킵니다. GRT worker가 명시적으로 요청한 복원을 실행하며 원본 attempt·파일은 보존합니다. 연결과 secret 설정은 spec·결과에 포함하지 마세요.

재개 ZIP에는 현재 학습 state·best·실제 Config·배치 보정·metrics·W&B ID만 담고 secret/lease는 넣지 않습니다. 서버는 snapshot 최근 2개와 활성 재개의 원본을 보존하며 나머지는 retired 상태를 저장한 뒤 bytes를 삭제하고 purged 이력을 유지합니다. 삭제 실패·재시작은 DB 기록으로 재시도하며 preparing ZIP에 필요한 파일은 기다립니다.

## 파일·비동기 작업

로컬 업로드는 임시 파일에 streaming 후 hard link로 한 번만 확정합니다. 사용자 파일명은 저장 경로로 사용하지 않습니다. S3는 업로드를 예약하고 client가 직접 전송합니다. 검증기는 실제 bytes를 SHA256으로 읽으며, 검증한 object version만 이후 다운로드합니다.

운영에서 S3를 선택하면 prepared·checkpoint·리포트·ZIP을 모두 같은 S3 저장 어댑터로 처리합니다. EC2에는 DB와 ZIP 생성용 임시 파일이 남습니다. 시작 시 DB에 기록한 driver/bucket/prefix/region과 설정을 비교하여 잘못된 저장소 전환을 차단합니다. 로컬→S3 이전은 서버를 멈춘 상태에서 별도 명령으로 수행하며, 모든 대상의 크기·SHA256을 확인한 뒤 파일 버전 참조를 한 transaction으로 전환합니다. 원본 bytes·기존 ZIP manifest·연구 조건은 변경하지 않고 로컬 원본도 자동 삭제하지 않습니다.

저장량 조회는 S3의 설정 경로에 대해 전체 object version을 pagination으로 읽고 현재·이전 버전 bytes를 합산합니다. 최대 5분 캐시와 진행 중 요청 공유를 적용하며 별도 broker·일일 집계 DB는 두지 않습니다. 서버 디스크는 파일시스템 통계로 전체·사용·가용량을 읽고 같은 mount를 합칩니다. S3 초기 1TB는 표시용 관리 기준이며 quota가 아닙니다.

Export는 요청 시 verified artifact ID/hash/version 집합을 고정합니다. 하나의 ZIP에 원본 파일과 manifest를 담고 fingerprint가 같은 preparing/ready 결과는 재사용합니다. 로컬 ZIP은 저장 디렉터리의 임시 파일로 완전히 복사한 뒤 같은 파일시스템에서 hard link로 확정하므로, OS 임시 디렉터리와 저장소가 다른 mount여도 동작하며 기존 원본은 덮어쓰지 않습니다. 제한은 preparing 2개와 총 원본 bytes 한도입니다. Export API의 24시간 만료는 접근·재사용 기간이며 자동 파일 삭제는 없습니다.

검증은 별도 broker 없이 DB 기반 polling으로 실행합니다. 파일 검증 중 일시적인 object 미존재·저장 장애는 최대 10분 재시도합니다. Finalizing에서 미검증 파일 대기는 최대 24시간입니다. 크기/hash/schema 불일치는 실패 사유를 보존합니다.

## 명시적 실험 삭제

종료된 실험 또는 queued 작업은 `deleting`으로 전환합니다. DB에 삭제 요청·S3 URL 대기 시각·오류·재시도 시각을 저장하고 백그라운드가 파일부터 지운 뒤 메타데이터를 transaction으로 제거합니다. 재시작·부분 삭제 후에도 재시도할 수 있으며 실제 파일 제거 실패를 성공으로 처리하지 않습니다. 로컬 수신 중인 업로드는 완료·폐기를 기다리고, 삭제 상태가 된 예약은 새 파일을 확정할 수 없습니다.

실험의 attempt·artifact·관련 export와 과거 멱등 응답의 실험 데이터를 제거합니다. 멱등 키 tombstone과 감사 로그는 유지합니다. 다중 실험 ZIP은 전체 제거하고 공유 dataset과 다른 실험 원본은 유지합니다. S3는 기존 서명 URL 만료 뒤 모든 object version·delete marker를 제거합니다. 보관 정책에 따른 자동 삭제와는 별개의 사용자 관리 기능입니다.

## 실행기와 구현 범위

GRT 공통 helper는 `generic/1`과 불변 schema로 upload/queue 연결을 제공하며 실제 연구 Config·원본 결과와 서버 검증용 envelope를 구분합니다. 임대 비용이 발생하는 Vast 조작, 독립 과금 감시, 임의 checkpoint 복원, 보관 정책에 따른 자동 삭제와 GRT 과학적 완료 검증은 미지원이며 capabilities에 공개합니다. 실행기 사용법은 [GRT 서버 연결](https://github.com/YeoJune/GRT/blob/main/docs/server.md)을 따릅니다.
