#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/deployment-config.sh"
load_deployment_config
ENV_FILE="${APP_ROOT}/shared/.env"

if grep -q '^HOST=' "${ENV_FILE}"; then
  sed -i 's/^HOST=.*/HOST="127.0.0.1"/' "${ENV_FILE}"
else
  printf '%s\n' 'HOST="127.0.0.1"' >>"${ENV_FILE}"
fi

grep -q '^HOST="127.0.0.1"$' "${ENV_FILE}"
chmod 0640 "${ENV_FILE}"

echo "VPS_HOST=LOCALHOST_CONFIGURED"
