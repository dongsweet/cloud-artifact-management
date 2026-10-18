#!/usr/bin/env sh
set -eu

uid="${CAM_DATA_UID:-10001}"
gid="${CAM_DATA_GID:-10001}"

for directory in \
  "${CAM_EDGE_DATA_DIR:-/var/lib/cloud-artifact-management/edge}" \
  "${CAM_CORE_DATA_DIR:-/var/lib/cloud-artifact-management/core}" \
  "${CAM_AGENT_1_DATA_DIR:-/var/lib/cloud-artifact-management/agent-1}" \
  "${CAM_AGENT_2_DATA_DIR:-/var/lib/cloud-artifact-management/agent-2}"; do
  mkdir -p "$directory"
  chown "$uid:$gid" "$directory"
  chmod 0750 "$directory"
  printf 'Ready host data directory: %s\n' "$directory"
done
