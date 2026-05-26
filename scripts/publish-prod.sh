#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE="${CODEX_PROXY_ENV_FILE:-.env.prod}"
PROD_PORT="${CODEX_PROXY_PROD_PORT:-18788}"
NEXT_PORT="${CODEX_PROXY_NEXT_PORT:-18790}"
NEXT_URL="http://127.0.0.1:${NEXT_PORT}"
unset CODEX_SANDBOX_MODE

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing ${ENV_FILE}. Create it from .env.prod.example first." >&2
  exit 1
fi

pnpm check
pnpm build

pm2 delete codex-proxy-next >/dev/null 2>&1 || true
CODEX_PROXY_ENV_FILE="$ENV_FILE" CODEX_PROXY_NEXT_PORT="$NEXT_PORT" pm2 start ecosystem.config.cjs --only codex-proxy-next --update-env

cleanup_next() {
  pm2 delete codex-proxy-next >/dev/null 2>&1 || true
}
trap cleanup_next EXIT

for _ in {1..30}; do
  if curl -fsS "${NEXT_URL}/api/health" >/tmp/codex-proxy-next-health.json; then
    break
  fi
  sleep 1
done

curl -fsS "${NEXT_URL}/api/health" >/tmp/codex-proxy-next-health.json
curl -fsS "${NEXT_URL}/" >/tmp/codex-proxy-next-index.html

cleanup_next
trap - EXIT

if pm2 describe codex-proxy-prod >/dev/null 2>&1; then
  CODEX_PROXY_ENV_FILE="$ENV_FILE" pm2 restart codex-proxy-prod --update-env
else
  CODEX_PROXY_ENV_FILE="$ENV_FILE" pm2 start ecosystem.config.cjs --only codex-proxy-prod --update-env
fi

if pm2 describe codex-proxy-tg >/dev/null 2>&1; then
  CODEX_PROXY_ENV_FILE="$ENV_FILE" pm2 restart codex-proxy-tg --update-env
else
  CODEX_PROXY_ENV_FILE="$ENV_FILE" pm2 start ecosystem.config.cjs --only codex-proxy-tg --update-env
fi

pm2 save

echo "codex-proxy prod published: http://127.0.0.1:${PROD_PORT}"
