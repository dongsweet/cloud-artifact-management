#!/usr/bin/env sh
set -eu

TARGETS="${CAM_SOURCE_ROUTE_TARGETS:-172.22.5.177/32 172.22.5.66/32}"
GATEWAY="${CAM_SOURCE_ROUTE_GATEWAY:-}"
INTERFACE="${CAM_SOURCE_ROUTE_INTERFACE:-}"

if [ -z "$GATEWAY" ] || [ -z "$INTERFACE" ]; then
  set -- $(ip -4 route show default | awk 'NR == 1 { for (i = 1; i <= NF; i++) { if ($i == "via") gateway = $(i + 1); if ($i == "dev") interface = $(i + 1) } } END { print gateway, interface }')
  GATEWAY="${GATEWAY:-${1:-}}"
  INTERFACE="${INTERFACE:-${2:-}}"
fi

if [ -z "$GATEWAY" ] || [ -z "$INTERFACE" ]; then
  echo "Unable to determine the host default gateway and interface" >&2
  exit 1
fi

for target in $TARGETS; do
  ip route replace "$target" via "$GATEWAY" dev "$INTERFACE"
  echo "[cam-source-route] route installed: $target via $GATEWAY dev $INTERFACE"
done
