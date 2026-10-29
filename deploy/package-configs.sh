#!/usr/bin/env sh
set -eu

version="${1:-}"
output_dir="${2:-.}"
if [ -z "$version" ]; then
  echo "Usage: $0 <version> [output-dir]" >&2
  exit 2
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
mkdir -p "$output_dir"

tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM

for module in edge core agent; do
  package_dir="$tmp_dir/cam-$module-config-$version"
  mkdir -p "$package_dir"
  cp "$script_dir/compose.$module.yaml" "$package_dir/"
  cp "$script_dir/$module.env.example" "$package_dir/$module.env"
  cp "$script_dir/init-module-data.sh" "$package_dir/"
  cp "$script_dir/module-package-readme.md" "$package_dir/README.md"
  printf '%s\n' "$version" > "$package_dir/VERSION"

  archive="$output_dir/cam-$module-config-$version.tar"
  checksum="$archive.sha256"
  tar -C "$tmp_dir" -cf "$archive" "cam-$module-config-$version"
  sha256sum "$archive" > "$checksum"
  printf 'Created %s\n' "$archive"
done
