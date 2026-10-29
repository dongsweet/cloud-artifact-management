#!/usr/bin/env sh
set -eu

module="${1:-}"
case "$module" in
  edge)
    default_directory=/var/lib/cloud-artifact-management/edge
    legacy_directory="${CAM_EDGE_DATA_DIR:-}"
    ;;
  core)
    default_directory=/var/lib/cloud-artifact-management/core
    legacy_directory="${CAM_CORE_DATA_DIR:-}"
    ;;
  agent)
    default_directory=/var/lib/cloud-artifact-management/agent
    legacy_directory="${CAM_AGENT_DATA_DIR:-}"
    ;;
  *) echo "Usage: $0 edge|core|agent" >&2; exit 2 ;;
esac

directory="${CAM_DATA_DIR:-${legacy_directory:-$default_directory}}"

uid="${CAM_DATA_UID:-10001}"
gid="${CAM_DATA_GID:-10001}"
mkdir -p "$directory"
chown "$uid:$gid" "$directory"
chmod 0750 "$directory"
printf 'Ready %s data directory: %s (owner %s:%s)\n' "$module" "$directory" "$uid" "$gid"
