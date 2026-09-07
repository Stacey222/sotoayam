#!/usr/bin/env bash

SOTOAYAM_DEFAULT_APP_ROOT="/opt/sotoayam"
SOTOAYAM_DEFAULT_APP_USER="sotoayam"
SOTOAYAM_DEFAULT_APP_GROUP="sotoayam"
SOTOAYAM_DEFAULT_SERVICE_NAME="sotoayam.service"
SOTOAYAM_DEFAULT_HEALTH_PORT="3000"

deployment_config_error() {
  echo "Deployment configuration error: $1" >&2
  return 1
}

load_deployment_config() {
  if [[ ${APP_ROOT+x} == x && -z "${APP_ROOT}" ]]; then
    deployment_config_error "APP_ROOT must not be empty"
    return 1
  fi

  APP_ROOT="${APP_ROOT:-${SOTOAYAM_DEFAULT_APP_ROOT}}"
  APP_USER="${APP_USER:-${SOTOAYAM_DEFAULT_APP_USER}}"
  APP_GROUP="${APP_GROUP:-${SOTOAYAM_DEFAULT_APP_GROUP}}"
  SERVICE_NAME="${SERVICE_NAME:-${SOTOAYAM_DEFAULT_SERVICE_NAME}}"
  HEALTH_PORT="${HEALTH_PORT:-${SOTOAYAM_DEFAULT_HEALTH_PORT}}"

  if [[ "${APP_ROOT}" != /* || "${APP_ROOT}" == "/" || "${APP_ROOT}" == */ || "${APP_ROOT}" == *"//"* || "${APP_ROOT}" == *"/./"* || "${APP_ROOT}" == *"/../"* || "${APP_ROOT}" == */.. || "${APP_ROOT}" =~ [[:space:]] ]]; then
    deployment_config_error "APP_ROOT must be a safe absolute Unix path other than /"
    return 1
  fi
  if [[ ! "${APP_ROOT}" =~ ^/[A-Za-z0-9._/-]+$ ]]; then
    deployment_config_error "APP_ROOT contains unsupported characters"
    return 1
  fi
  if [[ ! "${APP_USER}" =~ ^[a-z_][a-z0-9_-]*$ || "${APP_USER}" == "root" ]]; then
    deployment_config_error "APP_USER must be a non-root Linux account name"
    return 1
  fi
  if [[ ! "${APP_GROUP}" =~ ^[a-z_][a-z0-9_-]*$ || "${APP_GROUP}" == "root" ]]; then
    deployment_config_error "APP_GROUP must be a non-root Linux group name"
    return 1
  fi
  if [[ ! "${SERVICE_NAME}" =~ ^[A-Za-z0-9_.@-]+\.service$ ]]; then
    deployment_config_error "SERVICE_NAME must be a systemd .service unit name without a path"
    return 1
  fi
  if [[ ! "${HEALTH_PORT}" =~ ^[1-9][0-9]{0,4}$ ]] || (( 10#${HEALTH_PORT} > 65535 )); then
    deployment_config_error "HEALTH_PORT must be an integer from 1 through 65535"
    return 1
  fi

  export APP_ROOT APP_USER APP_GROUP SERVICE_NAME HEALTH_PORT
}

require_deploy_user() {
  if [[ -z "${DEPLOY_USER:-}" ]]; then
    deployment_config_error "DEPLOY_USER is required"
    return 1
  fi
  if [[ ! "${DEPLOY_USER}" =~ ^[a-z_][a-z0-9_-]*$ || "${DEPLOY_USER}" == "root" ]]; then
    deployment_config_error "DEPLOY_USER must be an existing non-root Linux account name"
    return 1
  fi
  if [[ "${DEPLOY_USER}" == "${APP_USER}" ]]; then
    deployment_config_error "DEPLOY_USER and APP_USER must be separate accounts"
    return 1
  fi
  export DEPLOY_USER
}

read_supported_node_version() {
  local version_file="$1"
  local version
  if [[ ! -f "${version_file}" ]]; then
    deployment_config_error "Node version file is missing: ${version_file}"
    return 1
  fi
  version="$(tr -d '\r\n' <"${version_file}")"
  if [[ ! "${version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    deployment_config_error "Node version pin must use MAJOR.MINOR.PATCH"
    return 1
  fi
  printf '%s\n' "${version}"
}

require_supported_node() {
  local version_file="$1"
  local expected actual
  expected="v$(read_supported_node_version "${version_file}")" || return 1
  if ! command -v node >/dev/null 2>&1; then
    deployment_config_error "Node.js ${expected} is required but node is unavailable"
    return 1
  fi
  actual="$(node --version 2>/dev/null)" || {
    deployment_config_error "Unable to determine the installed Node.js version"
    return 1
  }
  if [[ "${actual}" != "${expected}" ]]; then
    deployment_config_error "Unsupported Node.js version ${actual}; required ${expected}"
    return 1
  fi
}

render_systemd_unit() {
  cat <<UNIT
[Unit]
Description=Sotoayam
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=${APP_USER}
Group=${APP_GROUP}
WorkingDirectory=${APP_ROOT}/current
Environment=NODE_ENV=production
EnvironmentFile=${APP_ROOT}/shared/.env
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
}

render_deploy_sudoers() {
  cat <<SUDOERS
${DEPLOY_USER} ALL=(root) NOPASSWD: /usr/bin/systemctl start ${SERVICE_NAME}, /usr/bin/systemctl stop ${SERVICE_NAME}, /usr/bin/systemctl restart ${SERVICE_NAME}, /usr/bin/systemctl status ${SERVICE_NAME}, /usr/bin/systemctl is-active ${SERVICE_NAME}, /usr/bin/systemctl is-enabled ${SERVICE_NAME}
SUDOERS
}
