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

S3:

```dotenv
STORAGE_DRIVER=s3
AWS_REGION=ap-northeast-2
S3_BUCKET=your-private-versioned-bucket
S3_PREFIX=grt/
```

버킷은 비공개·암호화·versioning을 적용하고 서버 IAM role에 해당 prefix의 `s3:GetObject` / `s3:GetObjectVersion` / `s3:PutObject` / `s3:DeleteObject` / `s3:DeleteObjectVersion` 권한을 부여합니다. 버킷에는 `s3:ListBucketVersions`를 해당 prefix 조건으로 허용합니다. 삭제는 현재 버전뿐 아니라 같은 object key의 모든 버전·delete marker를 제거합니다. Object Lock·권한 거부가 있으면 완료 처리하지 않고 재시도합니다. AWS SDK 기본 credential chain을 사용합니다. 검증한 VersionId만 다운로드하며 URL 수명은 최대 5분과 현재 인증 만료 중 짧은 값입니다.

S3 삭제는 이미 발급된 서명 URL의 유효기간(최대 5분) 이후 처리합니다. 이미 시작된 외부 전송·별도 복제본과 백업은 별도 관리 대상입니다. 실제 S3 권한·versioning·삭제는 선택 구성 도입 시 확인하세요.

설정 변경은 기존 데이터의 자동 이전을 수행하지 않습니다. 서버 정지 → DB·파일 백업 → 복사·검증 → 설정 전환 순서로 이전하고 실제 DB/S3에서 claim·파일 hash·ZIP·복원을 재검사합니다. Vast offer 검색만 필요하면 `VAST_API_KEY`를 추가합니다. 유료 임대와 자동 과금 종료는 제공하지 않습니다.
