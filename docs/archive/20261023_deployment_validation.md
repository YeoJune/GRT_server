# 2026-10-23 배포 검증 기록

AWS의 `https://grt.grtserver.cloud`와 Colab Tesla T4 1개(world size 1)를 연결한 기능 점검 결과다. 서버는 Amazon Linux 2023 ARM64 EC2, SQLite·로컬 파일 저장 구성이며 GRT checkout은 `345ae41fc47756b832a6e1ad34c12cccdb1e24dd`였다. 아래 결과는 사용자가 전달한 `acceptance_summary.json` 두 개를 확인해 기록했다. 원본 요약에 서버 commit은 포함되지 않았다.

## 수신한 자동 판정

| 입력          | 시험 ID                             | 요약 시각(UTC) | 판정      | 작업 상태             | 취소 checkpoint |
| ------------- | ----------------------------------- | -------------- | --------- | --------------------- | --------------- |
| 합성 token    | `acceptance-20261023T080428-0a4d07` | 08:12:24       | 12개 PASS | 성공 5, 의도한 취소 2 | 128 step        |
| WikiText 표본 | `acceptance-20261023T081958-3e5509` | 08:28:30       | 12개 PASS | 성공 5, 의도한 취소 2 | 88 step         |

두 시험 모두 다음을 확인했다.

- 실제 작은 학습의 upload와 서버 완료 검증
- verified 파일 9개의 원본 hash·ZIP 비교와 report 재호출 중복 방지
- posthoc 실패 후 재학습 없이 분석 재시도
- 큐 batch·pause·우선순위·drain/resume, 복제·queued 취소·retry
- 실제 실행 취소와 checkpoint 보존
- 잘못된 spec·원자적 batch·Idempotency-Key 충돌 검증
- read-only·쿠키 CSRF·토큰 폐기 반영, 잘못된 파일 SHA256 거부

각 시험의 7개 job은 요약 시점에 성공 또는 취소 상태였다. 합성 token과 축소 WikiText 입력의 기능 검증이며 전체 WikiText 학습 품질·수렴 검증은 아니다.

## 사용자 수동 점검 보고

사용자는 이후 나머지 테스트도 완료했다고 보고했다. 개별 수동 점검의 로그·환경별 추가 요약은 전달되지 않았으므로, 위 자동 판정과 별도의 사용자 완료 보고로 기록한다. 이 보고를 실제 RDS/S3·Vast 유료 임대·DDP 검증 증거로 확대하지 않는다.

## 검증 중 수정

ZIP을 OS 임시 디렉터리에서 artifact 저장소로 hard link할 때 파일시스템이 다르면 `EXDEV`로 실패하는 경로를 재현했다. 서버 `14e6033`에서 저장소 내부에 복사 완료 후 원자적으로 확정하도록 수정했다. 서로 다른 파일시스템에서 원본 보존·덮어쓰기 거부·임시 파일 정리, 서버 21개 테스트와 기본 notebook 전체 검사를 통과했고, 이후 수신한 두 GPU 요약에서도 ZIP 단계가 PASS였다.

임시 notebook과 실행 보조 코드는 마무리 과정에서 제거했다. 당시 notebook은 [GRT Git 이력](https://github.com/YeoJune/GRT/blob/345ae41fc47756b832a6e1ad34c12cccdb1e24dd/notebooks/tmp_server_acceptance.ipynb)에 있으며 현재 사용법은 [운영](../operations.md)과 [GRT 서버 연결](https://github.com/YeoJune/GRT/blob/main/docs/server.md)에 유지한다. 인증·실행 정합성·원본 보존을 지키는 회귀 테스트는 유지한다.
