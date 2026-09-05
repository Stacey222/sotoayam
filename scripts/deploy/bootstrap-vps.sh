#!/usr/bin/env bash
set -euo pipefail

DEPLOY_USER="${SUDO_USER:-karburontok3}"
APP_USER="gwens"
APP_GROUP="gwens"
APP_ROOT="/opt/gwens-automation"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo: sudo bash bootstrap-vps.sh" >&2
  exit 1
fi

apt-get update
apt-get install -y --no-install-recommends ca-certificates curl xz-utils python3

if ! getent group "${APP_GROUP}" >/dev/null; then
  groupadd --system "${APP_GROUP}"
fi
if ! id "${APP_USER}" >/dev/null 2>&1; then
  useradd --system --gid "${APP_GROUP}" --home-dir "${APP_ROOT}" --shell /usr/sbin/nologin "${APP_USER}"
fi
usermod -aG "${APP_GROUP}",systemd-journal "${DEPLOY_USER}"

install -d -o "${APP_USER}" -g "${APP_GROUP}" -m 2775 "${APP_ROOT}" "${APP_ROOT}/releases"
install -d -o "${APP_USER}" -g "${APP_GROUP}" -m 2770 "${APP_ROOT}/shared"

NODE_VERSION="$(curl -fsSL https://nodejs.org/dist/index.json | python3 -c 'import json,sys; print(next(item["version"] for item in json.load(sys.stdin) if item["version"].startswith("v24.") and item["lts"]))')"
NODE_ARCHIVE="node-${NODE_VERSION}-linux-x64.tar.xz"
NODE_INSTALL_ROOT="/usr/local/lib/nodejs"
NODE_RELEASE_DIR="${NODE_INSTALL_ROOT}/node-${NODE_VERSION}-linux-x64"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TEMP_DIR}"' EXIT

if [[ ! -x "${NODE_RELEASE_DIR}/bin/node" ]]; then
  curl -fsSLO --output-dir "${TEMP_DIR}" "https://nodejs.org/dist/${NODE_VERSION}/${NODE_ARCHIVE}"
  curl -fsSLo "${TEMP_DIR}/SHASUMS256.txt" "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt"
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

cat >/etc/systemd/system/gwens-automation.service <<'UNIT'
[Unit]
Description=Sotoayam
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=gwens
Group=gwens
WorkingDirectory=/opt/gwens-automation/current
Environment=NODE_ENV=production
EnvironmentFile=/opt/gwens-automation/shared/.env
ExecStart=/usr/local/bin/node dist/src/server.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
KillSignal=SIGTERM
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK

[Install]
WantedBy=multi-user.target
UNIT

cat >/etc/sudoers.d/gwens-automation-deploy <<EOF
${DEPLOY_USER} ALL=(root) NOPASSWD: /usr/bin/systemctl start gwens-automation.service, /usr/bin/systemctl stop gwens-automation.service, /usr/bin/systemctl restart gwens-automation.service, /usr/bin/systemctl status gwens-automation.service, /usr/bin/systemctl is-active gwens-automation.service, /usr/bin/systemctl is-enabled gwens-automation.service
EOF
chmod 0440 /etc/sudoers.d/gwens-automation-deploy
visudo -cf /etc/sudoers.d/gwens-automation-deploy

systemctl daemon-reload
systemctl enable gwens-automation.service

echo "BOOTSTRAP=PASS"
node --version
npm --version
systemctl is-enabled gwens-automation.service
