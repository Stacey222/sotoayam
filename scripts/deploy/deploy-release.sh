#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 2 ]]; then
  echo "Usage: deploy-release.sh <archive.tar.gz> <release-id>" >&2
  exit 1
fi

ARCHIVE="$1"
RELEASE_ID="$2"
APP_ROOT="/opt/gwens-automation"
CURL_COMMAND="curl"
if [[ -n "${SOTOAYAM_DEPLOY_TEST_ROOT:-}" ]]; then
  if [[ "${NODE_ENV:-}" != "test" ]]; then
    echo "SOTOAYAM_DEPLOY_TEST_ROOT is restricted to test execution" >&2
    exit 1
  fi
  APP_ROOT="${SOTOAYAM_DEPLOY_TEST_ROOT}"
  CURL_COMMAND="${SOTOAYAM_DEPLOY_TEST_CURL:-curl}"
fi
RELEASE_DIR="${APP_ROOT}/releases/${RELEASE_ID}"

if [[ ! "${RELEASE_ID}" =~ ^release-[0-9a-f]{7}-[0-9]{14}$ ]]; then
  echo "Invalid release identifier" >&2
  exit 1
fi
if [[ ! -f "${ARCHIVE}" ]]; then
  echo "Release archive not found" >&2
  exit 1
fi
if [[ -e "${RELEASE_DIR}" ]]; then
  echo "Release directory already exists" >&2
  exit 1
fi
for name in SUPABASE_ACCESS_TOKEN SUPABASE_DB_PASSWORD SUPABASE_PROJECT_REF; do
  if [[ -z "${!name:-}" ]]; then
    echo "Required deployment environment variable is missing: ${name}" >&2
    exit 1
  fi
done

umask 0027
mkdir -p "${RELEASE_DIR}"
tar -xzf "${ARCHIVE}" -C "${RELEASE_DIR}"

cleanup_link_state() {
  case "${RELEASE_DIR}" in
    "${APP_ROOT}/releases/"*) rm -rf -- "${RELEASE_DIR}/supabase/.temp" ;;
    *) echo "Refusing to clean Supabase link state outside the release directory" >&2 ;;
  esac
}
trap cleanup_link_state EXIT

(
  cd "${RELEASE_DIR}"
  npm ci --include=dev --ignore-scripts
  if [[ ! -x "node_modules/.bin/supabase" ]]; then
    echo "Migration gate failed: pinned Supabase CLI is unavailable" >&2
    exit 1
  fi
  if ! ./node_modules/.bin/supabase link --project-ref "${SUPABASE_PROJECT_REF}" --yes; then
    echo "Migration gate failed: Supabase authentication or project linking failed" >&2
    exit 1
  fi
  echo "MIGRATION_GATE=START"
  if ! npm run migrate; then
    echo "MIGRATION_GATE=FAIL" >&2
    exit 1
  fi
  echo "MIGRATION_GATE=PASS"
  npm prune --omit=dev --ignore-scripts
)
cleanup_link_state
trap - EXIT

if [[ -L "${APP_ROOT}/current" ]]; then
  readlink -f "${APP_ROOT}/current" >"${APP_ROOT}/shared/previous-release"
fi
ln -s "${RELEASE_DIR}" "${APP_ROOT}/current.next"
mv -Tf "${APP_ROOT}/current.next" "${APP_ROOT}/current"

if ! sudo systemctl restart gwens-automation.service; then
  echo "POST_ACTIVATION_RESTART=FAIL" >&2
  exit 1
fi
if ! "${CURL_COMMAND}" -fsS --retry 10 --retry-connrefused --retry-delay 1 --max-time 30 http://127.0.0.1:3000/health >/dev/null; then
  echo "POST_ACTIVATION_HEALTH=FAIL" >&2
  exit 1
fi

echo "DEPLOYED_RELEASE=${RELEASE_ID}"
echo "POST_ACTIVATION_HEALTH=PASS"
