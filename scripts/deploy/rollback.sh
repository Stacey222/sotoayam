#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="/opt/gwens-automation"
PREVIOUS_FILE="${APP_ROOT}/shared/previous-release"

if [[ ! -f "${PREVIOUS_FILE}" ]]; then
  echo "No previous release is recorded" >&2
  exit 1
fi
PREVIOUS="$(cat "${PREVIOUS_FILE}")"
case "${PREVIOUS}" in
  "${APP_ROOT}/releases/"*) ;;
  *) echo "Recorded rollback target is outside the release directory" >&2; exit 1 ;;
esac
if [[ ! -d "${PREVIOUS}" ]]; then
  echo "Recorded rollback release does not exist" >&2
  exit 1
fi

CURRENT="$(readlink -f "${APP_ROOT}/current")"
ln -s "${PREVIOUS}" "${APP_ROOT}/current.next"
mv -Tf "${APP_ROOT}/current.next" "${APP_ROOT}/current"
printf '%s\n' "${CURRENT}" >"${PREVIOUS_FILE}"
sudo systemctl restart gwens-automation.service
curl -fsS http://127.0.0.1:3000/health >/dev/null
echo "ROLLBACK=PASS"
