# GRT Server

GRT의 실험 설정·큐·실행 상태·결과를 관리하는 단일 소유자용 서버입니다. 학습은 Colab·Kaggle 등 외부 실행기가 수행합니다. Node.js 24 + Express 5 + React 19 + TypeScript를 사용하며, 기본 저장소는 SQLite와 로컬 파일입니다.

## 빠른 시작

Node.js 24 이상이 필요합니다.

```bash
npm ci
cp .env.example .env
openssl rand -hex 32
```

`.env`에 소유자 계정과 생성한 난수를 기입합니다. 비밀번호는 12자 이상, 서명 키는 32자 이상입니다.

```dotenv
OWNER_USERNAME=owner
OWNER_PASSWORD=실제_비밀번호
STORAGE_SIGNING_KEY=생성한_난수
```

```bash
npm run account:setup
npm run dev
```

- 화면: http://localhost:5173
- API: http://127.0.0.1:3000/v1
- 상태 확인: http://127.0.0.1:3000/healthz

계정 생성 후 `OWNER_PASSWORD`는 `.env`에서 지워도 됩니다. `.env`, DB, 원본 파일과 토큰은 Git에 올리지 않습니다. 선택 설정과 기본값은 [`server/src/config.ts`](server/src/config.ts)에 있습니다.

## 실행기 연결

GRT에서 `server_mode='upload'`를 선택하면 기존 notebook 실험의 상태·원본 결과·checkpoint를 자동 저장합니다. `queue`는 서버에 제출한 불변 spec을 실행하고, 기본 `off`는 서버 없이 실행합니다. 연결 방법은 [GRT 서버 연결](https://github.com/YeoJune/GRT/blob/main/docs/server.md)을 따릅니다.

일반 실행기는 설정 화면에서 [예제 schema](examples/schema.json)를 등록하고 `research` 큐를 만든 뒤 [실험 JSON](examples/experiment.json)을 검증·제출할 수 있습니다. 작업을 가져올 실행기는 별도로 연결해야 합니다. HTTP 계약과 CLI 명령은 [API 가이드](docs/api.md)에 있습니다.

## 제공 기능과 범위

- 비밀번호·API 토큰 로그인, HttpOnly 세션, Origin·CSRF 검사, 로그인 속도 제한
- `write` / `read-only` 권한, 토큰 발급·만료·폐기, 감사 로그
- 불변 schema·spec, 원자적 batch 등록, 재요청 중복 방지
- 우선순위 큐·pause/resume·worker drain, 호환 조건·deadline 검사, 원자적 claim
- attached 실행, heartbeat·lease·generation, 취소 전달과 종료 근거를 남기는 stale 복구
- 크기·SHA256 검증, 원본 보관, 개별 다운로드·비동기 ZIP·CLI 결과 수집
- SQLite 또는 PostgreSQL, 로컬 파일 또는 S3 저장 어댑터

현재 완료 검증기는 `generic/1`입니다. Config·provenance·report·완료 step을 검증하며, GRT 학습의 과학적 타당성 판정과 서버 checkpoint 자동 복원은 제공하지 않습니다. Retry는 새 attempt의 fresh 실행입니다. `grt/1`은 거부합니다.

Vast는 키 설정 시 offer 검색만 제공합니다. 유료 임대·start/stop/destroy·enroll, 독립 과금 감시, 보관 정책에 따른 자동 삭제는 미지원입니다. DB·저장 어댑터 설정 변경은 기존 데이터를 자동 이전하지 않습니다.

## 운영과 검증

HTTPS·systemd·업데이트·백업/복원·선택 DB/S3 설정은 [운영 문서](docs/operations.md), 내부 구성은 [구현 구조](docs/architecture.md)에 정리했습니다.

```bash
npm run check
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

검사는 임시 DB·파일·별도 브라우저 서버를 사용합니다. 시스템 Chromium은 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`로 지정합니다. API 검사는 인증·정합성·파일 검증·ZIP·CLI를, 브라우저 검사는 소유자 등록 흐름과 read-only 화면을 확인합니다. GitHub Actions에서도 실행합니다.

AWS와 Colab T4에서 합성 입력·WikiText 표본의 upload/queue·취소·결과 회수를 확인했습니다. 수신 요약과 사용자 수동 점검 보고를 구분한 [배포 검증 기록](docs/archive/20261023_deployment_validation.md)을 보관합니다. RDS·S3 등 선택 구성의 실제 환경 검증은 사용할 때 따로 수행합니다.

문서는 [목록](docs/README.md)에서 찾을 수 있습니다. 현재 사용법은 `docs/`에서 관리하고 과거 설계·계획·검증 기록은 [아카이브](docs/archive/README.md)에 보존합니다.
