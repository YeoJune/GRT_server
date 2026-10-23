# AWS 배포 후 기능 점검안

> 2026-10-23 배포 점검 당시 기록입니다. 임시 notebook은 정리했으며, 현재 사용법은 [운영 문서](../operations.md)와 [API](../api.md)를 따릅니다.

바로 실행하려면 [실행 가이드](20261023_aws_test_execution_guide.md)와 [임시 테스트 노트북](https://github.com/YeoJune/GRT/blob/345ae41fc47756b832a6e1ad34c12cccdb1e24dd/notebooks/tmp_server_acceptance.ipynb)으로 시작한다. 아래는 빠짐없이 확인하기 위한 기능별 판정표다.

작성: 2026-10-23. 대상: `https://grt.grtserver.cloud`, Amazon Linux 2023 ARM64 / t4g.small / 20GB, SQLite·로컬 파일 저장.

[현재 API](../api.md), [구현 범위](https://github.com/YeoJune/GRT_server/blob/14e6033333110d38b33264d461938d571c78068a/README.md#구현-경계), [GRT 연결 안내](https://github.com/YeoJune/GRT/blob/main/docs/archive/20261022_server_integration.md)를 기준으로 한다. 아래는 **실행 계획이며 통과 기록이 아니다.** 미구현 설계는 성공 기준에 포함하지 않는다.

## 1. 진행 순서

| 순서 | 점검                  | 완료 기준                                       |
| ---- | --------------------- | ----------------------------------------------- |
| 1    | 배포·로그인·권한      | 브라우저와 실행 환경에서 같은 HTTPS 서버에 연결 |
| 2    | 작은 upload 실험      | 학습·전송·서버 검증·다운로드까지 완료           |
| 3    | 큐 실험 2개           | pause/resume·우선순위·순차 실행 확인            |
| 4    | 취소·실패·retry·clone | 안전 중단과 실행 이력 보존                      |
| 5    | 전송·인증·연결 장애   | 중복 실행·거짓 성공·결과 손실 방지              |
| 6    | API·CLI·화면          | 기능표와 자동 검사 결과 확인                    |
| 7    | 재시작·백업 복원      | DB·파일·접수된 작업의 영속성 확인               |
| 8    | 공개 전 판정          | 필수 항목 통과, 조건부 항목의 적용 여부 기록    |

오늘은 1~4부터 진행하고, 첫 실패를 해결한 뒤 다음 단계로 간다. 5~7까지 끝나야 전체 기능 점검 완료다. 전체 시간은 데이터 준비·전체 validation·checkpoint 전송량에 따라 달라지므로 첫 preflight 실측 후 정한다.

## 2. 준비와 배포

- 브라우저, EC2 SSH, Colab 또는 Kaggle GPU, CLI/API 호출 환경을 준비한다. 학습은 외부 GPU에서 수행한다.
- 두 저장소의 실제 commit SHA, GPU 종류·수, world size, prepared 데이터 manifest hash를 기록한다. 큐 제출과 실행기는 같은 코드·데이터를 사용한다.
- 전용 큐 `acceptance-20261023`, run ID/campaign 접두어 `acceptance-20261023-`를 사용한다. 재시험은 새 run ID로 구분하고 기존 결과를 보존한다.
- 테스트용 write/read-only 토큰을 따로 발급한다. 정상 실험용 토큰은 검사 종료까지 유효하게 하고, 폐기·만료 검사는 별도 토큰으로 수행한다.
- 주소는 `https://grt.grtserver.cloud`로 통일한다. `APP_ORIGIN`, notebook, CLI가 일치해야 한다.
- 테스트 전 DB·파일을 일관되게 백업한다. 실행 중 SQLite 파일만 단순 복사하지 않는다. 백업은 인증 정보가 있으므로 비공개로 보관한다.
- 20GB 디스크 여유를 확인하고 작은 모델·파일로 시작한다. 자동 삭제가 없으므로 큰 checkpoint·ZIP을 반복 생성하지 않는다.

| ID  | 실행                                              | 통과 기준                                                     |
| --- | ------------------------------------------------- | ------------------------------------------------------------- |
| D01 | PC와 GPU 실행 환경 각각에서 HTTPS `/healthz` 호출 | 인증서 검증을 켠 상태에서 200, `{"status":"ok"}`              |
| D02 | HTTP 접속, 브라우저 접속, 네 화면 이동·새로고침   | HTTPS 이동, 정적 파일·화면 정상; KST 화면과 UTC API 시각 일치 |
| D03 | `grt`, `caddy` 상태·최근 로그 확인                | active, 반복 재시작·지속 오류 없음                            |
| D04 | 인증 후 `/v1/capabilities` 조회                   | runner·한도·heartbeat·lease·저장 방식 기록, 실제 설정과 일치  |

```bash
curl --fail --show-error https://grt.grtserver.cloud/healthz
sudo systemctl status grt caddy --no-pager
sudo journalctl -u grt -u caddy --since "10 minutes ago" --no-pager
df -h /home/ec2-user/GRT_server
```

## 3. 인증·권한

계정 전체에 영향을 주는 A07은 마지막에 진행한다. 비밀번호·토큰·쿠키·lease·서명 URL 원문은 공유 기록에 넣지 않는다.

| ID  | 실행                                                                            | 통과 기준                                                                     |
| --- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| A01 | 비밀번호 로그인 → 새로고침 → 로그아웃                                           | 로그인 유지, 로그아웃 후 보호 API 접근 거부                                   |
| A02 | write/read-only 발급 → 목록 → 토큰 로그인                                       | 원문은 발급 직후 한 번만 공개; 목록·감사 로그에 원문·해시 없음                |
| A03 | read-only 조회·실험 검증·다운로드·ZIP 생성과 쓰기 요청                          | 읽기는 허용, 제출·취소·설정 변경·토큰 발급 등은 API에서도 403                 |
| A04 | 테스트 토큰 만료 시각 변경·자연 만료·폐기 후 Bearer와 토큰 브라우저 세션 재요청 | 만료/폐기 반영, 만료·폐기 토큰 재활성화 불가                                  |
| A05 | 쿠키 변경 요청에서 CSRF 누락/오류·다른 Origin 사용                              | 403; 정상 Origin·CSRF 조합은 성공                                             |
| A06 | 오입력·무인증·idle/절대 세션 만료·반복 로그인 실패                              | 인증 오류와 속도 제한 429 확인. 짧은 세션 설정·반복 실패는 격리 환경에서 검사 |
| A07 | 비밀번호 변경·전체 세션 종료·관리 명령 비밀번호 복구                            | 기존 세션 폐기, 새 비밀번호 로그인; API 토큰 폐기는 reset 옵션과 일치         |
| A08 | 플랫폼 Secrets 누락·접근 거부·read-only로 연결                                  | GPU 학습 전에 실패; 다른 secret source로 fallback하지 않음                    |

## 4. 작은 실제 실험

해당 플랫폼 notebook의 `WikiTextRun` 공통 흐름을 사용한다. 빠른 합성 token 검사와 실제 WikiText/GPU 검사를 기록에서 구분한다.

| 조건     | 첫 실험 권장값                                                                |
| -------- | ----------------------------------------------------------------------------- |
| 모델     | `models=('grt',)`, `size='tiny'`, `world_size=1`                              |
| 예산     | `budget='smoke'`, `steps=20`, `benchmark_steps=2`                             |
| 배치     | 테스트 override: microbatch 1, accumulation 1, global batch 1, auto-batch off |
| 입력     | WikiText-103 GPT-2 BPE, segment length 32, 별도 테스트 run                    |
| 평가     | 처음에는 posthoc·W&B·최종 test off; validation 비용은 preflight로 확인        |
| 연결     | `server_mode='upload'`, 실제 URL, 플랫폼 secret source, 전용 큐               |
| deadline | 실제 UTC 세션 종료 시각; preflight·평가·전송 여유 포함                        |

학습 step만 줄여도 전체 validation·데이터 준비 시간이 줄지는 않는다. 데이터를 축소한다면 별도 prepared 경로·manifest로 고정하고 축소 데이터임을 명시한다. 원래 연구 데이터·Config를 덮어쓰지 않는다. 이 loss는 연구 성능 비교에 쓰지 않는다.

| ID  | 실행                                                 | 통과 기준                                                                     |
| --- | ---------------------------------------------------- | ----------------------------------------------------------------------------- |
| R01 | `off`로 작은 실험 실행                               | 서버·secret 없이 기존 학습·로컬 저장, 서버 job 생성 없음                      |
| R02 | `upload`: setup → prepare_data → preflight           | 인증 확인, worker·attached job 등록; 큐 claim 대상에 들어가지 않음            |
| R03 | train 중 GUI/API 관찰                                | training·heartbeat·진행 step 갱신, Config/provenance 보존                     |
| R04 | train 후 `report(posthoc=False)`                     | 업로드·검증 후 succeeded, target step 충족; 프로세스 종료만으로 성공하지 않음 |
| R05 | report·Config·provenance·로그·checkpoint 다운로드    | 원본 bytes·크기·SHA256 일치; checkpoint 로컬 복원 확인                        |
| R06 | 같은 run에서 report·완료된 train 셀 재실행           | 성공 결과 재사용, 재학습·불필요한 job/attempt·동일 파일 중복 없음             |
| R07 | 별도 run에서 작은 GRT posthoc 포함                   | 분석 결과·ZIP 보존; 분석 필수 job은 분석 전 성공 불가                         |
| R08 | NeoX/RMT 각각 upload, 여러 모델을 한 helper에서 선택 | 모델별 job/attempt와 campaign 구분; 다른 모델에서 GRT posthoc 생략            |
| R09 | Colab/Kaggle 각각 정상 경로, W&B on 별도 확인        | 플랫폼 Secret·외부 HTTPS·GPU 실행 확인. 미실행 플랫폼은 미검증으로 기록       |
| R10 | 5분 이상 실행하는 전용 실험                          | 최종 저장과 별개로 중간 checkpoint가 검증되어 보관됨                          |

강제 런타임 삭제 시 아직 전송되지 않은 파일의 보존은 보장 항목이 아니다. Colab과 Kaggle을 모두 검증했다고 공개하려면 두 플랫폼에서 실제 실행해야 한다.

## 5. 큐·등록·실행기 제어

큐 JSON은 GRT의 `job.server_job(...)`로 생성해 GUI/CLI로 제출한다. 임의 예제 Config를 실제 GRT worker에 전달하지 않는다. 동일한 코드·소스 hash·데이터 manifest·world size를 사용한다.

| ID  | 실행                                                                                         | 통과 기준                                                                      |
| --- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Q01 | 큐 생성·schema 등록/조회·동일 ID의 다른 schema 등록                                          | schema 불변; 변경은 새 ID로 등록                                               |
| Q02 | 정상 spec·타입 오류·core 오타·target_steps 누락/0 검증                                       | 정상 default 해소, 오류는 422와 field_errors                                   |
| Q03 | 허용된 spec 확장 필드·extensions·labels 저장/재조회                                          | 내용 보존, 제출 후 spec 변경 불가                                              |
| Q04 | 정상 batch와 1개 오류 batch, 50개 초과 제출                                                  | 전체 등록 또는 전체 rollback, 개수 제한 적용                                   |
| Q05 | 2개 job 제출, queued 큐 이동·우선순위 변경                                                   | 높은 우선순위의 호환 job부터 배정; running 변경 거부                           |
| Q06 | pause → claim → resume, 빈 큐 claim                                                          | pause/빈 큐는 204와 Retry-After; resume 후 배정. 종료한 GRT worker는 다시 실행 |
| Q07 | 실행 중 drain → 완료 → resume                                                                | 현재 작업 취소 없이 신규 claim 차단; resume 후 배정 가능                       |
| Q08 | worker 순차 실행과 `--once`                                                                  | 순차 작업 중첩 없음, once는 1개만 처리                                         |
| Q09 | 두 worker 동시 claim, 바쁜 worker 추가 claim                                                 | 같은 job 중복 배정 없음, 바쁜 worker 추가 claim은 409                          |
| Q10 | runner/schema/GPU/label/world size 불일치, deadline·토큰 수명 부족, ETA 미상·checkpoint 불가 | queued 미배정, attached 검증 오류; 실행 가능 조건만 통과                       |
| Q11 | 동일 session_key 재등록                                                                      | worker ID 유지, active attempt 조회 가능, lease 원문 재공개 없음               |
| Q12 | 다른 코드·manifest·world size로 GRT 큐 실행                                                  | 학습 전 거부; notebook 조건으로 불변 spec을 덮어쓰지 않음                      |
| Q13 | queued 취소, failed/interrupted/cancelled retry, clone·overrides                             | 취소 즉시 반영; retry는 새 attempt, clone은 새 job; 원본 spec·이력 보존        |

## 6. 취소·장애·중복 방지

전용 테스트 job으로 수행한다. 서버 중단·유실 응답·잘못된 완료 증거는 격리 환경에서 먼저 검사한다.

| ID  | 실행                                                      | 통과 기준                                                                                   |
| --- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| F01 | 실행 중 취소                                              | 먼저 cancel_requested, heartbeat 후 update 경계에서 저장·중단; succeeded로 오인하지 않음    |
| F02 | 연결 끊긴 worker의 job 취소                               | 외부 프로세스를 종료했다고 표시하지 않음; 종료 확인 전 재실행 금지                          |
| F03 | worker 실제 종료 → lease 만료 → 근거와 stale retry        | 근거 없는 retry 거부; 새 generation/attempt. 기본 약 180초 lease는 capabilities로 확인      |
| F04 | 구 lease/generation의 heartbeat·finish·출력 업로드        | 구세대 변경 거부, 새 실행 보호                                                              |
| F05 | 전용 토큰 폐기/만료 중 학습                               | 다음 인증 검사 후 로컬 저장·안전 중단, 신규 claim/쓰기 차단; 서버 즉시 종료를 가정하지 않음 |
| F06 | 같은 run·원 lease/journal로 새 토큰 재연결                | 소유권·Config 확인 후 동기화, job 중복 없음; lease 없는 프로세스에 실행 권한 복제 금지      |
| F07 | 짧은 서버 연결 단절·업로드 응답 유실 후 복구              | 기존 예약 확인·전송 재시도; 재학습·중복 제출 없음                                           |
| F08 | 약 10분 이상 단절 또는 attempt deadline 도달              | update 경계 저장·중단; 동기화 전 성공 표시 없음                                             |
| F09 | posthoc 실패 후 같은 유효 lease에서 분석 재시도           | 학습 결과 먼저 보존, phase_error 표시, 재학습 없이 분석·전송 재시도                         |
| F10 | W&B 연결/후처리 오류                                      | 원본 결과·가능한 파일 보존; W&B 오류와 학습 실패 구분                                       |
| F11 | 같은 Idempotency-Key+본문, 다른 본문, 토큰 교체 후 재요청 | 기존 결과 재사용, 본문 충돌 409, 토큰 교체로 새 작업 생성 없음                              |
| F12 | 응답 유실 후 `/requests/{client_request_id}`              | 접수 추적 가능, 토큰·lease·서명 URL 재생 없음; lease 유실은 종료 확인 후 retry              |

서버 retry는 fresh 실행이다. 서버 checkpoint 자동 다운로드·학습 복원과 혼동하지 않는다. 로컬 checkpoint 재개는 기존 GRT의 Config·manifest·world size 일치 계약으로 별도 확인한다.

## 7. 파일·완료 검증·결과 수집

잘못된 입력은 작은 합성 generic job/파일로 검사하고 연구 원본을 변조하지 않는다.

| ID  | 실행                                                                       | 통과 기준                                                                       |
| --- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| B01 | 예약 → 원본 PUT → complete → poll                                          | 실제 크기·SHA256 확인 후 verified; 서명 URL PUT에 Bearer 없음                   |
| B02 | 크기/해시 불일치·허용 크기 초과·경로형 파일명                              | 거부/검증 실패; 잘못된 파일 verified 불가                                       |
| B03 | 동일 대상에 다른 bytes 쓰기, upload ID로 URL 갱신                          | 원본 덮어쓰기 불가, 예약·파일 identity 유지                                     |
| B04 | 필수 파일 누락·hash 불일치·step 부족·잘못된 report·필수 posthoc 미완료     | finish 접수 202와 검증 성공 구분, succeeded 불가                                |
| B05 | 정상 finish 이후 heartbeat·finish 재요청                                   | finalizing/완료가 running으로 되돌아가지 않음; 정상 중복 재사용                 |
| B06 | 공유 dataset 업로드, 타 attempt 출력·미검증 checkpoint 참조                | dataset은 job 없이 등록 가능; 출력 소유·checkpoint 검증 상태 제약 적용          |
| B07 | 개별 다운로드 → hash 비교 → URL 만료 후 재사용                             | 원본 일치, 자체 만료 후 차단. 토큰 폐기와 기발급 URL 만료는 구분                |
| B08 | 여러 job/파일 ZIP → preparing/ready → 다운로드                             | 선택한 verified 파일 포함, 추출 후 hash 일치; 실패 이유 조회 가능               |
| B09 | 결과 화면 성공/부분 결과·campaign 필터·상세                                | 실패·부분 결과 보존/다운로드, 성공과 구분                                       |
| B10 | cursor pagination, queue/status/campaign 필터                              | 누락·중복 없이 다음 페이지, 필터 일치                                           |
| B11 | CLI me/validate/submit/list/clone/retry/pause/drain/export/requests/tokens | GUI와 같은 계약; 오류를 성공으로 출력하지 않음, 토큰 명령행·출력 파일 노출 없음 |
| B12 | CLI `results collect --new` 반복, 수집 파일 변경 후 재수집                 | 일치 파일만 건너뜀, 손상 재검증, 이름 충돌 방지, metadata 보존                  |

## 8. 설정·운영·복구

| ID  | 실행                                                         | 통과 기준                                                                                        |
| --- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| O01 | 최대 실행 시간·전송 여유 변경 후 신규 job                    | 새 작업에 적용, 기존 불변 job에 소급 없음; 운영값 복원                                           |
| O02 | 감사 로그·브라우저 저장소·서버/worker 로그·결과·journal 확인 | 주요 변경 추적, 토큰·쿠키·서명 URL 노출 없음; journal 0600. journal에는 lease가 있어 비공개 유지 |
| O03 | 유휴 grt/Caddy 재시작 → 로그인·이전 파일 조회                | DB·파일·HTTPS 복구, 이전 파일 hash 일치                                                          |
| O04 | 격리 서버의 verifying/finalizing/ZIP preparing 중 재시작     | 접수 작업 재처리, 중복 실행·완료 증거 손실 없음                                                  |
| O05 | CPU·메모리·디스크, worker 2개·작은 파일 병렬 전송 관찰       | OOM·지속 오류·디스크 고갈 없음, 측정값 기록; checkpoint 크기와 서버 한도 비교                    |
| O06 | 서버 정지 후 DB+파일 백업 → 별도 경로/인스턴스 복원          | 같은 signing key 등 필수 비공개 설정 제공; 이력·인증·파일 hash 일치                              |
| O07 | 복구 절차 확인 후 EC2 재부팅                                 | 두 서비스 자동 시작, DNS·HTTPS·로그인·다운로드 정상                                              |

운영 DB 직접 SQL 변경·원본 삭제로 테스트 상태를 만들지 않는다. 자동 보관 삭제는 없으며 테스트 데이터 정리는 별도 관리 작업으로 결정한다. 복구에 필요한 서비스·프록시 설정과 비밀값의 안전한 보관 위치도 기록한다.

### 자동 검사와 실제 환경 검사

API/브라우저 검사는 임시 DB·파일/서버를 사용한다. 운영 build 변경과 자원 경쟁을 피하도록 개발 checkout/CI에서 수행한다.

```bash
# GRT_server 개발 checkout / CI
npm run check
npm test
npm run build
npm run test:e2e

# GRT 개발 checkout; 서버 checkout에는 npm ci 필요
GRT_TEST_SERVER_REPO=/path/to/GRT_server python -m pytest tests/test_server.py -q
```

Node/Python 의존성과 Playwright Chromium을 먼저 준비한다. 통합 검사 skip은 통과가 아니다. 로컬 자동 검사는 실제 AWS 도메인·ARM64·플랫폼 Secrets·GPU·백업 복원을 증명하지 않으므로 실제 환경 결과를 함께 남긴다.

## 9. 조건부 구성과 미지원 경계

| 항목                                               | 판정                                                                                                            |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| S3                                                 | local이면 해당 없음. 사용 시 비공개·암호화·versioning·IAM·VersionId 고정·hash·서명 URL·ZIP을 실제 S3에서 재검사 |
| PostgreSQL/RDS                                     | SQLite면 해당 없음. 사용 시 TLS·migration·동시 claim·영속성·백업/복원 재검사; 자동 데이터 이전 없음             |
| Vast 검색                                          | 키 미설정이면 503, 설정 시 검색만 확인                                                                          |
| 유료 임대·start/stop/destroy·enroll                | write 요청 501, allocations enabled:false; 유료 자원 생성 없음                                                  |
| `grt/1`                                            | 422가 정상. 현재 GRT 연결은 generic/1이며 과학적 완료 판정과 구분                                               |
| checkpoint 자동 복원·자동 보관 삭제·독립 과금 감시 | 미지원으로 공개 설명에 명시                                                                                     |
| DDP                                                | 사용 시 별도 2-GPU 큐 실험·checkpoint·중단 검사. 단일 GPU 결과로 보장하지 않음                                  |

## 10. 기록과 공개 전 판정

각 ID를 `통과 / 실패 / 미실행 / 해당 없음`으로 기록한다. 로컬 자동 검사와 실제 AWS/플랫폼 결과를 따로 표시한다.

| 기록 항목                              | 값  |
| -------------------------------------- | --- |
| 검사 ID·UTC 시각·판정                  |     |
| 서버/GRT commit·플랫폼·GPU·world size  |     |
| job_id·attempt_id·worker_id·request_id |     |
| manifest·spec/config SHA256            |     |
| 예상 동작 / 실제 동작                  |     |
| 비밀값 제거한 오류·로그·파일 hash      |     |
| 실패 원인·수정·재검사 ID               |     |

2~8절은 필수 점검이다. 공개 전 정상 upload·queue·회수, 권한 차단, 취소·retry·구세대 차단, 중복 방지, 완료 검증, 재시작·백업 복원을 확인한다. 데이터 손실·중복 학습·권한 우회·거짓 성공은 해결 후 재검사한다. 미실행 항목을 통과로 처리하지 않는다.

README에 공개하는 환경·기능을 검증 기록과 일치시킨다. 사용하지 않는 선택 구성·미지원 기능은 범위 밖으로 명시한다. 마지막으로 테스트 토큰을 폐기하고 큐·정책을 운영 상태로 돌린다.
