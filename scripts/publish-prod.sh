#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE=".env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing ${ENV_FILE}. Create it from .env.example first." >&2
  exit 1
fi

ARTIFACT_BACKUP_DIR="$(mktemp -d)"
PM2_SNAPSHOT_SAVED=0
DEPLOY_SUCCEEDED=0

finish_deploy() {
  local status=$?
  trap - EXIT
  if [[ $status -ne 0 && $DEPLOY_SUCCEEDED -eq 0 ]]; then
    echo "CodexHub production deploy failed; restoring previous artifacts and PM2 state." >&2
    set +e
    for directory in dist dist-node; do
      rm -rf "$directory"
      if [[ -d "${ARTIFACT_BACKUP_DIR}/${directory}" ]]; then
        cp -a "${ARTIFACT_BACKUP_DIR}/${directory}" "$directory"
      fi
    done
    if [[ $PM2_SNAPSHOT_SAVED -eq 1 ]]; then
      pm2 delete codexhub-prod >/dev/null 2>&1 || true
      pm2 resurrect >/dev/null 2>&1 || true
    fi
  fi
  rm -rf "$ARTIFACT_BACKUP_DIR"
  exit "$status"
}
trap finish_deploy EXIT

for directory in dist dist-node; do
  if [[ -d "$directory" ]]; then
    cp -a "$directory" "${ARTIFACT_BACKUP_DIR}/${directory}"
  fi
done

pnpm check
pnpm build

PACKAGE_VERSION="$(node -p 'require("./package.json").version')"
SOURCE_REVISION="$(git rev-parse --short=12 HEAD)"
if [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then
  SOURCE_REVISION="${SOURCE_REVISION}.dirty"
fi
export CODEX_HUB_BUILD_ID="${CODEX_HUB_BUILD_ID:-v${PACKAGE_VERSION}+${SOURCE_REVISION}}"
if [[ -z "$CODEX_HUB_BUILD_ID" ]]; then
  echo "CODEX_HUB_BUILD_ID must not be empty for a production deploy." >&2
  exit 1
fi

PROD_PORT="$(
  node --input-type=module -e 'import { loadDotEnv } from "./dist-node/src/core/dotenv.js"; await loadDotEnv(); console.log(process.env.CODEX_HUB_PORT ?? "8788");'
)"
PROD_URL="http://127.0.0.1:${PROD_PORT}"

pm2 save --force >/dev/null
PM2_SNAPSHOT_SAVED=1
pm2 delete codexhub-next >/dev/null 2>&1 || true
pm2 delete codexhub-tg >/dev/null 2>&1 || true
EXPECTED_PROD_SCRIPT="${ROOT_DIR}/bin/codexhub"
CURRENT_PROD_SCRIPT="$(
  pm2 jlist | node -e '
    const fs = require("node:fs");
    const processes = JSON.parse(fs.readFileSync(0, "utf8"));
    const processEntry = processes.find((entry) => entry.name === "codexhub-prod");
    process.stdout.write(processEntry?.pm2_env?.pm_exec_path ?? "");
  '
)"
if [[ -z "$CURRENT_PROD_SCRIPT" ]]; then
  pm2 start ecosystem.config.cjs --only codexhub-prod --update-env
elif [[ "$CURRENT_PROD_SCRIPT" != "$EXPECTED_PROD_SCRIPT" ]]; then
  # PM2 keeps the old script path on startOrRestart, so recreate only for this migration.
  pm2 delete codexhub-prod >/dev/null 2>&1
  pm2 start ecosystem.config.cjs --only codexhub-prod --update-env
else
  pm2 startOrRestart ecosystem.config.cjs --only codexhub-prod --update-env
fi

for _ in {1..30}; do
  if curl -fsS "${PROD_URL}/api/health" >/tmp/codexhub-prod-health.json; then
    break
  fi
  sleep 1
done

curl -fsS "${PROD_URL}/api/health" >/tmp/codexhub-prod-health.json
curl -fsS "${PROD_URL}/" >/tmp/codexhub-prod-index.html

ACTUAL_BUILD_ID="$(node -e 'const fs = require("node:fs"); const value = JSON.parse(fs.readFileSync("/tmp/codexhub-prod-health.json", "utf8")); process.stdout.write(value.build ?? "");')"
if [[ "$ACTUAL_BUILD_ID" != "$CODEX_HUB_BUILD_ID" ]]; then
  echo "CodexHub production build mismatch: expected ${CODEX_HUB_BUILD_ID}, got ${ACTUAL_BUILD_ID:-<empty>}." >&2
  exit 1
fi

pm2 save
DEPLOY_SUCCEEDED=1

echo "codexhub prod published: ${PROD_URL} (${CODEX_HUB_BUILD_ID})"
