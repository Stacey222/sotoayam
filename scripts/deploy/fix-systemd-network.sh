#!/usr/bin/env bash
set -euo pipefail

UNIT="/etc/systemd/system/gwens-automation.service"
if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo" >&2
  exit 1
fi
grep -q '^RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6$' "${UNIT}"
sed -i 's/^RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6$/RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK/' "${UNIT}"
systemctl daemon-reload
systemctl reset-failed gwens-automation.service
echo "SYSTEMD_NETWORK_FAMILY_FIX=PASS"
