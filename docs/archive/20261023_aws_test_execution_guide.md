# AWS 기능 테스트 실행 가이드

> 2026-10-23 배포 점검 당시 기록입니다. 임시 notebook은 정리했으며, 현재 사용법은 [운영 문서](../operations.md)와 [API](../api.md)를 따릅니다.

대상: **https://grt.grtserver.cloud**. 먼저 아래 기본 코스를 실행하고, 마지막의 수동·장애 검사로 이어간다. 세부 점검 ID와 판정표는 [전체 점검안](20261023_aws_acceptance_test_plan.md)에 있다. 이 문서는 실행 안내이며 실제 환경의 통과 기록이 아니다.

작성 시 임시 Express·SQLite 서버와 CPU로 기본 코스의 12개 자동 판정, 실제 WikiText 표본의 GRT upload와 off·NeoX·RMT 추가 실행을 검증했다. AWS·GPU·플랫폼 Secret 검증은 아래 절차로 별도 수행한다. notebook에는 실행 출력이나 비밀값을 저장하지 않는다.

## 1. 브라우저에서 준비 — 한 번만

1. 서버에 비밀번호로 로그인한다.
2. **설정 → API 토큰**에서 `acceptance-notebook`이라는 **write** 토큰을 발급한다. 테스트가 끝날 때까지 유효하게 한다.
3. Colab 왼쪽 열쇠(Secrets) 또는 Kaggle Add-ons → Secrets에 **`GRT_SERVER_TOKEN`**으로 등록하고 notebook 접근을 켠다. 토큰을 코드 셀에 붙여 넣지 않는다.
4. [임시 테스트 노트북](https://github.com/YeoJune/GRT/blob/345ae41fc47756b832a6e1ad34c12cccdb1e24dd/notebooks/tmp_server_acceptance.ipynb)을 연다. [Colab 바로 실행](https://colab.research.google.com/github/YeoJune/GRT/blob/345ae41fc47756b832a6e1ad34c12cccdb1e24dd/notebooks/tmp_server_acceptance.ipynb). Kaggle은 GitHub에서 notebook을 가져오고 Internet·GPU를 켠다.
5. Colab/Kaggle의 GPU 런타임을 선택한다. 이 테스트는 GPU 1개만 사용한다.

실험용 토큰은 write이므로 서버 전체 변경 권한이 있다. 개인 테스트 notebook에서 사용하고, 점검이 끝나면 서버에서 폐기한다.

## 2. EC2·PC에서 연결 확인

PC 또는 EC2 터미널에서:

```bash
curl --fail --show-error https://grt.grtserver.cloud/healthz
```

`{"status":"ok"}`면 다음으로 간다. EC2에서는 서비스도 확인한다.

```bash
sudo systemctl status grt caddy --no-pager
df -h /home/ec2-user/GRT_server
```

두 서비스가 active이고 디스크에 여유가 있어야 한다. 자동 삭제가 없으므로 큰 연구 checkpoint 대신 작은 기본 테스트를 먼저 실행한다.

## 3. notebook 설정 — 기본값으로 시작

처음에는 설정을 바꾸지 않아도 된다.

```python
server_url = 'https://grt.grtserver.cloud'
data_mode = 'synthetic'
run_posthoc = True
run_cancel = True
session_minutes = 60
```

`session_minutes`만 실제 남은 런타임 시간 이내로 맞춘다. 연결 deadline은 설정 셀을 실행할 때 한 번 정해지며 자동 연장하지 않는다. **설정 셀 재실행은 새 시험**이므로 실행 중에는 재실행하지 않는다.

기본 데이터는 다운로드 없는 합성 token이다. 실제 작은 GRT/RMT 모델을 학습하지만, 학습 품질을 검증하는 연구 실험은 아니다. 모델·배치는 이 시험에만 축소하며 원래 연구 조건은 변경하지 않는다. 첫 설치를 제외하면 짧은 학습들로 구성되고, 취소 단계는 heartbeat 간격과 저장 시간을 추가로 기다린다.

T4 약 16GB를 기준으로 microbatch 1 × accumulation 1 × GPU 1을 사용한다. 이 GRT 설정의 파라미터는 합성 입력 약 1.9만 개, WikiText 표본 약 162만 개다. FP32 파라미터·gradient·Adam 상태 합계는 각각 약 0.3MiB / 24.8MiB이며 activation·임시 버퍼·CUDA context는 별도다. 실제 메모리는 notebook preflight의 peak/reserved 출력으로 확인한다.

## 4. notebook 위에서부터 실행

처음에는 한 셀씩 실행한다. 각 단계 끝의 `PASS`를 보고 다음으로 간다. 기본 코스는 전용 큐와 시험 이름을 만들며 기존 연구 job을 조작하지 않는다.

| notebook 단계          | 실행 후 확인                                                          | 대응 점검             |
| ---------------------- | --------------------------------------------------------------------- | --------------------- |
| 1. 코드·연결           | write 권한·만료·GRT commit 출력, 토큰 원문 없음                       | D04, A08              |
| 2. 작은 입력           | 독립 prepared 데이터와 manifest SHA256                                | 재현 조건             |
| 3. 정상 upload         | 실제 2-step GRT 학습 후 서버 succeeded                                | R02~R04               |
| 4. 다운로드·ZIP·재호출 | 파일 hash 일치, ZIP 정상, attempt/파일 중복 없음                      | R05~R06, B07~B08      |
| 5. posthoc             | 의도한 window 오류 뒤 원 학습 결과 보존, 분석만 재시도해 성공         | R07, F09              |
| 6. 큐                  | batch 2개, pause 중 미배정, 높은 우선순위 우선, drain/resume          | Q04~Q08               |
| 7. clone·retry         | 원 job 유지, 복제 job 취소·retry 후 성공                              | Q13                   |
| 8. 실제 취소           | 첫 셀에서 학습 시작, 다음 셀에서 취소·checkpoint 보존 확인            | F01                   |
| 9. API 오류            | 잘못된 spec/batch 거부, 같은 요청 중복 방지, read-only·CSRF·폐기 반영 | A03~A05, Q02/Q04, F11 |
| 10. 잘못된 파일        | 틀린 SHA256 파일이 verified가 되지 않음                               | B02                   |
| 11. 결과 요약          | `acceptance_summary.json` 생성·다운로드                               | 결과 공유             |

posthoc 단계의 첫 오류는 의도한 것이다. **뒤의 올바른 옵션 재시도와 PASS까지** 확인한다. 취소 단계도 학습 예외 자체가 통과 기준은 아니며, 최종 cancelled와 저장된 checkpoint까지 확인한다.

기본 코스를 실행하면 임시 read-only 토큰은 바로 폐기한다. 최초에 브라우저에서 발급한 notebook write 토큰은 플랫폼·추가 검사를 끝낸 뒤 폐기한다.

### ZIP 단계에서만 실패했을 때

학습과 개별 파일 전송이 끝났는데 ZIP이 실패하면 재학습하지 않는다. 서버가 `/tmp`와 artifact 디렉터리 사이를 하드링크하던 이전 버전은 두 경로의 파일시스템이 다르면 `EXDEV`로 실패할 수 있다. 수정 버전은 저장소 내부에 완전히 복사한 뒤 원자적으로 공개한다.

EC2에서 최신 서버를 반영한다.

```bash
cd /home/ec2-user/GRT_server
git pull --ff-only origin main
npm run build
sudo systemctl restart grt
curl --fail --show-error https://grt.grtserver.cloud/healthz
```

기존 Colab 런타임과 변수를 유지하고 **새 코드 셀에 아래만 실행**한다. Colab의 GRT checkout을 중간에 갱신하거나 설정·학습을 다시 실행하지 않는다. 실패한 요청의 동일 Idempotency-Key를 재사용하면 과거 응답을 받을 수 있으므로 새 key를 사용한다.

```python
export = client.request('POST', '/exports', {'job_ids': [upload_job['id']]}, key=uuid4().hex)
export = wait_for(lambda: client.request('GET', '/exports/' + export['id']),
                  lambda item: item['status'] != 'preparing')
if export['status'] != 'ready':
    raise RuntimeError(f"ZIP 실패: {export['id']} / {(export.get('error') or {}).get('code')}")
archive = collected / 'results.zip'
archive.write_bytes(transfer('GET', export['download']['url']).content)
from zipfile import ZipFile
with ZipFile(archive) as bundle:
    assert bundle.testzip() is None
    zip_digests = {hashlib.sha256(bundle.read(name)).hexdigest()
                   for name in bundle.namelist() if not name.endswith('/')}
assert {item['sha256'] for item in verified} <= zip_digests
record('download_zip_repeat', job_id=upload_job['id'], verified_files=len(verified))
```

PASS가 나오면 기존 notebook의 다음 posthoc 단계로 이어간다. 실패하면 위에서 표시한 export ID와 오류 코드만 공유한다. 서명 URL은 공유하지 않는다.

## 5. 브라우저에서 함께 확인

notebook의 출력에 있는 시험 이름으로 필터링한다.

1. **실험**: upload job 상세의 불변 설정·실행 이력·파일을 연다. queued 취소와 running 취소의 표시가 다른지 확인한다.
2. **큐·실행기**: 전용 큐, heartbeat, pause/resume과 drain 상태를 확인한다. 첫 큐 작업은 우선순위가 높은 작업이어야 한다.
3. **결과**: 성공 결과를 보고 **실패·부분 결과 포함**도 켠다. 취소한 작업의 보존 파일을 확인하고, 파일 1개와 결과 ZIP을 브라우저에서도 내려받는다.
4. **설정**: 토큰 목록에 원문이 다시 노출되지 않는지 확인한다.
5. 로그아웃 → 비밀번호 로그인 → 새로고침을 확인한다. read-only 토큰을 추가 발급해 별도 브라우저에서 로그인하면 조회·다운로드가 가능하고 변경 버튼이 비활성화되어야 한다. 검사 후 폐기한다.

시간은 화면 KST와 API UTC가 같은 시점을 나타내는지 확인한다. 마지막에 전체 세션 종료·비밀번호 변경을 수행하고 기존 브라우저 세션이 폐기되는지도 확인한다. 다른 실행 중 실험이 없을 때 진행한다.

## 6. 빠른 추가 검사

### 실제 WikiText·다른 플랫폼

기본 코스가 끝나면 새 시험에서 `data_mode='wikitext_sample'`로 바꿔 실행한다. WikiText-103을 streaming으로 일부 읽고 GPT-2 tokenizer를 사용한다. 별도 manifest·작은 validation으로 전체 데이터 준비/평가 시간을 줄인다. 인터넷과 Hugging Face 연결이 필요하고 실패 시 합성 데이터로 자동 전환하지 않는다.

Colab에서 성공했으면 같은 notebook을 Kaggle에서도 실행한다. 이 두 결과는 플랫폼별로 따로 보관한다. 이 표본 실험 역시 전체 WikiText 연구 성능을 입증하지 않는다.

### off·NeoX/RMT 정상 완료

기본 코스를 마친 notebook에 다음 셀을 추가하고, 그 뒤 **결과 요약** 셀을 다시 실행한다.

```python
for model, mode in [('grt', 'off'), ('neox', 'upload'), ('rmt', 'upload')]:
    run = make_run('extra-' + model + '-' + mode, model=model, mode=mode)
    try:
        run.setup(install=False)
        run.prepare_data(prepared_input=prepared)
        run.preflight()
        run.train()
        run.report(plot=False)
        items = client.request('GET', '/jobs?campaign=' + quote(run.run_dir.name))['data']
        if mode == 'off':
            assert items == []
        else:
            assert len(items) == 1 and detail(items[0]['id'])['status'] == 'succeeded'
            track(items[0])
        record('extra_' + model + '_' + mode)
    finally:
        run.close()
```

W&B on은 [기존 Colab](https://github.com/YeoJune/GRT/blob/main/notebooks/colab.ipynb)/[Kaggle](https://github.com/YeoJune/GRT/blob/main/notebooks/kaggle.ipynb)의 W&B Secret 절차를 사용한다. 연구용 기본 40k를 그대로 실행하지 말고 별도 작은 run으로 조건을 정한다. 중간 주기 checkpoint는 실제 5분 이상 실행한 실험에서 확인한다. 기본 2-step의 마지막 checkpoint는 주기 저장 검사를 대체하지 않는다.

## 7. CLI 확인 — 로컬 PC 또는 EC2

GRT_server checkout에서 입력한다. 토큰 입력은 화면에 표시되지 않는다. notebook 출력의 실제 job ID와 시험 이름을 사용한다.

```bash
cd ~/GRT_server
export GRT_SERVER_URL=https://grt.grtserver.cloud
read -r -s -p '테스트 write 토큰: ' GRT_SERVER_TOKEN
export GRT_SERVER_TOKEN
```

```bash
npm run cli -- me
npm run cli -- jobs list --json
# 아래 값을 이번 시험 출력으로 교체
npm run cli -- results collect --campaign acceptance-YYYYMMDDTHHMMSS-xxxxxx-upload --new --output ./results/acceptance
npm run cli -- results collect --campaign acceptance-YYYYMMDDTHHMMSS-xxxxxx-upload --new --output ./results/acceptance
unset GRT_SERVER_TOKEN
```

두 번째 collect는 hash가 일치하는 파일을 건너뛰어야 한다. 수집한 파일 복사본 하나를 변경한 뒤 재수집하면 손상을 감지하고 다시 가져와야 한다. 원 연구 파일을 변경하지 않는다. token 발급 CLI는 redirect하지 않는다. 나머지 명령은 [API 가이드의 CLI 예제](../api.md#cli)를 따른다.

## 8. 장애·정합성 검사

기본 코스가 PASS여도 아래는 별도로 남는다. **로컬 자동 검사와 AWS 실제 검사 결과를 구분**한다.

### 먼저 개발 checkout/CI에서 자동 검사

운영 서비스와 다른 개발 환경에서 의존성·Playwright Chromium을 설치한 뒤:

```bash
# GRT_server
npm run check
npm test
npm run build
npm run test:e2e
```

```bash
# GRT: GRT_server에 npm ci가 되어 있어야 함
python -m pip install -e '.[dev,wikitext]'
GRT_TEST_SERVER_REPO=/path/to/GRT_server python -m pytest tests/test_server.py -q
```

이는 동시 claim, 구세대 차단, stale retry 종료 근거, 완료 증거 누락, 응답 유실, 토큰 교체 등 오류 주입을 보완한다. 외부 통합 skip을 성공으로 처리하지 않는다.

### AWS에서 짧은 연결 중단

1. notebook의 **실제 취소 → 학습 시작** 셀까지 실행하고 다음 취소 셀은 아직 실행하지 않는다. 전용 RMT job이 실행 중인지 확인한다.
2. EC2에서 아래 명령으로 heartbeat 한 주기보다 길게 단절시킨다. SSH와 학습 런타임은 유지한다. 블록 종료 시 Caddy를 다시 시작한다.

   ```bash
   (
     set -e
     trap 'sudo systemctl start caddy' EXIT
     sudo systemctl stop caddy
     sleep 40
   )
   ```

3. notebook의 취소 셀을 실행한다. 동기화 복구·안전 중단·checkpoint를 확인한다. 새 job/attempt가 생기지 않아야 한다.
4. 10분 이상 단절·토큰 폐기 중 학습·deadline 종료는 각각 **새 전용 run**으로 검사한다. 원래 write 토큰 대신 별도 실험 토큰을 사용한다. heartbeat 후 update 경계 저장·중단이 기대값이다. 인증이 사라진 동안 서버 상태가 즉시 종료될 것으로 기대하지 않는다.

stale retry는 실제 이전 프로세스 종료 확인과 lease 만료 뒤에 수행한다. [점검안 F03~F06](20261023_aws_acceptance_test_plan.md#6-취소장애중복-방지)과 API 계약을 따르며, 종료를 확인하지 않은 상태에서 새 실행을 만들지 않는다. retry는 fresh 실행이고 서버 checkpoint 자동 복원은 미지원이다.

## 9. 운영 재시작·백업 복원

실행 중 실험이 없는 상태에서 EC2에서:

```bash
sudo systemctl restart grt caddy
curl --fail --show-error https://grt.grtserver.cloud/healthz
```

브라우저에서 이전 job·파일을 다시 조회하고 원본 hash를 비교한다. 이어서 비공개 백업을 만든다. 아래는 현재 기본 `data/` 경로를 사용한다.

```bash
(
  set -e
  cd /home/ec2-user/GRT_server
  backup_dir=/home/ec2-user/grt-backups
  mkdir -p "$backup_dir"
  chmod 700 "$backup_dir"
  backup_file="$backup_dir/grt-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
  umask 077
  trap 'sudo systemctl start grt' EXIT
  sudo systemctl stop grt
  tar -czf "$backup_file" data .env
  printf '비공개 백업: %s\n' "$backup_file"
)
```

`.env`가 포함된 비공개 백업이므로 공유하지 않는다. 서비스/Caddy 설정과 코드 commit도 별도로 기록한다. **복원은 운영 폴더를 덮어쓰지 말고 별도 경로/인스턴스에서** 수행한다. 복원본으로 로그인·job 이력·파일 hash를 확인하고, 동일 signing key와 경로 설정도 복구한다. EBS snapshot이나 파일 생성만으로 복원 검사를 통과 처리하지 않는다.

마지막으로 복구 가능한 백업이 있는 상태에서 `sudo reboot` 후 재접속한다. 두 서비스 자동 시작·HTTPS·로그인·기존 파일 다운로드를 확인한다.

## 10. 결과 전달과 정리

- notebook 마지막의 **`acceptance_summary.json`**을 전달한다. 중간 실패 후에도 마지막 셀을 실행해 미실행/실패와 실제 job 상태를 남긴다.
- 실패 시 **단계 이름, 오류 문구, job ID**를 함께 보낸다. `journalctl`은 해당 시각 일부만 공유하고 비밀값을 제거한다.
- 운영/브라우저/CLI 수동 검사는 점검안 ID별로 `통과 / 실패 / 미실행 / 해당 없음`을 별도 기록한다. notebook 요약만으로 모든 기능을 통과 처리하지 않는다.
- queued/running 작업이 남았는지 확인하고, 테스트 토큰 폐기·큐/정책 복원을 마친다. 기존 연구 데이터는 삭제하지 않는다.

S3/RDS/Vast/DDP는 실제 사용 시 별도 환경 검사가 필요하다. 유료 GPU 임대·자동 checkpoint 복원·자동 삭제·`grt/1` 과학적 완료 검증은 현재 미지원이다.
