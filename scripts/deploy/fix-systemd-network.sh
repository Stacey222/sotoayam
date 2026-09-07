#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/deployment-config.sh"
load_deployment_config
UNIT="/etc/systemd/system/${SERVICE_NAME}"
if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo" >&2
  exit 1
fi
grep -q '^RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6$' "${UNIT}"
sed -i 's/^RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6$/RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK/' "${UNIT}"
systemctl daemon-reload
systemctl reset-failed "${SERVICE_NAME}"
echo "SYSTEMD_NETWORK_FAMILY_FIX=PASS"
