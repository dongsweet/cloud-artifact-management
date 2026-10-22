#!/usr/bin/env sh
set -eu

module="${1:-}"
case "$module" in
  edge) directory="${CAM_EDGE_DATA_DIR:-/var/lib/cloud-artifact-management/edge}" ;;
  core) directory="${CAM_CORE_DATA_DIR:-/var/lib/cloud-artifact-management/core}" ;;
  agent) directory="${CAM_AGENT_DATA_DIR:-/var/lib/cloud-artifact-management/agent}" ;;
  *) echo "Usage: $0 edge|core|agent" >&2; exit 2 ;;
esac

uid="${CAM_DATA_UID:-10001}"
gid="${CAM_DATA_GID:-10001}"
mkdir -p "$directory"
chown "$uid:$gid" "$directory"
chmod 0750 "$directory"
printf 'Ready %s data directory: %s (owner %s:%s)\n' "$module" "$directory" "$uid" "$gid"
