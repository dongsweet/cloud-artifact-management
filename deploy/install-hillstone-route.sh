#!/bin/sh
set -eu

install -m 0755 cam-hillstone-route.sh /usr/local/sbin/cam-hillstone-route
install -m 0644 cam-hillstone-route.service /etc/systemd/system/cam-hillstone-route.service
systemctl daemon-reload
systemctl enable cam-hillstone-route.service
systemctl restart cam-hillstone-route.service
systemctl --no-pager --full status cam-hillstone-route.service
