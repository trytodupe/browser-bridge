#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ -f "$ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

run_web_ext() {
  if command -v web-ext >/dev/null 2>&1; then
    web-ext "$@"
  elif command -v bunx >/dev/null 2>&1; then
    bunx web-ext "$@"
  else
    npx --yes web-ext "$@"
  fi
}

echo "==> Linting addon/"
run_web_ext lint --source-dir "$ROOT/addon"

echo "==> Building unsigned archive into dist/"
mkdir -p "$ROOT/dist"
run_web_ext build --source-dir "$ROOT/addon" --artifacts-dir "$ROOT/dist" --overwrite-dest

API_KEY="${WEB_EXT_API_KEY:-${AMO_API_KEY:-}}"
API_SECRET="${WEB_EXT_API_SECRET:-${AMO_API_SECRET:-}}"

if [ -z "$API_KEY" ] || [ -z "$API_SECRET" ] || [ "$API_SECRET" = "your-secret-here" ]; then
  echo ""
  echo "Note: AMO_API_KEY / AMO_API_SECRET not set in .env or environment."
  echo "Unsigned package built in $ROOT/dist/ (can be loaded immediately via about:debugging)."
  echo "To build a self-signed unlisted .xpi for standard Firefox:"
  echo "  1. Create API keys at https://addons.mozilla.org/developers/addon/api/key/"
  echo "  2. Copy .env.example to .env and fill AMO_API_KEY and AMO_API_SECRET"
  echo "  3. Re-run ./scripts/sign-xpi.sh"
  exit 0
fi

echo "==> Submitting unlisted package to Mozilla AMO for signing..."
run_web_ext sign \
  --channel=unlisted \
  --source-dir "$ROOT/addon" \
  --artifacts-dir "$ROOT/dist" \
  --api-key "$API_KEY" \
  --api-secret "$API_SECRET"

echo "==> Signed .xpi ready in $ROOT/dist/:"
ls -lh "$ROOT/dist/"*.xpi
