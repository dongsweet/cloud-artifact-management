#!/usr/bin/env sh
set -eu

uid="${CAM_DATA_UID:-10001}"
gid="${CAM_DATA_GID:-10001}"

for directory in \
  "${CAM_EDGE_DATA_DIR:-/var/lib/cloud-artifact-management/edge}" \
  "${CAM_CORE_DATA_DIR:-/var/lib/cloud-artifact-management/core}" \
  "${CAM_AGENT_DATA_DIR:-/var/lib/cloud-artifact-management/agent}"; do
  mkdir -p "$directory"
  chown "$uid:$gid" "$directory"
  chmod 0750 "$directory"
  printf 'Ready host data directory: %s\n' "$directory"
done
