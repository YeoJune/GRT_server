# 환경별 사용 가이드

서버 주소는 `https://grt.grtserver.cloud`입니다. 학습 코드는 [GRT](https://github.com/YeoJune/GRT), 관리 CLI는 이 저장소에 있습니다. 서버는 실험·큐·파일을 관리하며 Colab/Kaggle 세션이나 GPU를 직접 시작하지 않습니다.

## 사용 유형 선택

| 목적                                 | 실행 위치·모드                  | 순서                                    |
| ------------------------------------ | ------------------------------- | --------------------------------------- |
| 노트북에서 조건을 정하고 바로 학습   | Colab/Kaggle · `upload`         | 노트북 실행 → 상태·결과 자동 저장       |
| 제출한 실험을 다른 GPU에서 순차 실행 | Colab/Kaggle/데스크톱 · `queue` | 제출 → 직접 GPU 세션 연결 → worker 실행 |
| 서버 없이 학습                       | 모든 환경 · `off`               | 기존 로컬 흐름 유지                     |
| 진행 확인·다운로드·결과 분석         | 웹 또는 데스크톱 CLI            | 읽기 전용 토큰으로 조회·수집            |

학습·제출·관리는 write 토큰이 필요합니다. 다운로드 전용 환경에는 read-only 토큰을 발급하세요. 토큰은 코드·JSON·명령 인자·출력에 넣지 않습니다.

## Colab / Kaggle: 기존 노트북 결과 저장

1. 서버 설정 화면에서 write 토큰을 발급합니다. Colab의 Secrets 또는 Kaggle의 Add-ons → Secrets에 `GRT_SERVER_TOKEN`을 등록하고 노트북 접근을 허용합니다. Kaggle은 Internet을 켭니다.
2. GRT의 [Colab](https://github.com/YeoJune/GRT/blob/main/notebooks/colab.ipynb) 또는 [Kaggle](https://github.com/YeoJune/GRT/blob/main/notebooks/kaggle.ipynb) 노트북에서 서버 연결 셀을 설정합니다.

```python
server_mode = 'upload'
server_url = 'https://grt.grtserver.cloud'
server_deadline = '<실제 세션 종료 시각: UTC ISO8601>'
```

3. 기존 `setup → prepare_data → preflight → train → report` 셀을 실행합니다. 노트북이 해당 플랫폼의 secret reader를 사용합니다. 마지막 `report()`까지 실행해야 전송·완료 검증이 끝납니다.
4. 웹에서 상태가 `succeeded`인지 확인하고 원본 결과를 받습니다. 통신 실패라면 같은 run에서 `report()`만 다시 실행합니다.

기본 `off`는 서버에 연결하지 않습니다. W&B를 켠 조건에는 별도의 `WANDB_API_KEY`도 필요합니다. Remember 실행은 현재 이 WikiText 서버 연결 대상이 아닙니다.

## 큐: 실험 제출

먼저 GRT 노트북에서 코드 버전·모델·데이터·예산·world size를 정하고 `job.setup()`과 `job.prepare_data()`까지 실행합니다. 학습 셀 대신 아래를 실행하세요. 이 예는 사후 분석 없는 grt 한 작업이며, 모델은 `job.models`에 포함되어야 합니다.

```python
import json
from pathlib import Path
from uuid import uuid4
from grt.utils.server import ServerClient

# Colab은 'colab', Kaggle은 'kaggle', 데스크톱은 'env'
client = ServerClient('https://grt.grtserver.cloud', secret_source='colab')
client.check()
client.ensure_schema()
client.ensure_queue(job.server_queue)
body = job.server_job('grt', posthoc_options=None)
Path('experiment.json').write_text(json.dumps(body, ensure_ascii=False, indent=2))
client.request('POST', '/jobs/validate', body)
request_id = uuid4().hex  # 응답 유실 시 이 키와 body를 그대로 재사용
submitted = client.request('POST', '/jobs', body, key=request_id)
print(submitted['id'])
```

제출 JSON을 내려받아 웹의 신규 실험에 붙여 넣거나 `npm run cli -- jobs validate experiment.json`, `jobs submit experiment.json`을 사용해도 됩니다. 같은 실험을 양쪽에서 중복 제출하지 마세요. Campaign은 제출 JSON의 `labels.campaign`으로 묶습니다.

Worker에는 제출 당시와 같은 full commit·소스 파일, prepared 데이터 manifest가 필요합니다. 제출 후 코드·데이터를 바꿔서 호환되지 않으면 배정되지 않습니다. 예제 worker는 GPU 1개·world size 1입니다. 2 GPU 실험은 제출 조건과 worker의 world size를 모두 2로 맞춥니다. 불변 학습 조건을 worker에서 덮어쓰지 않습니다.

## Colab / Kaggle: 큐 worker

GRT 노트북의 저장소 준비·의존성 설치·데이터 준비 셀을 먼저 실행합니다. 준비한 데이터 경로는 `job.prepared_dir`입니다. 일반 학습 셀 대신 아래 셀을 실행합니다. `runtime`은 해당 플랫폼으로 선택하세요.

```python
import os
import subprocess
import sys

runtime = 'colab'  # Kaggle에서는 'kaggle'
if runtime == 'colab':
    from google.colab import userdata
    token = userdata.get('GRT_SERVER_TOKEN')
else:
    from kaggle_secrets import UserSecretsClient
    token = UserSecretsClient().get_secret('GRT_SERVER_TOKEN')
worker_env = dict(os.environ, GRT_SERVER_URL='https://grt.grtserver.cloud',
                  GRT_SERVER_TOKEN=token)
del token
try:
    subprocess.run([
        sys.executable, str(job.repo_dir / 'scripts/server_worker.py'),
        '--work-dir', str(job.work_dir / 'queue'),
        '--prepared-dir', str(job.prepared_dir),
        '--deadline', '<실제 UTC ISO8601 종료 시각>',
        '--runtime', runtime, '--secret-source', 'env',
        '--queue', job.server_queue, '--device', 'cuda', '--world-size', '1',
    ], env=worker_env, check=True)
finally:
    del worker_env
```

Secret은 부모 노트북에서 읽어 자식 프로세스의 환경으로만 전달합니다. W&B 사용 작업이면 같은 방식으로 해당 플랫폼의 `WANDB_API_KEY`를 `worker_env`에 추가하세요. 한 실험만 실행하려면 인자에 `--once`를 추가합니다. 큐가 비었거나 pause/drain·호환 조건 때문에 배정할 작업이 없으면 worker는 종료하므로 새 작업 제출 후 다시 실행합니다. Deadline은 실제 세션 상한이며 자동 연장하지 않습니다.

## Prepared 데이터 캐시 선택

기존 로컬 데이터 재사용이 기본입니다. GRT에서 `job.prepare_data()` 후 `cached = job.cache_prepared()`를 한 번 실행하면 서버에 공유 dataset ZIP을 보관합니다. `cached['extensions']['manifest_sha256']`가 캐시 ID이며 같은 manifest·파일 hash는 재사용합니다. 다른 세션에서는 `job.prepare_data(server_cache='<manifest SHA256>')`로 명시적으로 다운로드할 수 있습니다. 노트북 준비 셀에도 다운로드 hash와 서버 보관 옵션이 있습니다.

큐 worker는 위 예제의 `--prepared-dir <경로>` 대신 `--prepared-from-server`를 선택하세요. 작업의 dataset_sha256으로 조회하며 로컬 파일이 이미 검증되어 있으면 다시 받지 않습니다. 캐시가 없거나 hash가 다르면 실행하지 않습니다. 모델·예산만 달라진 실험은 같은 데이터를 재사용합니다.

캐시는 실험 삭제와 별개로 보존하며 자동 만료하지 않습니다. 기본 파일 한도는 1GiB이므로 큰 데이터에는 MAX_ARTIFACT_BYTES와 디스크 여유를 확인하세요. 토큰·연결 journal·학습 결과를 데이터 ZIP에 넣지 않고 manifest가 지정한 파일만 보관합니다.

## 데스크톱: 큐 worker

Linux/WSL의 CUDA 환경을 기준으로 합니다. 제출한 commit의 GRT checkout과 동일한 prepared 데이터를 준비합니다. 데이터 생성은 GRT 노트북 또는 [workflow](https://github.com/YeoJune/GRT/blob/main/docs/workflow.md)를 따릅니다.

```bash
cd /path/to/GRT
python -m pip install -e '.[wandb,wikitext]'
export GRT_SERVER_URL=https://grt.grtserver.cloud
read -rs -p 'GRT write token: ' GRT_SERVER_TOKEN; echo
export GRT_SERVER_TOKEN
python scripts/server_worker.py \
  --work-dir /path/to/work --prepared-dir /path/to/prepared \
  --deadline '<실제 UTC ISO8601 종료 시각>' \
  --queue research --runtime remote --device cuda --world-size 1
unset GRT_SERVER_TOKEN
```

Windows에서는 WSL을 사용하거나 가상환경에서 같은 Python 명령을 실행하고 비밀값을 환경으로 주입합니다. CPU 기능 검사는 `--runtime cpu --device cpu`를 사용하며 제출한 작업도 CPU 호환 조건이어야 합니다. 데스크톱도 실제 사용 가능 종료 시각을 지정합니다. Worker는 임의 shell이나 코드를 서버에서 내려받지 않습니다.

## Kaggle/Colab 중단 후 재개

1. 이전 런타임의 종료를 확인합니다. Stale running이면 lease 만료도 기다립니다.
2. 웹 실험의 **이어서 학습**을 선택합니다. Stale 상세에서는 종료 근거를 입력합니다. CLI는 `npm run cli -- jobs resume JOB_ID --evidence '이전 런타임이 종료된 것을 확인했습니다'`입니다. 종료 처리된 interrupted/failed/cancelled에는 evidence를 생략할 수 있습니다.
3. 같은 GRT commit·소스·prepared 데이터·world size의 새 런타임에서 큐 worker를 실행합니다. 데이터 다운로드를 원하면 `--prepared-from-server`를 선택합니다.
4. Worker가 snapshot의 설정·데이터·last/best 관계를 검사하고 preflight 단계에서 학습 상태를 복원합니다. 기존 microbatch·accumulation과 W&B run ID도 유지하며 새 attempt에 이력을 남깁니다.

복원 가능한 것은 이 기능으로 업로드·검증한 resume snapshot입니다. 기존 raw checkpoint만 있는 작업은 명확한 오류로 거부합니다. Last/best·optimizer·scheduler·rank별 RNG·stream 위치·메모리 state를 보존합니다. 재개 snapshot은 최근 2개와 현재 재개 원본을 유지해 디스크 누적을 제한하며 일반 최종 결과는 보존합니다. 원래 배치가 들어가는 GPU 환경을 사용하세요. 서버에 저장된 이후 진행분·실제 강제 종료·다른 GPU/라이브러리의 수치 동등성은 별도 범위입니다.

처음부터 다시 실행하려면 **처음부터 재시도**를 선택합니다. 서버가 새 Colab/Kaggle 세션을 시작하지 않으므로 새 worker 실행은 사용자가 수행합니다.

## 결과 받기

웹 실험 상세에서 개별 원본을 받거나 결과 화면에서 실험을 선택해 ZIP을 요청합니다. ZIP은 `ready`가 된 후 다운로드하세요. 실패하면 상세 오류를 확인하고 ZIP만 다시 요청합니다.

데스크톱에서 누적 수집할 때는 **GRT_server** checkout과 Node.js 24 이상을 사용합니다.

```bash
cd /path/to/GRT_server
npm ci
export GRT_SERVER_URL=https://grt.grtserver.cloud
read -rs -p 'GRT read-only token: ' GRT_SERVER_TOKEN; echo
export GRT_SERVER_TOKEN
npm run cli -- jobs list --campaign baseline --json
npm run cli -- results collect --campaign baseline --new --output ./collected
unset GRT_SERVER_TOKEN
```

`--new`는 로컬 SHA256이 일치하는 파일을 건너뜁니다. 부분·실패 결과까지 조회하려면 웹의 `실패·부분 결과 포함`을 선택하세요. 분석용 원본 JSON과 checkpoint를 보관하고, GRT의 `docs/experiments/`에 주제별 문서 하나로 결과·판단을 갱신합니다. 서명 URL에는 Bearer 헤더를 추가하지 않고 URL 자체를 공개하지 않습니다.

## 실험 관리·영구 삭제

웹 실험 화면에서 이름·Campaign·W&B 링크를 수정하고, 대기 상태에서는 큐·우선순위도 바꿀 수 있습니다. 학습 spec은 불변이므로 새로운 연구 조건은 복제로 등록합니다. 취소·재시도·큐 pause/resume·worker drain도 제공합니다.

CLI 관리 예제 (`metadata.json`에는 `{"name":"새 이름","campaign":"baseline"}` 저장):

```bash
npm run cli -- jobs update job_123 --file metadata.json
npm run cli -- jobs cancel job_123
npm run cli -- jobs delete job_123 --yes
```

**삭제는 실험 정보·attempt 이력·해당 실험 파일·관련 ZIP의 영구 삭제입니다.** 웹은 확인창을 표시하며 CLI는 `--yes`를 요구합니다. 여러 실험을 담은 ZIP도 함께 삭제되지만 다른 실험의 원본과 공유 dataset은 유지합니다. 실행·완료 검증 중인 작업은 먼저 취소하고 실제 종료·finalizing 완료를 기다려야 합니다. Stale lease만으로 종료를 판단하지 않습니다.

삭제 접수는 `202 / deleting`이며 완료 후 목록에서 사라지고 상세는 404입니다. 실패하면 오류가 표시되고 자동 재시도하며 서버 재시작 후에도 이어집니다. S3는 기존 서명 URL 만료를 위해 최대 5분 대기하고 모든 object version을 삭제합니다. 감사 로그와 중복 방지용 최소 요청 기록은 유지하며, 과거 응답에 실험 정보가 남지 않도록 제거합니다. 외부 다운로드·백업은 별도 보관 위치에서 직접 관리해야 합니다. 저장소 권한은 [운영](operations.md#선택-db저장소)을 확인하세요.
