#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: dispatch-cli-release-archive.sh <version>" >&2
  exit 1
fi

version="${1#v}"
tag="v$version"

if [[ -z "${GH_TOKEN:-}" ]]; then
  echo "GH_TOKEN is required" >&2
  exit 1
fi

git fetch origin --tags >/dev/null 2>&1 || true

if git ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null 2>&1; then
  echo "Tag $tag already exists on origin."
else
  git config user.name "github-actions[bot]"
  git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
  git tag -a "$tag" "${GITHUB_SHA:-HEAD}" -m "release $version"
  git push origin "refs/tags/$tag"
fi

gh workflow run cli-release-archives.yml --ref main -f version="$version" -f publish_release=true
echo "Dispatched cli-release-archives.yml for $version"
