#!/usr/bin/env sh
set -eu

version="${1:-}"
output_root="${2:-.}"
source_tag="${3:-dev}"
if [ -z "$version" ]; then
  echo "Usage: $0 <version> [output-root] [source-tag]" >&2
  exit 2
fi
case "$version" in
  *[!A-Za-z0-9._-]*) echo "Invalid version: $version" >&2; exit 2 ;;
esac

output_dir="$output_root/v$version"
mkdir -p "$output_dir"

for module in edge core agent; do
  source_backend="cam-$module:$source_tag"
  backend="cam-backend:$version"
  web="cam-$module-web:$version"
  source_web="cam-$module-web:$source_tag"

  docker image inspect "$source_backend" >/dev/null
  docker image inspect "$source_web" >/dev/null
  docker tag "$source_backend" "$backend"
  docker tag "$source_web" "$web"

  archive="$output_dir/cam-$module-images-$version.tar"
  checksum="$archive.sha256"
  manifest="$output_dir/cam-$module-images-$version.manifest.txt"
  docker save -o "$archive" "$backend" "$web"
  sha256sum "$archive" > "$checksum"
  docker image inspect "$backend" "$web" \
    --format '[{{index .RepoTags 0}}] {{.Id}} {{.Size}}' > "$manifest"
  printf 'Created %s\n' "$archive"
done
