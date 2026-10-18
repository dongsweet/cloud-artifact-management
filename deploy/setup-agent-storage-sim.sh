#!/usr/bin/env sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo sh deploy/setup-agent-storage-sim.sh" >&2
  exit 1
fi

base="${CAM_AGENT_SIM_STORAGE_ROOT:-/var/lib/cloud-artifact-management}"
size="${CAM_AGENT_SIM_STORAGE_SIZE:-20G}"

for number in 1 2; do
  image="$base/agent-$number.storage.img"
  directory="$base/agent-$number"
  mkdir -p "$directory"
  if mountpoint -q "$directory"; then
    echo "Already mounted: $directory"
    continue
  fi
  if [ ! -e "$image" ]; then
    truncate -s "$size" "$image"
    mkfs.ext4 -F -m 0 -L "CAM_AGENT_$number" "$image"
  elif ! blkid "$image" >/dev/null 2>&1; then
    echo "Refusing to format existing unrecognized file: $image" >&2
    exit 1
  fi
  if [ -n "$(find "$directory" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
    echo "Refusing to mount over non-empty directory: $directory" >&2
    exit 1
  fi
  mount -o loop "$image" "$directory"
  chown 10001:10001 "$directory"
  chmod 0750 "$directory"
  entry="$image $directory ext4 loop,nofail,x-systemd.device-timeout=10 0 2"
  if ! grep -Fqx "$entry" /etc/fstab; then echo "$entry" >> /etc/fstab; fi
  echo "Mounted $size simulated storage at $directory"
done
