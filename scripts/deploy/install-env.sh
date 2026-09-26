#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/deployment-config.sh"
load_deployment_config
TARGET="${APP_ROOT}/shared/.env"
NEXT="${TARGET}.next"
REPLACE_ENV=false
if [[ "$#" -gt 1 || ( "$#" -eq 1 && "$1" != "--replace" ) ]]; then
  echo "Usage: install-env.sh [--replace]" >&2
  exit 1
fi
if [[ "$#" -eq 1 ]]; then
  REPLACE_ENV=true
fi
if [[ -e "${TARGET}" && "${REPLACE_ENV}" != "true" ]]; then
  echo "Environment installation refused: ${TARGET} already exists; review the new file and rerun with --replace" >&2
  exit 1
fi
REQUIRED=(
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
  TELEGRAM_BOT_TOKEN
  INTERNAL_API_KEY
  INTERNAL_API_KEY_FALLBACK_ENABLED
  ADMIN_API_KEY_FALLBACK_ENABLED
  SESSION_COOKIE_SECURE
  TRUST_PROXY
  HOST
  PORT
  TELEGRAM_POLLING_ENABLED
  REMINDER_SCHEDULER_ENABLED
  REMINDER_SCHEDULER_INTERVAL_SECONDS
  BUSINESS_TIME_ZONE
  CRITICAL_ALERT_EVALUATOR_ENABLED
  LOG_LEVEL
)

umask 0027
trap 'rm -f -- "${NEXT}"' EXIT
tr -d '\r' >"${NEXT}"
test -s "${NEXT}"
for name in SUPABASE_PROJECT_REF SUPABASE_DB_PASSWORD SUPABASE_ACCESS_TOKEN; do
  if grep -q "^${name}=" "${NEXT}"; then
    echo "Environment validation failed: ${name} is deploy-only and must not be stored in shared/.env" >&2
    exit 1
  fi
done
for name in "${REQUIRED[@]}"; do
  if [[ "$(grep -c "^${name}=" "${NEXT}")" -ne 1 ]]; then
    echo "Environment validation failed: ${name} must appear exactly once" >&2
    exit 1
  fi
  if grep -Eq "^${name}=(|\"\")$" "${NEXT}"; then
    echo "Environment validation failed: ${name} must not be empty" >&2
    exit 1
  fi
done
for name in TELEGRAM_POLLING_ENABLED REMINDER_SCHEDULER_ENABLED CRITICAL_ALERT_EVALUATOR_ENABLED INTERNAL_API_KEY_FALLBACK_ENABLED ADMIN_API_KEY_FALLBACK_ENABLED SESSION_COOKIE_SECURE TRUST_PROXY; do
  if ! grep -Eq "^${name}=(true|false|\"true\"|\"false\")$" "${NEXT}"; then
    echo "Environment validation failed: ${name} must be true or false" >&2
    exit 1
  fi
done
ADMIN_FALLBACK_VALUE="$(sed -n 's/^ADMIN_API_KEY_FALLBACK_ENABLED=//p' "${NEXT}" | tr -d '"')"
ADMIN_KEY_COUNT="$(grep -c '^ADMIN_API_KEY=' "${NEXT}" || true)"
ADMIN_KEY_VALUE="$(sed -n 's/^ADMIN_API_KEY=//p' "${NEXT}" | tr -d '"')"
if [[ "${ADMIN_KEY_COUNT}" -gt 1 || ( "${ADMIN_KEY_COUNT}" -eq 1 && -n "${ADMIN_KEY_VALUE}" && "${#ADMIN_KEY_VALUE}" -lt 32 ) ]]; then
  echo "Environment validation failed: ADMIN_API_KEY must appear at most once and contain at least 32 characters when present" >&2
  exit 1
fi
if [[ "${ADMIN_FALLBACK_VALUE}" == "true" && ( "${ADMIN_KEY_COUNT}" -ne 1 || -z "${ADMIN_KEY_VALUE}" ) ]]; then
  echo "Environment validation failed: ADMIN_API_KEY is required when ADMIN_API_KEY_FALLBACK_ENABLED=true" >&2
  exit 1
fi
if ! grep -Eq '^HOST=(127\.0\.0\.1|"127\.0\.0\.1")$' "${NEXT}"; then
  echo "Environment validation failed: HOST must be 127.0.0.1" >&2
  exit 1
fi
if ! grep -Eq '^SESSION_COOKIE_SECURE=(true|"true")$' "${NEXT}"; then
  echo "Environment validation failed: SESSION_COOKIE_SECURE must be true for production" >&2
  exit 1
fi
if ! grep -Eq '^TRUST_PROXY=(true|"true")$' "${NEXT}"; then
  echo "Environment validation failed: TRUST_PROXY must be true for the supported reverse proxy deployment" >&2
  exit 1
fi
SCHEDULER_VALUE="$(sed -n 's/^REMINDER_SCHEDULER_ENABLED=//p' "${NEXT}" | tr -d '"')"
EVALUATOR_VALUE="$(sed -n 's/^CRITICAL_ALERT_EVALUATOR_ENABLED=//p' "${NEXT}" | tr -d '"')"
if [[ "${EVALUATOR_VALUE}" == "true" && "${SCHEDULER_VALUE}" != "true" ]]; then
  echo "Environment validation failed: CRITICAL_ALERT_EVALUATOR_ENABLED requires REMINDER_SCHEDULER_ENABLED" >&2
  exit 1
fi
chmod 0640 "${NEXT}"
mv "${NEXT}" "${TARGET}"
trap - EXIT
echo "REQUIRED_ENV_NAMES=PASS"
echo "RUNTIME_FLAG_CONFIGURATION=PASS"
echo "VPS_HOST=LOCALHOST_CONFIGURED"
