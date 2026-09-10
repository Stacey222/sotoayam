#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/deployment-config.sh"
load_deployment_config
TARGET="${APP_ROOT}/shared/.env"
NEXT="${TARGET}.next"
REQUIRED=(
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
  TELEGRAM_BOT_TOKEN
  INTERNAL_API_KEY
  INTERNAL_API_KEY_FALLBACK_ENABLED
  ADMIN_API_KEY_FALLBACK_ENABLED
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
tr -d '\r' >"${NEXT}"
test -s "${NEXT}"
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
for name in TELEGRAM_POLLING_ENABLED REMINDER_SCHEDULER_ENABLED CRITICAL_ALERT_EVALUATOR_ENABLED INTERNAL_API_KEY_FALLBACK_ENABLED ADMIN_API_KEY_FALLBACK_ENABLED; do
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
SCHEDULER_VALUE="$(sed -n 's/^REMINDER_SCHEDULER_ENABLED=//p' "${NEXT}" | tr -d '"')"
EVALUATOR_VALUE="$(sed -n 's/^CRITICAL_ALERT_EVALUATOR_ENABLED=//p' "${NEXT}" | tr -d '"')"
if [[ "${EVALUATOR_VALUE}" == "true" && "${SCHEDULER_VALUE}" != "true" ]]; then
  echo "Environment validation failed: CRITICAL_ALERT_EVALUATOR_ENABLED requires REMINDER_SCHEDULER_ENABLED" >&2
  exit 1
fi
chmod 0640 "${NEXT}"
mv "${NEXT}" "${TARGET}"
echo "REQUIRED_ENV_NAMES=PASS"
echo "RUNTIME_FLAG_CONFIGURATION=PASS"
echo "VPS_HOST=LOCALHOST_CONFIGURED"
