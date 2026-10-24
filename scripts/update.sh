#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

git pull --ff-only origin main
npm ci
npm run build
sudo systemctl restart grt
curl --fail --silent --show-error \
  --retry 10 --retry-delay 1 --retry-connrefused --max-time 5 \
  https://grt.grtserver.cloud/healthz
printf '\n'
