#!/usr/bin/env bash
set -euo pipefail

# Agent-launched local shells often inherit live daemon state. The release
# verification should exercise packages from a clean environment, matching CI.
while IFS='=' read -r name _; do
  case "$name" in
    CONDUCTOR_*)
      unset "$name"
      ;;
  esac
done < <(env)

tmp_home="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_home"
}
trap cleanup EXIT

export HOME="$tmp_home"
export USERPROFILE="$tmp_home"

npm run build --workspace @love-moon/ai-sdk
npm run test --workspace @love-moon/ai-sdk
npm run build --workspace @love-moon/ai-manager
npm run test --workspace @love-moon/ai-manager
npm run build --workspace @love-moon/app-sdk
npm run test --workspace @love-moon/app-sdk
npm run test:bundle --workspace @love-moon/app-sdk
npm run build --workspace @love-moon/conductor-sdk
npm run test --workspace @love-moon/conductor-sdk

node cli/bin/conductor.js --version >/dev/null
node cli/bin/conductor.js --help >/dev/null
