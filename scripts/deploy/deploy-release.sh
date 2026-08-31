#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 2 ]]; then
  echo "Usage: deploy-release.sh <archive.tar.gz> <release-id>" >&2
  exit 1
fi

ARCHIVE="$1"
RELEASE_ID="$2"
APP_ROOT="/opt/gwens-automation"
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

umask 0027
mkdir -p "${RELEASE_DIR}"
tar -xzf "${ARCHIVE}" -C "${RELEASE_DIR}"
(
  cd "${RELEASE_DIR}"
  npm ci --omit=dev --ignore-scripts
)

if [[ -L "${APP_ROOT}/current" ]]; then
  readlink -f "${APP_ROOT}/current" >"${APP_ROOT}/shared/previous-release"
fi
ln -s "${RELEASE_DIR}" "${APP_ROOT}/current.next"
mv -Tf "${APP_ROOT}/current.next" "${APP_ROOT}/current"

echo "DEPLOYED_RELEASE=${RELEASE_ID}"
