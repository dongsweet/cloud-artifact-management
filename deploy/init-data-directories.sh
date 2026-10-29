#!/usr/bin/env sh
set -eu

uid="${CAM_DATA_UID:-10001}"
gid="${CAM_DATA_GID:-10001}"
data_root="${CAM_DATA_ROOT_DIR:-/var/lib/cloud-artifact-management}"

for directory in \
  "$data_root/edge" \
  "$data_root/core" \
  "$data_root/agent-1" \
  "$data_root/agent-2"; do
  mkdir -p "$directory"
  chown "$uid:$gid" "$directory"
  chmod 0750 "$directory"
  printf 'Ready host data directory: %s\n' "$directory"
done
