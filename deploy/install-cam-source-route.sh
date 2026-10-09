#!/usr/bin/env sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this installer as root" >&2
  exit 1
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
ENV_FILE="${CAM_ENV_FILE:-$PROJECT_DIR/.env}"
install -m 0755 "$SCRIPT_DIR/cam-source-route.sh" /usr/local/sbin/cam-source-route
install -m 0644 "$SCRIPT_DIR/cam-source-route.service" /etc/systemd/system/cam-source-route.service

install -m 0644 /dev/null /etc/default/cam-source-route
printf 'CAM_ENV_FILE=%s\n' "$ENV_FILE" > /etc/default/cam-source-route

systemctl daemon-reload
systemctl enable cam-source-route.service
systemctl restart cam-source-route.service
systemctl --no-pager --full status cam-source-route.service
