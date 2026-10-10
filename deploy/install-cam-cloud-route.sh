#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ENV_FILE=${CAM_ENV_FILE:-"$SCRIPT_DIR/.env"}

install -m 0755 "$SCRIPT_DIR/cam-cloud-route.sh" /usr/local/sbin/cam-cloud-route
install -m 0644 "$SCRIPT_DIR/cam-cloud-route.service" /etc/systemd/system/cam-cloud-route.service
install -m 0644 /dev/null /etc/default/cam-cloud-route
printf 'CAM_ENV_FILE=%s\n' "$ENV_FILE" > /etc/default/cam-cloud-route

systemctl daemon-reload
systemctl enable cam-cloud-route.service
systemctl restart cam-cloud-route.service
systemctl --no-pager --full status cam-cloud-route.service
