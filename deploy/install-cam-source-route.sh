#!/usr/bin/env sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this installer as root" >&2
  exit 1
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
install -m 0755 "$SCRIPT_DIR/cam-source-route.sh" /usr/local/sbin/cam-source-route
install -m 0644 "$SCRIPT_DIR/cam-source-route.service" /etc/systemd/system/cam-source-route.service

if [ ! -e /etc/default/cam-source-route ]; then
  install -m 0644 /dev/null /etc/default/cam-source-route
  printf '%s\n' 'CAM_SOURCE_ROUTE_TARGETS=172.22.5.177/32 172.22.5.66/32' > /etc/default/cam-source-route
fi

systemctl daemon-reload
systemctl enable cam-source-route.service
systemctl restart cam-source-route.service
systemctl --no-pager --full status cam-source-route.service
