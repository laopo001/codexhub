#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE=".env"
unset CODEX_SANDBOX_MODE

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing ${ENV_FILE}. Create it from .env.example first." >&2
  exit 1
fi

PROD_PORT="$(
  node --import tsx --input-type=module -e 'import { loadDotEnv } from "./src/core/dotenv.ts"; await loadDotEnv(); console.log(process.env.CODEX_PROXY_PORT ?? "18788");'
)"
PROD_URL="http://127.0.0.1:${PROD_PORT}"

pnpm check
pnpm build

pm2 delete codex-proxy-next >/dev/null 2>&1 || true
pm2 delete codex-proxy-tg >/dev/null 2>&1 || true
pm2 startOrRestart ecosystem.config.cjs --only codex-proxy-prod --update-env

for _ in {1..30}; do
  if curl -fsS "${PROD_URL}/api/health" >/tmp/codex-proxy-prod-health.json; then
    break
  fi
  sleep 1
done

curl -fsS "${PROD_URL}/api/health" >/tmp/codex-proxy-prod-health.json
curl -fsS "${PROD_URL}/" >/tmp/codex-proxy-prod-index.html

pm2 save

echo "codex-proxy prod published: ${PROD_URL}"
