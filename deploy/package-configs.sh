#!/usr/bin/env sh
set -eu

version="${1:-}"
output_root="${2:-.}"
if [ -z "$version" ]; then
  echo "Usage: $0 <version> [output-root]" >&2
  exit 2
fi
case "$version" in
  *[!A-Za-z0-9._-]*) echo "Invalid version: $version" >&2; exit 2 ;;
esac

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
output_dir="$output_root/v$version"
mkdir -p "$output_dir"

tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM

for module in edge core agent; do
  package_dir="$tmp_dir/cam-$module-config-$version"
  mkdir -p "$package_dir"
  cp "$script_dir/compose.$module.yaml" "$package_dir/"
  cp "$script_dir/$module.env.example" "$package_dir/$module.env"
  if [ "$module" = edge ]; then cp "$repo_dir/apps/cam-edge/src/bootstrap-gate.js" "$package_dir/"; fi
  module_upper=$(printf '%s' "$module" | tr '[:lower:]' '[:upper:]')
  # The source templates carry the repository's current development baseline.
  # A delivered config package must point at the same version as its archive.
  sed -i -E "s|^(CAM_${module_upper}_IMAGE=cam-backend:).*|\\1$version|" "$package_dir/$module.env"
  sed -i -E "s|^(CAM_${module_upper}_WEB_IMAGE=cam-${module}-web:).*|\\1$version|" "$package_dir/$module.env"
  cp "$script_dir/init-module-data.sh" "$package_dir/"
  cp "$script_dir/module-package-readme.md" "$package_dir/README.md"
  printf '%s\n' "$version" > "$package_dir/VERSION"

  archive="$output_dir/cam-$module-config-$version.tar"
  checksum="$archive.sha256"
  tar -C "$tmp_dir" -cf "$archive" "cam-$module-config-$version"
  sha256sum "$archive" > "$checksum"
  printf 'Created %s\n' "$archive"
done
