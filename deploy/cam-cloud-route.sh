#!/bin/sh
set -eu

# Test-environment route helper for a core container joined to an existing
# Docker network whose gateway container owns the VPN tunnel. The route is
# installed inside cam-core's network namespace, so the application uses
# ordinary TCP/TLS without an HTTP proxy.
ENV_FILE="${CAM_ENV_FILE:-}"
if [ -n "$ENV_FILE" ] && [ -r "$ENV_FILE" ]; then
  set -a
  # The deployment .env is operator-controlled configuration, not remote data.
  . "$ENV_FILE"
  set +a
fi

NETWORK="${CAM_CLOUD_ROUTE_NETWORK:-cloud-growth-tracker_default}"
CORE_CONTAINER="${CAM_CLOUD_ROUTE_CORE_CONTAINER:-cloud-artifact-management-cam-core-1}"
GATEWAY_CONTAINER="${CAM_CLOUD_ROUTE_GATEWAY_CONTAINER:-easyconnect-vpn}"
TARGETS="${CAM_CLOUD_ROUTE_TARGETS:-100.127.2.101/32}"
WAIT_SECONDS="${CAM_CLOUD_ROUTE_WAIT_SECONDS:-180}"
CHECK_INTERVAL="${CAM_CLOUD_ROUTE_CHECK_INTERVAL:-10}"

log() { echo "[cam-cloud-route] $*"; }

install_routes() {
  core_pid=$(docker inspect "$CORE_CONTAINER" -f '{{.State.Pid}}' 2>/dev/null || true)
  gateway_ip=$(docker inspect "$GATEWAY_CONTAINER" -f "{{with index .NetworkSettings.Networks \"$NETWORK\"}}{{.IPAddress}}{{end}}" 2>/dev/null || true)
  [ -n "$core_pid" ] && [ "$core_pid" != "0" ] && [ -n "$gateway_ip" ] || return 1

  route_info=$(nsenter -t "$core_pid" -n ip -4 route get "$gateway_ip" 2>/dev/null || true)
  interface=$(printf '%s\n' "$route_info" | awk '{ for (i = 1; i <= NF; i++) if ($i == "dev") { print $(i + 1); exit } }')
  [ -n "$interface" ] || return 1

  for target in $TARGETS; do
    nsenter -t "$core_pid" -n ip route replace "$target" via "$gateway_ip" dev "$interface"
    log "route installed: $target via $gateway_ip dev $interface"
  done
}

while :; do
  installed=0
  for attempt in $(seq 1 "$WAIT_SECONDS"); do
    if install_routes; then
      installed=1
      break
    fi
    sleep 1
  done

  if [ "$installed" -eq 0 ]; then
    log "Docker containers or network were not ready after ${WAIT_SECONDS}s"
  fi
  sleep "$CHECK_INTERVAL"
done
