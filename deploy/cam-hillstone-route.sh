#!/bin/sh
set -eu

NETWORK="${CAM_HILLSTONE_NETWORK:-cloud-artifact-management_default}"
CONTAINER="${CAM_HILLSTONE_CONTAINER:-cam-hillstone-vpn}"
TARGETS="${CAM_HILLSTONE_ROUTE_TARGETS:-172.22.5.177/32 172.22.5.66/32}"
WAIT_SECONDS="${CAM_HILLSTONE_ROUTE_WAIT_SECONDS:-180}"

log() { echo "[cam-hillstone-route] $*"; }

for attempt in $(seq 1 "$WAIT_SECONDS"); do
  network_id=$(docker network inspect "$NETWORK" -f '{{.Id}}' 2>/dev/null || true)
  vpn_ip=$(docker inspect "$CONTAINER" -f "{{with index .NetworkSettings.Networks \"$NETWORK\"}}{{.IPAddress}}{{end}}" 2>/dev/null || true)
  bridge=''

  if [ -n "$network_id" ]; then
    prefix=$(printf '%s' "$network_id" | cut -c1-12)
    if ip link show "br-$prefix" >/dev/null 2>&1; then
      bridge="br-$prefix"
    fi
  fi

  if [ -n "$bridge" ] && [ -n "$vpn_ip" ]; then
    for target in $TARGETS; do
      ip route replace "$target" via "$vpn_ip" dev "$bridge"
      log "route installed: $target via $vpn_ip dev $bridge (network=$NETWORK id=$network_id)"
    done
    exit 0
  fi

  sleep 1
done

echo "Docker network bridge or $CONTAINER IP was not available after ${WAIT_SECONDS}s" >&2
exit 1
