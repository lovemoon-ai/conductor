# Release SOP

This repository now separates web deployment from npm package publishing.

## Release Tracks

- `web/` is deployed as an application. Use a deploy identifier such as the
  commit SHA, CI run number, or deploy timestamp. A web-only change does not
  require an npm release.
- Published npm packages are versioned independently with changesets:
  - `@love-moon/ai-sdk`
  - `@love-moon/ai-manager`
  - `@love-moon/conductor-sdk`
  - `@love-moon/conductor-cli`
- CLI archive releases are still built by `.github/workflows/cli-release-archives.yml`.
  They are triggered after `@love-moon/conductor-cli` is published to npm.

## Required External Setup

Before the automated workflow can publish, configure npm trusted publishing for
each public npm package above.

- npm package settings must trust the GitHub repository `lovemoon-ai/conductor`.
- The trusted workflow file must be `.github/workflows/release-packages.yml`.
- Do not add `NPM_TOKEN`; the workflow uses GitHub OIDC with `id-token: write`.
- The package `repository.url` fields must remain
  `git+https://github.com/lovemoon-ai/conductor.git`.

## Feature PR Rules

If a PR changes a published npm package in a way users should receive, run:

```bash
npm run changeset
```

Select the affected package(s), choose `patch`, `minor`, or `major`, and commit
the generated `.changeset/*.md` file with the feature.

### AI / Author decision rule

The agent or author should decide whether to run `npm run changeset` from the
actual diff. This decision should be automatic; do not wait for a separate user
instruction just to create the changeset.

Run `npm run changeset` on the feature branch when the diff changes shipped
behavior for any published package:

- `cli/**`
- `modules/ai-sdk/**`
- `modules/ai-manager/**`
- `modules/conductor-sdk/**`

Skip `npm run changeset` when the diff is release-neutral, for example:

- `web/**` only
- docs-only changes
- test-only changes that do not change published runtime behavior
- release infrastructure changes that should not create a package release

If the impact is unclear, inspect the changed files and package boundaries
first. Only ask the user when the release intent is genuinely ambiguous.

No changeset is needed for:

- web-only changes under `web/`
- internal docs that do not change a published package
- test-only changes that do not change shipped package behavior
- release infrastructure changes that should not create a package release

## Automated npm Release Flow

1. Merge a feature PR that includes one or more changesets.
2. The `Release Packages` workflow pushes the version-bump commit to
   `changeset-release/main` and **attempts** to open a `version packages` PR.
   - **Caveat**: the `lovemoon-ai` org currently has
     `default_workflow_permissions: read` set at the org level (see
     `gh api orgs/lovemoon-ai/actions/permissions/workflow`), so the
     `changesets/action@v1` step's PR-creation API call returns 403 and
     the workflow itself is marked `failure` **even though the branch
     was updated correctly**. This is benign as far as the version
     bumps go; the failure is just the missing PR.
   - **Workaround until an org admin lifts the policy**: after the
     workflow run completes (even if red), open the PR manually:
     ```sh
     gh pr create -R lovemoon-ai/conductor \
       --base main --head changeset-release/main \
       --title "version packages" \
       --body "<copy from cli/CHANGELOG.md's top entry>"
     ```
3. Review the generated package versions and package-level changelogs.
4. Merge the `version packages` PR. (Or, if you're confident, fast-forward
   merge `changeset-release/main` into `main` from the CLI — the 0.3.0
   release skipped the PR review this way; see commit `3fdecee`.)
5. The `Release Packages` workflow publishes only package versions that are not
   already present on `registry.npmjs.org`.
6. If `@love-moon/conductor-cli` was published, the workflow creates/preserves
   tag `vX.Y.Z` and manually dispatches `.github/workflows/cli-release-archives.yml`.

There is no longer a manual step where the user runs `scripts/publish-npm.sh`
or any other local publish command. After the version PR is merged, CI owns the
npm publish step end to end.

The workflow dispatch is intentional: tags pushed by `GITHUB_TOKEN` do not
normally trigger a second workflow via `push`, so the release workflow dispatches
the archive workflow explicitly after npm publish succeeds.

## Pre-release Notes Gate

Before any release (web deploy, npm package publish, or CLI archive), walk
through every file under `claw/notes-before-release/` and resolve each item.

- The directory is an **active reminder list**. A non-empty directory at
  release time is a hard gate — do not deploy until each item is either
  resolved, explicitly accepted, or migrated to a longer-lived doc (PRD,
  ADR, lesson, or follow-up issue under `claw/issues/`).
- After the release ships and health checks pass, **clear every file in
  `claw/notes-before-release/` except `README.md`** as part of the same
  release commit / PR. The empty directory is the steady state; carrying
  notes across releases means they were not actually addressed.
- If an item cannot be resolved before this release but the release should
  still go out, edit the note to record what was accepted and why, then
  promote it out of `notes-before-release/` (e.g. into `claw/issues/` or
  `claw/lessons/`) before clearing.

## Local Checks Before Merging a Release PR

Run the relevant package tests as needed. The release workflow runs a
publish-safe verification set:

```bash
npm ci
npm run release:verify
```

This builds and tests the published TypeScript packages, then smoke-tests the
CLI entrypoint with `--version` and `--help`. Full CLI integration tests remain
available with `cd cli && npm test`; some of them intentionally depend on local
development fixtures.

To inspect which local package versions are not yet on npm:

```bash
npm run release:status
```

The status command must show an unpublished CLI version before a CLI archive
release is expected.

## CLI Archive Release

The archive workflow resolves the CLI version from either:

- a `vX.Y.Z` tag, for manual tag-triggered releases
- `workflow_dispatch` input `version`, for the automated npm release handoff

For CLI releases, GitHub Release notes are extracted from `cli/CHANGELOG.md`.
This changelog is generated by changesets when the CLI package is versioned.

The archive workflow must publish these assets:

- `conductor-vX.Y.Z-darwin-arm64.tar.gz`
- `conductor-vX.Y.Z-darwin-arm64.tar.gz.sha256`
- `conductor-vX.Y.Z-darwin-x64.tar.gz`
- `conductor-vX.Y.Z-darwin-x64.tar.gz.sha256`
- `conductor-vX.Y.Z-linux-arm64.tar.gz`
- `conductor-vX.Y.Z-linux-arm64.tar.gz.sha256`
- `conductor-vX.Y.Z-linux-x64.tar.gz`
- `conductor-vX.Y.Z-linux-x64.tar.gz.sha256`
- `conductor.rb`

## Homebrew Tap Update

Update `lovemoon-ai/homebrew-tap` manually after the archive workflow succeeds.

```bash
target_version=x.y.z
tmp_dir=$(mktemp -d)
git clone git@github-dang217:lovemoon-ai/homebrew-tap.git "$tmp_dir/homebrew-tap"
cd "$tmp_dir/homebrew-tap"
curl -fsSL "https://github.com/lovemoon-ai/conductor/releases/download/v$target_version/conductor.rb" \
  -o Formula/conductor.rb
ruby -c Formula/conductor.rb
```

Cross-check the formula checksums against the GitHub Release:

```bash
for plat in darwin-arm64 darwin-x64 linux-arm64 linux-x64; do
  rb_sha=$(grep -A1 "conductor-v#{version}-$plat\.tar\.gz\"" Formula/conductor.rb | grep sha256 | sed 's/.*"\(.*\)".*/\1/')
  rel_sha=$(curl -fsSL "https://github.com/lovemoon-ai/conductor/releases/download/v$target_version/conductor-v$target_version-$plat.tar.gz.sha256" | awk '{print $1}')
  [ "$rb_sha" = "$rel_sha" ] && echo "OK $plat" || { echo "MISMATCH $plat rb=$rb_sha rel=$rel_sha"; exit 1; }
done
```

Then commit and push:

```bash
git add Formula/conductor.rb
git commit -m "conductor $target_version"
git push origin main
```

Do not run a Homebrew upgrade test on a machine currently serving a live
`conductor daemon`; Homebrew may replace the old Cellar path while the daemon is
still running.

## Web Production Deploy

Web production deployment remains separate. Follow `claw/sop/deploy-to-prod.md`.

Only deploy code that is already on `origin/main`. A web-only deployment should
not trigger npm publish, package version bumps, CLI archives, or Homebrew tap
updates.

### Release order

The settings page used to embed `cli/package.json`'s `version` at web build
time (`NEXT_PUBLIC_CLI_VERSION`) so a web deploy before the npm version bump
would pin a stale "CLI Version" line on the live site. As of the post-0.3.0
cleanup the settings page now fetches the latest CLI version from the npm
registry at runtime (`/api/cli-version`, 5-minute cache), so a stale embedded
value at worst flashes for one render before the fetch resolves.

That said, the order below is still the canonical sequence for a **combined**
release (one that includes new npm package versions). It avoids the brief
mixed-version flash and gives operators a single linear sequence to follow.

#### Combined release (changesets present on `main`)

1. Push features + their `.changeset/*.md` to `origin/main`.
2. Let the `Release Packages` workflow open or update the auto-generated
   `version packages` PR.
3. Merge the version-packages PR. This bumps `cli/package.json` and any
   other touched packages on `main`.
4. The workflow publishes to npm, creates the `vX.Y.Z` tag, and dispatches
   `cli-release-archives.yml`. Wait for the GitHub Release to appear with
   all archives + `conductor.rb`.
5. Update `lovemoon-ai/homebrew-tap` per the Homebrew section above.
6. **Then** run web deploy per `claw/sop/deploy-to-prod.md`. The deploy
   script pulls the latest `main`, which now contains the bumped
   `cli/package.json`, and the runtime `/api/cli-version` route immediately
   sees the new version on the npm registry.

#### Web-only release (no pending changesets)

Deploy web at will. No npm step required; the settings page keeps showing
whatever the npm registry serves today, so a web-only fix shipping mid-week
doesn't change the "CLI Version" line at all.

#### Pre-deploy guard

`scripts/deploy-prod.sh` prints a warning when it detects that
`.changeset/` contains unreleased entries (i.e., this would be a combined
release but the npm part hasn't happened yet). The script does not block —
sometimes you really do need to ship the web change first, e.g. a
server-side fix that unblocks an already-released CLI — but the warning
makes the choice explicit instead of silent.

## Failure Rules

- If npm publish fails, fix the workflow or trusted publisher configuration and
  rerun the `Release Packages` workflow. Do not manually run
  `scripts/publish-npm.sh`; it is deprecated.
- If the CLI archive workflow fails, first verify that
  `@love-moon/conductor-cli@X.Y.Z` exists on `registry.npmjs.org`.
- Do not move or delete an existing release tag without explicit approval.
- If the Homebrew tap update fails, resolve the tap push independently; the main
  repository workflow no longer pushes to the tap.

## Minimum Acceptance Criteria

- `claw/notes-before-release/` contains only `README.md` (every pre-release
  note has been resolved, accepted, or promoted elsewhere, then cleared).
- Every intended npm package version exists on `registry.npmjs.org`.
- If the CLI was released, tag `vX.Y.Z` exists and the CLI archive workflow has
  succeeded.
- If the CLI was released, the GitHub Release contains all archives, checksums,
  and `conductor.rb`.
- If the CLI was released, `lovemoon-ai/homebrew-tap` has a commit with subject
  `conductor X.Y.Z`.
- If web was deployed, production health checks from `claw/sop/deploy-to-prod.md`
  pass.
