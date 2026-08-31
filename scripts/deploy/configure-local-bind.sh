#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="/opt/gwens-automation/shared/.env"

if grep -q '^HOST=' "${ENV_FILE}"; then
  sed -i 's/^HOST=.*/HOST="127.0.0.1"/' "${ENV_FILE}"
else
  printf '%s\n' 'HOST="127.0.0.1"' >>"${ENV_FILE}"
fi

grep -q '^HOST="127.0.0.1"$' "${ENV_FILE}"
grep -q '^TELEGRAM_POLLING_ENABLED="false"$' "${ENV_FILE}"
chmod 0640 "${ENV_FILE}"

echo "VPS_HOST=LOCALHOST_CONFIGURED"
echo "VPS_TELEGRAM_POLLING=OFF_CONFIRMED"
