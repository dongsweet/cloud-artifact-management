#!/usr/bin/env sh
set -eu

ENV_FILE="${CAM_ENV_FILE:-}"
if [ -z "$ENV_FILE" ]; then
  ENV_FILE="/etc/cloud-artifact-management/.env"
fi
if [ ! -r "$ENV_FILE" ]; then
  echo "CAM environment file is not readable: $ENV_FILE" >&2
  exit 1
fi

ALLOWLIST=$(awk -F= '
  $1 == "CAM_SOURCE_ALLOWLIST" {
    sub(/^[^=]*=/, "")
    gsub(/^[[:space:]]+|[[:space:]]+$/, "")
    if (substr($0, 1, 1) == "\"" && substr($0, length($0), 1) == "\"") {
      $0 = substr($0, 2, length($0) - 2)
    }
    print
    exit
  }
' "$ENV_FILE")
if [ -z "$ALLOWLIST" ]; then
  echo "CAM_SOURCE_ALLOWLIST is empty in $ENV_FILE" >&2
  exit 1
fi

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

seen=" "
new_targets=""
for host in $(printf '%s' "$ALLOWLIST" | tr ',' ' '); do
  case "$host" in
    ''|*'*'*)
      echo "Cannot derive a host route from allowlist entry: $host" >&2
      exit 1
      ;;
  esac
  addresses=$(getent ahostsv4 "$host" 2>/dev/null | awk '{print $1}' | sort -u)
  if [ -z "$addresses" ]; then
    echo "Unable to resolve allowlist host: $host" >&2
    exit 1
  fi
  for address in $addresses; do
    case "$seen" in *" $address "*) continue ;; esac
    seen="$seen$address "
    target="$address/32"
    new_targets="$new_targets$target\n"
    ip route replace "$target" via "$GATEWAY" dev "$INTERFACE"
    echo "[cam-source-route] route installed: $target via $GATEWAY dev $INTERFACE"
  done
done

STATE_DIR="${CAM_SOURCE_ROUTE_STATE_DIR:-/var/lib/cam-source-route}"
STATE_FILE="$STATE_DIR/targets"
mkdir -p "$STATE_DIR"
if [ -r "$STATE_FILE" ]; then
  while IFS= read -r old_target; do
    [ -n "$old_target" ] || continue
    case "$new_targets" in
      *"$old_target"*) ;;
      *) ip route del "$old_target" via "$GATEWAY" dev "$INTERFACE" 2>/dev/null || true
         echo "[cam-source-route] stale route removed: $old_target" ;;
    esac
  done < "$STATE_FILE"
fi
printf '%b' "$new_targets" > "$STATE_FILE.tmp"
mv "$STATE_FILE.tmp" "$STATE_FILE"
