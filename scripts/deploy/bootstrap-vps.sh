#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
source "${SCRIPT_DIR}/deployment-config.sh"
load_deployment_config
require_deploy_user
NODE_VERSION="$(read_supported_node_version "${REPOSITORY_ROOT}/.node-version")"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo: sudo bash bootstrap-vps.sh" >&2
  exit 1
fi
if ! id "${DEPLOY_USER}" >/dev/null 2>&1; then
  echo "Deployment configuration error: DEPLOY_USER does not exist" >&2
  exit 1
fi

apt-get update
apt-get install -y --no-install-recommends ca-certificates curl xz-utils

if ! getent group "${APP_GROUP}" >/dev/null; then
  groupadd --system "${APP_GROUP}"
fi
if ! id "${APP_USER}" >/dev/null 2>&1; then
  useradd --system --gid "${APP_GROUP}" --home-dir "${APP_ROOT}" --shell /usr/sbin/nologin "${APP_USER}"
fi
usermod -aG "${APP_GROUP}",systemd-journal "${DEPLOY_USER}"

install -d -o "${APP_USER}" -g "${APP_GROUP}" -m 2775 "${APP_ROOT}" "${APP_ROOT}/releases"
install -d -o "${APP_USER}" -g "${APP_GROUP}" -m 2770 "${APP_ROOT}/shared"

case "$(uname -m)" in
  x86_64) NODE_PLATFORM="linux-x64" ;;
  aarch64|arm64) NODE_PLATFORM="linux-arm64" ;;
  *) echo "Unsupported Node.js deployment architecture: $(uname -m)" >&2; exit 1 ;;
esac
NODE_ARCHIVE="node-v${NODE_VERSION}-${NODE_PLATFORM}.tar.xz"
NODE_INSTALL_ROOT="/usr/local/lib/nodejs"
NODE_RELEASE_DIR="${NODE_INSTALL_ROOT}/node-v${NODE_VERSION}-${NODE_PLATFORM}"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TEMP_DIR}"' EXIT

if [[ ! -x "${NODE_RELEASE_DIR}/bin/node" ]]; then
  curl -fsSLO --output-dir "${TEMP_DIR}" "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}"
  curl -fsSLo "${TEMP_DIR}/SHASUMS256.txt" "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"
  (
    cd "${TEMP_DIR}"
    grep "  ${NODE_ARCHIVE}$" SHASUMS256.txt | sha256sum -c -
  )
  install -d -m 0755 "${NODE_INSTALL_ROOT}"
  tar -xJf "${TEMP_DIR}/${NODE_ARCHIVE}" -C "${NODE_INSTALL_ROOT}"
fi

ln -sfn "${NODE_RELEASE_DIR}/bin/node" /usr/local/bin/node
ln -sfn "${NODE_RELEASE_DIR}/bin/npm" /usr/local/bin/npm
ln -sfn "${NODE_RELEASE_DIR}/bin/npx" /usr/local/bin/npx
require_supported_node "${REPOSITORY_ROOT}/.node-version"

UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}"
SUDOERS_PATH="/etc/sudoers.d/${SERVICE_NAME%.service}-deploy"
render_systemd_unit >"${UNIT_PATH}"
render_deploy_sudoers >"${SUDOERS_PATH}"
chmod 0440 "${SUDOERS_PATH}"
visudo -cf "${SUDOERS_PATH}"

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"

echo "BOOTSTRAP=PASS"
node --version
npm --version
systemctl is-enabled "${SERVICE_NAME}"
