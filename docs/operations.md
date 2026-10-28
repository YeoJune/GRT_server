# 운영

기본 구성은 HTTPS 프록시 → `127.0.0.1:3000`의 Node 프로세스 하나 → SQLite·로컬 파일입니다. 운영 주소는 `https://grt.grtserver.cloud`입니다. API·실행기 계약은 [API](api.md), GRT 학습 연결은 [GRT 서버 연결](https://github.com/YeoJune/GRT/blob/main/docs/server.md)을 따릅니다.

## Amazon Linux 2023 / ARM64

EC2의 `ec2-user`, `/home/ec2-user/GRT_server` checkout, `/usr/local/bin/node`의 Node.js 24 이상과 `/usr/local/bin/caddy`의 ARM64 Caddy를 기준으로 합니다. DNS는 EC2 공인 주소를 가리켜야 하며 보안 그룹은 HTTPS용 443과 인증서 발급·HTTP 이동용 80을 허용합니다. SSH는 관리 주소로 제한하고 3000은 공개하지 않습니다.

`.env`에 계정·서명 키와 함께 운영 설정을 둡니다. 최초 계정 생성은 [빠른 시작](../README.md#빠른-시작)을 따릅니다.

```dotenv
NODE_ENV=production
APP_ORIGIN=https://grt.grtserver.cloud
COOKIE_SECURE=true
TRUST_PROXY=1
```

```bash
cd /home/ec2-user/GRT_server
chmod 600 .env
npm ci
npm run build
```

`/etc/systemd/system/grt.service`:

```ini
[Unit]
Description=GRT Server
After=network.target

[Service]
User=ec2-user
WorkingDirectory=/home/ec2-user/GRT_server
ExecStart=/usr/local/bin/node /home/ec2-user/GRT_server/server/dist/index.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=35
UMask=0077

[Install]
WantedBy=multi-user.target
```

Caddy는 `caddy` 시스템 계정으로 실행하고 상태를 `/var/lib/caddy`에 보관합니다. 해당 계정이 없을 때 생성합니다.

```bash
id -u caddy >/dev/null 2>&1 || sudo useradd --system --home-dir /var/lib/caddy --shell /sbin/nologin caddy
sudo mkdir -p /etc/caddy
```

`/etc/caddy/Caddyfile`:

```caddyfile
{
    log default {
        format filter {
            wrap json
            fields {
                request>uri query {
                    replace signature REDACTED
                }
            }
        }
    }
}

grt.grtserver.cloud {
    reverse_proxy 127.0.0.1:3000
}
```

`/etc/systemd/system/caddy.service`:

```ini
[Unit]
Description=Caddy HTTPS Proxy
After=network-online.target
Wants=network-online.target

[Service]
User=caddy
Group=caddy
StateDirectory=caddy
Environment=XDG_DATA_HOME=/var/lib/caddy
Environment=XDG_CONFIG_HOME=/var/lib/caddy
ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo /usr/local/bin/caddy validate --config /etc/caddy/Caddyfile
sudo systemctl daemon-reload
sudo systemctl enable --now grt caddy
curl --fail --show-error https://grt.grtserver.cloud/healthz
```

이미 실행 중인 Caddy의 설정을 바꿨다면 검증 후 `sudo systemctl reload caddy`로 반영합니다. `enable --now`는 실행 중인 설정을 다시 읽지 않습니다. 운영 로그에 Authorization·cookie·요청 본문·서명 URL을 기록하지 않습니다.

## 업데이트와 점검

실행 중인 작업을 확인하고 업데이트 시간을 정합니다. lease 만료만으로 이전 프로세스가 종료됐다고 판단하지 않습니다.

```bash
cd /home/ec2-user/GRT_server
sh scripts/update.sh
sudo systemctl status grt caddy --no-pager
sudo journalctl -u grt -u caddy --since "10 minutes ago" --no-pager
df -h /home/ec2-user/GRT_server
```

`scripts/update.sh`가 없는 이전 checkout은 한 번 `git pull --ff-only origin main`을 실행한 뒤 사용합니다. 스크립트는 pull → npm ci → build → grt 재시작 → HTTPS healthz 재확인을 수행하고 실패하면 중단합니다. 서버 업데이트는 연결된 GPU 프로세스를 종료하거나 GRT checkout을 갱신하지 않습니다. 기존 큐 작업·재개에는 고정된 GRT 코드가 필요하므로 worker를 무조건 최신 commit으로 바꾸지 않습니다.

DB migration은 시작 시 적용합니다. 별도로 실행하려면 `npm run db:migrate`를 사용합니다. 오류를 공유할 때는 시각·request/job/attempt ID와 비밀값을 제거한 로그를 함께 남깁니다.

ZIP은 `ready`까지 조회합니다. 실패 원인을 해결한 뒤 새 Idempotency-Key로 ZIP만 다시 요청할 수 있으며 학습은 반복하지 않습니다. `/tmp`와 파일 저장소는 서로 다른 파일시스템이어도 됩니다. 로컬 ZIP은 저장소 내부에 완전히 복사한 뒤 원자적으로 확정합니다.

## 계정 복구

`.env`의 `OWNER_USERNAME` / `OWNER_PASSWORD`를 복구할 값으로 설정하고 실행합니다.

```bash
npm run account:reset
```

기존 브라우저 세션은 폐기합니다. API 토큰도 폐기하려면 `RESET_REVOKE_TOKENS=true`를 해당 명령에 함께 설정합니다. 복구 후 `.env`의 비밀번호를 제거합니다.

## 백업과 복원

기본 경로는 `data/grt.sqlite`와 `data/artifacts`입니다. DB와 원본 파일을 함께 보존합니다. 실행 중인 SQLite 파일만 단순 복사하지 않습니다. SQLite backup API를 사용하거나 서비스 정지 후 일관된 snapshot을 만듭니다.

기본 경로를 사용하는 서버의 비공개 백업 예:

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

백업에는 인증 DB와 `.env`가 있으므로 접근을 제한합니다. 코드 commit·systemd/Caddy 설정과 복구에 필요한 서명 키 보관 위치도 기록합니다. 복원은 별도 경로/인스턴스에 수행하고, 같은 코드·필수 설정으로 migration과 시작을 확인한 뒤 로그인·job 이력·원본 파일 hash를 비교합니다. 확인된 복원본으로 전환하기 전 운영 폴더를 덮어쓰지 않습니다.

S3 구성에서 이 tar 백업은 S3 원본을 포함하지 않습니다. DB·설정과 S3 파일을 함께 복구할 수 있도록 별도 백업을 관리합니다. 앱의 영구 삭제는 모든 S3 버전을 제거하므로 Versioning 자체를 독립 백업으로 간주하지 않습니다.

보관 기간에 따른 자동 삭제는 없습니다. 재개용 snapshot만 최근 2개와 활성 재개 원본을 보존하고 나머지 bytes를 정리합니다. 공유 prepared 데이터·최종 원본 파일·ZIP은 계속 보존하므로 디스크를 점검합니다. 웹·CLI의 실험 영구 삭제는 해당 원본·모든 checkpoint·관련 ZIP을 제거하며 되돌릴 수 없습니다. running/finalizing 작업은 종료 후 삭제합니다. 삭제 중 오류는 상세의 deletion_error와 저장소 권한·서버 로그를 확인합니다. 서버는 30초 뒤 재시도하고 재시작 후에도 이어갑니다. 외부 다운로드·백업은 이 삭제 대상에 포함되지 않습니다. 디스크 사용량을 확인하고, 테스트 토큰·임시 큐와 데이터 정리는 소유자의 관리 작업으로 수행합니다.

## 선택 DB·저장소

PostgreSQL / RDS PostgreSQL:

```dotenv
DB_CLIENT=pg
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/grt
DB_SSL=true
DB_SSL_CA_FILE=/absolute/path/to/rds-global-bundle.pem
```

운영 TLS는 인증서를 검증합니다. TLS 없는 개발 DB에만 `DB_SSL=false`를 사용합니다. RDS MySQL은 지원하지 않습니다.

### S3 설정

현재 운영 파일은 서울 리전(`ap-northeast-2`)의 `grt-server` 버킷, `grt/` prefix에 저장합니다. Prepared·checkpoint·리포트·ZIP은 S3에서 직접 전송하며 EC2에는 SQLite·서버 코드·ZIP 임시 공간을 둡니다. [S3 이전 완료 기록](archive/20261028_s3_migration.md)을 보존하고 완료된 일회성 생성·이전 도구는 제거했습니다.

새 환경은 첫 실행 전에 비공개 범용 버킷에 Versioning·SSE-S3·퍼블릭 액세스 차단·ACL 비활성화를 적용하고 EC2 IAM Role을 연결합니다. Role에는 다음 권한을 부여합니다.

- 객체 `arn:aws:s3:::grt-server/grt/*`: `s3:GetObject`, `s3:GetObjectVersion`, `s3:PutObject`, `s3:DeleteObject`, `s3:DeleteObjectVersion`
- 버킷 `arn:aws:s3:::grt-server`: `s3:ListBucketVersions`. `s3:prefix`를 `grt/*`로 제한합니다.

```dotenv
STORAGE_DRIVER=s3
AWS_REGION=ap-northeast-2
S3_BUCKET=grt-server
S3_PREFIX=grt/
```

AWS SDK 기본 credential chain으로 EC2 Role을 사용합니다. 실행기에는 AWS 키를 전달하지 않습니다. S3는 사전 용량 할당이 없으며 초기 관리 기준은 **1TB = 1,000,000,000,000 bytes**입니다. 선택 설정 `S3_BUDGET_BYTES`로 표시 기준만 바꿀 수 있고, 초과해도 저장·과금은 계속됩니다. 기존 DB의 driver/bucket/prefix/region을 `.env`만 바꿔 전환하는 것은 차단하며 자동 이전은 제공하지 않습니다.

검증한 VersionId만 다운로드하며 서명 URL은 최대 5분과 현재 인증 만료 중 짧은 값까지 유효합니다. 영구 삭제는 기존 URL 만료 후 해당 key의 모든 버전·delete marker를 제거합니다. Object Lock·권한 거부는 오류로 재시도합니다. 별도 복제본·백업은 앱의 삭제 대상이 아닙니다. 버전 만료·Glacier 전환 Lifecycle은 DB가 참조하는 파일을 없앨 수 있으므로 임의로 추가하지 않습니다.

파일 기본 한도는 1GiB(`MAX_ARTIFACT_BYTES`), ZIP 원본 합계는 2GiB(`MAX_EXPORT_BYTES`)입니다. 1TB 관리 기준과 별개입니다. 현재 단일 PUT 방식이므로 S3의 단일 요청 크기 한도도 지켜야 합니다.

S3 이전과 기존 로컬 복사본 삭제는 완료했습니다. 일회성 정리 코드도 제거했으며 [완료 기록](archive/20261028_s3_migration.md)을 보존합니다.

### 저장공간 확인

웹 **설정 → 저장공간** 또는 URL·토큰을 설정한 관리 CLI를 사용합니다.

```bash
npm run cli -- storage usage
```

- S3: 설정한 bucket/prefix의 현재·이전 버전 데이터량, 파일·버전 수, 관리 기준과 확인 시각. 전체 version 목록을 읽고 최대 5분 재사용하므로 목록 요청 비용이 소량 발생합니다. 다른 prefix와 DB·디스크는 합산하지 않습니다. 이전 버전도 저장비가 발생하며, 이 표시는 청구서 계산이 아닙니다.
- 디스크: 코드·SQLite·파일 저장 경로·임시 경로가 있는 파일시스템의 전체·사용·서버 계정 가용량. 같은 mount는 한 번만 표시합니다. S3로 바꿔도 ZIP 생성용 여유 공간과 DB 백업은 필요합니다.
- 조회 실패는 0이 아닌 오류로 표시합니다. S3 권한·Role·리전·prefix를 확인하고 다시 조회합니다. 1TB 초과 안내는 화면에 표시하며 자동 삭제·차단·이메일 경보는 제공하지 않습니다.

### 월별 다운로드 사용량

설정 화면에는 이번 달 인터넷 전송량만 표시하고 **자세히 보기**에서 최근 12개월을 확인합니다. 원본은 AWS Cost Explorer의 청구 사용량이며 EC2·S3 등 현재 청구 계정에 포함된 서비스·리전의 표준 `DataTransfer-Out-Bytes` 항목을 합산합니다. 특정 버킷의 다운로드나 서명 URL 발급량으로 간주하지 않습니다. 무료 적용·할인·다른 과금 항목이 있으므로 이 숫자에 단가를 곱해 전체 AWS 청구액을 계산하지 않습니다.

연결 방법:

1. AWS Billing and Cost Management → Cost Explorer에서 활성화합니다. 처음 활성화하면 데이터 준비 시간이 필요합니다.
2. 기존 EC2 IAM Role에 아래 인라인 정책을 **추가**합니다. 정책 이름 예시는 `GRTUsageRead`이며 기존 S3 정책은 유지합니다.

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": ["ce:GetCostAndUsage", "ce:GetDimensionValues"],
         "Resource": "*"
       }
     ]
   }
   ```

3. 서버 업데이트 후 설정 화면을 엽니다. AccessDenied·데이터 미준비·조회 실패는 용량 0이 아닌 안내로 표시합니다. 권한을 수정했다면 30초 후 사용량 새로고침을 누릅니다.

월 기준은 AWS에 맞춘 UTC이며 오늘 UTC 이전까지 반영된 사용량입니다. 당일 전송은 실시간 반영되지 않습니다. 이번 달 수치는 잠정 집계이고, 월 첫날 아직 데이터 범위가 없으면 집계 대기로 표시합니다. 성공한 결과는 24시간 DB 캐시하므로 서버 재시작·다른 사용자 접속이 조회를 반복하지 않습니다. 월이 바뀌면 캐시 기간과 무관하게 새 월을 조회합니다.

[AWS 공식 요금](https://aws.amazon.com/aws-cost-management/aws-cost-explorer/pricing/) 기준 기본 청구 뷰의 Cost Explorer API는 요청당 $0.01입니다. 일반 조회는 사용 유형·월별 집계 각 1건이며 pagination이 있으면 추가 요청이 발생합니다. 캐시는 반복 조회 비용을 줄입니다. 별도의 hourly/resource 데이터 기능을 활성화할 필요는 없습니다.

PostgreSQL 전환은 기존 데이터를 자동 이전하지 않습니다. 별도로 백업·이전·복원을 검증합니다. Vast offer 검색만 필요하면 `VAST_API_KEY`를 추가합니다. 유료 임대와 자동 과금 종료는 제공하지 않습니다.
