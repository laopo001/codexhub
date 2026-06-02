#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE=".env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing ${ENV_FILE}. Create it from .env.example first." >&2
  exit 1
fi

PROD_PORT="$(
  node --import tsx --input-type=module -e 'import { loadDotEnv } from "./src/core/dotenv.ts"; await loadDotEnv(); console.log(process.env.CODEX_HUB_PORT ?? "8788");'
)"
PROD_URL="http://127.0.0.1:${PROD_PORT}"

pnpm check
pnpm build

pm2 delete codexhub-next >/dev/null 2>&1 || true
pm2 delete codexhub-tg >/dev/null 2>&1 || true
pm2 startOrRestart ecosystem.config.cjs --only codexhub-prod --update-env

for _ in {1..30}; do
  if curl -fsS "${PROD_URL}/api/health" >/tmp/codexhub-prod-health.json; then
    break
  fi
  sleep 1
done

curl -fsS "${PROD_URL}/api/health" >/tmp/codexhub-prod-health.json
curl -fsS "${PROD_URL}/" >/tmp/codexhub-prod-index.html

pm2 save

echo "codexhub prod published: ${PROD_URL}"
