# GRT Server

실험 설정·큐·실행기·결과를 관리하는 단일 소유자용 서버입니다. [설계 문서](https://github.com/YeoJune/GRT/blob/main/docs/20261021_experiment_control_api_design.md)의 HTTP 계약을 **Node.js 24 + Express 5 + React 19 + TypeScript**로 구현했습니다.

SQLite로 시작하며 Knex를 통해 PostgreSQL / RDS PostgreSQL을 선택할 수 있습니다. React는 Vite로 빌드하고 운영 시 Express가 같은 origin에서 제공합니다.

## 빠른 시작

Node.js 24 이상이 필요합니다.

```bash
npm ci
cp .env.example .env
openssl rand -hex 32
```

`.env`에 다음 값을 기입합니다. `STORAGE_SIGNING_KEY`에는 위에서 생성한 난수를 넣습니다. 계정은 공개 회원가입 없이 관리 명령으로 한 번 생성합니다.

```dotenv
OWNER_USERNAME=owner
OWNER_PASSWORD=12자_이상의_실제_비밀번호
STORAGE_SIGNING_KEY=생성한_32자_이상의_난수
```

```bash
npm run account:setup
npm run dev
```

- 화면: http://localhost:5173
- API: http://127.0.0.1:3000/v1
- 상태 확인: http://127.0.0.1:3000/healthz

설정 화면에서 `generic_v1` 예제 schema를 등록하고, 큐·실행기 화면에서 `research` 큐를 만든 후 신규 실험의 예제 JSON을 검증·등록하면 됩니다. **실행기는 별도로 연결해야 학습이 시작됩니다. 서버가 GPU 학습 프로세스를 직접 실행하지 않습니다.**

계정 생성 후 `OWNER_PASSWORD`는 `.env`에서 지워도 됩니다. DB에는 Argon2id 해시만 남습니다. `.env`, DB, 로컬 파일, 발급 토큰은 Git에서 제외됩니다.

`.env.example`에는 기본 실행에 필요한 항목만 있습니다. SQLite·로컬 파일 저장을 기본으로 사용하므로 나머지 설정은 필요한 경우에만 `.env`에 추가합니다. 포트·파일 경로·세션 시간·용량 한도 등 선택 설정과 기본값은 [`server/src/config.ts`](server/src/config.ts)에서 확인할 수 있습니다. PostgreSQL·S3·운영 배포 설정은 아래에 정리했습니다. Vast offer 검색만 사용할 경우 서버에 `VAST_API_KEY`를 추가합니다.

## 제공 기능

- 비밀번호 / API 토큰 로그인, HttpOnly 세션 쿠키, Origin·CSRF 검사, 로그인 속도 제한
- `write`, `read-only` 두 권한, 토큰 1회 공개·만료·폐기, 원 토큰 폐기의 브라우저 세션 즉시 반영
- 불변 JSON Schema / 실험 spec, 검증과 원자적 batch 등록, JSON 확장 필드 보존
- 큐 pause/resume, 우선순위, worker drain, 호환 조건·남은 시간 검사, 원자적 claim
- Attached 등록, heartbeat / lease / generation, stale 복구 시 종료 근거 기록, 취소 명령 전달
- 크기·SHA256 검증 후 파일 확정, 원본 보관, 개별 다운로드, 비동기 결과 ZIP
- 로컬 파일 / S3 저장 어댑터, UTC API / KST 화면, cursor pagination, 재요청 중복 방지
- React 네 화면과 [로컬 CLI](docs/api.md#cli), 감사 로그

## 운영 실행

```bash
npm run build
npm start
```

`APP_ORIGIN`을 실제 접속 주소로 설정합니다. 운영 환경은 HTTPS reverse proxy 뒤에서 실행합니다.

```dotenv
NODE_ENV=production
APP_ORIGIN=https://research.example.com
COOKIE_SECURE=true
TRUST_PROXY=1
```

로컬에서 빌드된 화면만 확인할 때는 `NODE_ENV=development`, `APP_ORIGIN=http://localhost:3000`을 사용합니다. 운영 모드에서는 HTTPS와 Secure 쿠키 설정이 없으면 시작을 거부합니다. [Nginx 예제](docs/nginx.conf.example)를 참고하세요.

DB migration은 시작 시 적용되며 별도 실행도 가능합니다.

```bash
npm run db:migrate
npm run account:reset
```

비밀번호 분실 시 `.env`의 `OWNER_USERNAME` / `OWNER_PASSWORD`를 새 값으로 바꾸고 `account:reset`을 실행합니다. 기존 브라우저 세션은 모두 폐기합니다. API 토큰도 폐기하려면 `RESET_REVOKE_TOKENS=true`를 함께 설정합니다.

## DB 전환

기본 SQLite 파일은 `data/grt.sqlite`입니다. PostgreSQL / RDS PostgreSQL은 다음 설정을 사용합니다.

```dotenv
DB_CLIENT=pg
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/grt
DB_SSL=true
DB_SSL_CA_FILE=/absolute/path/to/rds-global-bundle.pem
```

`npm run db:migrate`로 선택한 DB에 테이블을 만듭니다. **접속 설정 변경은 기존 SQLite 데이터를 자동 이전하지 않습니다.** 이전은 서버 정지 → 일관된 백업 → 데이터 복사·검증 → DB 전환 순서로 수행해야 합니다. RDS MySQL은 현재 드라이버에 포함하지 않았습니다.

개발용 PostgreSQL이 TLS 없이 구동될 때만 `DB_SSL=false`를 사용합니다. 운영 TLS는 서버 인증서를 검증하며, 인증서 검증을 끄는 옵션은 제공하지 않습니다.

## 파일 저장

기본은 단일 호스트의 `data/artifacts` 디렉터리이며 필요하면 `STORAGE_DIRECTORY`로 변경합니다. 원자적 파일 생성으로 업로드한 바이트를 덮어쓰지 않습니다. 관리 프로세스 밖에서 파일을 변경하지 마세요.

S3로 전환하려면:

```dotenv
STORAGE_DRIVER=s3
AWS_REGION=ap-northeast-2
S3_BUCKET=your-private-versioned-bucket
S3_PREFIX=grt/
```

버킷의 **versioning·암호화·비공개 접근**을 설정하고 서버 IAM role에 해당 prefix의 GetObject / GetObjectVersion / PutObject 권한을 부여합니다. AWS SDK 기본 credential chain을 사용합니다. 서버는 실제 파일을 다시 읽어 SHA256을 검증하고 검증한 VersionId를 고정합니다. 서명 URL은 최대 5분과 현재 인증 만료 중 짧은 값으로 발급합니다. URL 자체는 짧은 수명의 자격이므로 로그에 기록하지 마세요.

저장 어댑터 변경도 기존 파일의 자동 이전을 수행하지 않습니다. SQLite는 실행 중 단순 파일 복사 대신 SQLite backup API 또는 서버 정지 후 snapshot을 사용하고, DB와 파일을 함께 백업하세요.

## 검증

```bash
npm run check
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

시스템 Chromium을 사용하려면 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium`을 지정합니다. 테스트는 임시 SQLite·파일 디렉터리를 사용하고 소유자 계정을 별도로 만듭니다. GitHub Actions에서도 검사·API 테스트·브라우저 테스트를 실행합니다.

API 테스트는 동시 claim, 권한·CSRF·토큰 폐기, 원자적 batch, stale 복구와 구세대 차단, 파일 hash 검증, 완료 검증, ZIP 생성을 포함합니다. 실제 AWS / RDS / Vast / Colab / Kaggle 연결과 GPU 학습은 별도 환경 검증이 필요합니다.

AWS 배포 후 실제 환경 점검은 [기능 점검안](docs/20261023_aws_acceptance_test_plan.md)을 따릅니다. 작은 실험부터 큐·장애 복구·백업 복원까지 순서와 판정 기준을 정리했습니다.

## 구현 경계

이 버전은 실제 동작하는 제어 서버의 첫 구현입니다. 설계의 모든 외부 시스템이 연결된 상태는 아닙니다.

| 항목                                    | 현재 상태                                                                  |
| --------------------------------------- | -------------------------------------------------------------------------- |
| API·인증·큐·결과·GUI·CLI                | 구현, 로컬 통합 / 브라우저 테스트 포함                                     |
| `generic/1` 완료 검증                   | spec hash, target steps, report schema, config/provenance와 필수 파일 검증 |
| GRT 전용 runner / 학습 의미 검증        | 미구현. `grt/1`은 422. 서버 adapter와 worker 구현 필요                     |
| GRT notebook helper 자동 저장           | GRT 공통 helper의 선택적 upload/queue 연결 제공. 실제 GPU·AWS 검증은 별도  |
| Checkpoint 학습·posthoc 복원            | 원본 파일 보관만 제공. retry는 fresh 실행이며 자동 복원하지 않음           |
| Vast                                    | 키 설정 시 offer 검색만 제공. 유료 임대·start/stop/destroy·enroll은 501    |
| 독립 EventBridge / Lambda deadline 감시 | 배포하지 않음. 유료 임대를 활성화하기 전 구현 필요                         |
| 보관 정책 자동 삭제                     | 미구현. 보관 일수 설정은 제공하지 않으며 원본을 자동 삭제하지 않음         |
| DB / S3 운영 이전                       | 어댑터 제공. 데이터 자동 복사와 실제 AWS 검증은 미수행                     |

과학적 완료 판정을 확장할 때는 [`services/background.ts`](server/src/services/background.ts)와 runner adapter를 추가하고, capabilities에 지원 여부를 공개하세요. 프론트엔드에서 학습 완료를 임의로 확정하지 않습니다.

API 본문과 worker 연결 순서는 [API 가이드](docs/api.md), DB·모듈 구성과 설계 차이는 [구현 메모](docs/architecture.md)에 정리했습니다.
