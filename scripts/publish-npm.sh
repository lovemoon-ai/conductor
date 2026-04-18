#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
NPM_REGISTRY=${NPM_REGISTRY:-https://registry.npmjs.org}

get_current_version() {
  local package_json_path=$1
  node -e '
    const fs = require("fs");
    const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    console.log(pkg.version);
  ' "$package_json_path"
}

increment_patch() {
  local version=$1
  local major=$(echo "$version" | cut -d. -f1)
  local minor=$(echo "$version" | cut -d. -f2)
  local patch=$(echo "$version" | cut -d. -f3)
  echo "${major}.${minor}.$((patch + 1))"
}

SDK_PACKAGE_JSON="$ROOT_DIR/modules/conductor-sdk/package.json"
CURRENT_VERSION=$(get_current_version "$SDK_PACKAGE_JSON")

if [[ $# -lt 1 ]]; then
  TARGET_VERSION=$(increment_patch "$CURRENT_VERSION")
  echo "No version specified. Auto-incrementing patch version."
  echo "Current: ${CURRENT_VERSION}"
  echo "Target:  ${TARGET_VERSION}"
  echo ""
  read -p "Proceed with ${TARGET_VERSION}? [Y/n] " answer
  if [[ -n "${answer:-}" && "${answer:-}" != "y" && "${answer:-}" != "Y" ]]; then
    echo "Aborted."
    exit 1
  fi
else
  TARGET_VERSION=$1
fi

TARGET_VERSION=$TARGET_VERSION

echo "Publishing version: ${TARGET_VERSION}"

update_package_json_version() {
  local package_json_path=$1
  local version=$2
  local commit_id=${3:-}
  # If commit_id not provided, get from git
  if [[ -z "$commit_id" ]]; then
    commit_id=$(cd "$ROOT_DIR" && git rev-parse --short HEAD)
  fi
  node -e '
    const fs = require("fs");
    const path = process.argv[1];
    const version = process.argv[2];
    const commitId = process.argv[3];
    const pkg = JSON.parse(fs.readFileSync(path, "utf8"));
    pkg.version = version;
    if (commitId) pkg.gitCommitId = commitId;
    fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
  ' "$package_json_path" "$version" "$commit_id"
}

update_cli_dependencies() {
  local package_json_path=$1
  local version=$2
  node -e '
    const fs = require("fs");
    const path = process.argv[1];
    const version = process.argv[2];
    const pkg = JSON.parse(fs.readFileSync(path, "utf8"));
    pkg.dependencies = pkg.dependencies || {};
    pkg.dependencies["@love-moon/ai-sdk"] = version;
    pkg.dependencies["@love-moon/conductor-sdk"] = version;
    pkg.dependencies["@love-moon/ai-manager"] = version;
    delete pkg.dependencies["@love-moon/tui-driver"];
    fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
  ' "$package_json_path" "$version"
}

TMP_NPMRC=""
cleanup() {
  if [[ -n "$TMP_NPMRC" ]]; then
    rm -f "$TMP_NPMRC"
  fi
}
trap cleanup EXIT

CLI_PACKAGE_JSON="$ROOT_DIR/cli/package.json"
AI_SDK_PACKAGE_JSON="$ROOT_DIR/modules/ai-sdk/package.json"
SDK_PACKAGE_JSON="$ROOT_DIR/modules/conductor-sdk/package.json"
AI_MANAGER_PACKAGE_JSON="$ROOT_DIR/modules/ai-manager/package.json"

echo "Updating package versions to ${TARGET_VERSION}..."
update_package_json_version "$AI_SDK_PACKAGE_JSON" "$TARGET_VERSION"
update_package_json_version "$SDK_PACKAGE_JSON" "$TARGET_VERSION"
update_package_json_version "$AI_MANAGER_PACKAGE_JSON" "$TARGET_VERSION"
update_package_json_version "$CLI_PACKAGE_JSON" "$TARGET_VERSION"
update_cli_dependencies "$CLI_PACKAGE_JSON" "$TARGET_VERSION"

if [[ -n "${NPM_TOKEN:-}" ]]; then
  TMP_NPMRC=$(mktemp)
  printf "//registry.npmjs.org/:_authToken=%s\n" "$NPM_TOKEN" > "$TMP_NPMRC"
  printf "registry=%s\n" "$NPM_REGISTRY" >> "$TMP_NPMRC"
  export NPM_CONFIG_USERCONFIG="$TMP_NPMRC"
else
  npm whoami --registry="$NPM_REGISTRY" >/dev/null
fi

DRY_RUN=${DRY_RUN:-0}
PUBLISH_FLAGS=(--access public --registry="$NPM_REGISTRY")
if [[ -n "${NPM_OTP:-}" ]]; then
  PUBLISH_FLAGS+=(--otp "$NPM_OTP")
fi
if [[ "$DRY_RUN" == "1" ]]; then
  PUBLISH_FLAGS+=(--dry-run)
fi

publish_with_build() {
  local package_dir=$1
  (
    cd "$ROOT_DIR/$package_dir"
    echo "==> Preparing ${package_dir}"
    if [[ -f "pnpm-lock.yaml" ]] && command -v pnpm >/dev/null 2>&1; then
      pnpm install
      pnpm run build
    else
      npm install
      npm run build
    fi
    echo "==> Publishing ${package_dir}"
    if ! npm publish "${PUBLISH_FLAGS[@]}"; then
      echo "npm publish failed for ${package_dir}, continuing"
    fi
  )
}

publish_simple() {
  local package_dir=$1
  (
    cd "$ROOT_DIR/$package_dir"
    echo "==> Publishing ${package_dir}"
    if ! npm publish "${PUBLISH_FLAGS[@]}"; then
      echo "npm publish failed for ${package_dir}, continuing"
    fi
  )
}

publish_with_build "modules/ai-sdk"
publish_with_build "modules/conductor-sdk"
publish_with_build "modules/ai-manager"
publish_simple "cli"
