# Missing chat-web Release Track

## Symptom

The CLI exposed `web-chatgpt` and `web-gemini`, but a local install failed to
load `@love-moon/chat-web/dist/index.js`. A public CLI installation would also
be unable to install the runtime because `@love-moon/chat-web` did not exist on
npm.

## Root Cause

`@love-moon/chat-web` was added as an AI SDK optional dependency without being
added to the repository's public package inventory, changesets fixed-version
group, release verification, or GitHub release workflow. The local CLI install
script also built its consumers without building this newly linked package.

Separately, the fixed-version group retained the removed
`@love-moon/ai-manager` package, so `changeset version` failed before any new
release could be prepared.

## Fix

- Publish `@love-moon/chat-web` as a public package aligned with the existing
  `0.3.2` baseline and include it in the next fixed-version bump.
- Include `chat-web` in the root workspace, release detection, release checks,
  workflow path triggers, and changeset enforcement.
- Remove the obsolete `@love-moon/ai-manager` fixed-version entry.
- Build and import-check the local linked `chat-web` package during
  `make install-cli`.

## Prevention

When a runtime package is introduced, treat package publication as part of the
same feature: register it in workspaces and release automation, add a
changeset, run a clean package verification, and verify the dependency exists
on npm before declaring downstream integrations releasable.
