#!/bin/sh
set -eu

install -m 0644 cam-hillstone-netfilter.conf /etc/modules-load.d/cam-hillstone-netfilter.conf
modprobe ip_tables
modprobe iptable_filter
modprobe iptable_nat
modprobe iptable_mangle

install -m 0755 cam-hillstone-route.sh /usr/local/sbin/cam-hillstone-route
install -m 0644 cam-hillstone-route.service /etc/systemd/system/cam-hillstone-route.service
systemctl daemon-reload
systemctl enable cam-hillstone-route.service
systemctl restart systemd-modules-load.service
systemctl restart cam-hillstone-route.service
systemctl --no-pager --full status cam-hillstone-route.service
