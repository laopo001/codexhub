#!/usr/bin/env bash
set -euo pipefail

EXPECTED_COMMIT="${1:-}"
REPOSITORY_DIR="${2:-}"
MODE="${3:-deploy}"

if [[ ! "$EXPECTED_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Invalid expected deployment commit: ${EXPECTED_COMMIT:-<empty>}." >&2
  exit 2
fi
if [[ "$REPOSITORY_DIR" != /* || ! -d "$REPOSITORY_DIR/.git" ]]; then
  echo "Invalid production repository: ${REPOSITORY_DIR:-<empty>}." >&2
  exit 2
fi
if [[ "$MODE" != "deploy" && "$MODE" != "check" ]]; then
  echo "Invalid deployment mode: ${MODE}." >&2
  exit 2
fi

cd "$REPOSITORY_DIR"

export PATH="$HOME/.local/bin:$HOME/.local/share/fnm:$PATH"
if command -v fnm >/dev/null 2>&1; then
  eval "$(fnm env --shell bash)"
fi

for command_name in git node pnpm pm2 curl flock; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing production command: ${command_name}." >&2
    exit 1
  fi
done
if [[ ! -f .env ]]; then
  echo "Missing ${REPOSITORY_DIR}/.env." >&2
  exit 1
fi
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "Production checkout has tracked changes; refusing to deploy." >&2
  git status --short --untracked-files=no >&2
  exit 1
fi

LOCK_FILE="${TMPDIR:-/tmp}/codexhub-production-${UID}.lock"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "Another CodexHub production deployment is running." >&2
  exit 1
fi

git fetch --prune origin main
MAIN_COMMIT="$(git rev-parse origin/main)"
if ! git cat-file -e "${EXPECTED_COMMIT}^{commit}" 2>/dev/null; then
  echo "Deployment commit ${EXPECTED_COMMIT} is not available from origin/main." >&2
  exit 1
fi
if ! git merge-base --is-ancestor "$EXPECTED_COMMIT" "$MAIN_COMMIT"; then
  echo "Deployment commit ${EXPECTED_COMMIT} does not belong to origin/main." >&2
  exit 1
fi
if [[ "$EXPECTED_COMMIT" != "$MAIN_COMMIT" ]]; then
  echo "Skipping superseded deployment ${EXPECTED_COMMIT}; origin/main is ${MAIN_COMMIT}."
  exit 0
fi

PACKAGE_VERSION="$(
  git show "${EXPECTED_COMMIT}:package.json" \
    | node -e 'const fs = require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(0, "utf8")).version ?? "");'
)"
if [[ -z "$PACKAGE_VERSION" ]]; then
  echo "Deployment commit ${EXPECTED_COMMIT} has no package version." >&2
  exit 1
fi

if [[ "$MODE" == "check" ]]; then
  echo "codexhub production preflight ok: ${EXPECTED_COMMIT}"
  echo "node $(node --version), pnpm $(pnpm --version), pm2 $(pm2 --version)"
  exit 0
fi

PREVIOUS_COMMIT="$(git rev-parse HEAD)"
DEPLOY_SUCCEEDED=0

restore_source() {
  local status=$?
  trap - EXIT
  if [[ $status -ne 0 && $DEPLOY_SUCCEEDED -eq 0 ]]; then
    echo "CodexHub deployment failed; restoring checkout ${PREVIOUS_COMMIT}." >&2
    git switch --detach "$PREVIOUS_COMMIT" >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap restore_source EXIT

git switch --detach "$EXPECTED_COMMIT"
pnpm install --frozen-lockfile

export CODEX_HUB_BUILD_ID="v${PACKAGE_VERSION}+${EXPECTED_COMMIT:0:12}"
pnpm run publish:prod

DEPLOY_SUCCEEDED=1
echo "codexhub production deployment complete: ${EXPECTED_COMMIT}"
