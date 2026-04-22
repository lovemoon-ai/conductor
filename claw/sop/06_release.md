# Ship New Version SOP

You are the release agent for the conductor repository. The goal is to release a new npm version and deploy `web` to the volc production environment.
## Key semantics
- The released version is subject to the version number in `cli/package.json`, `modules/ai-sdk/package.json`, `modules/conductor-sdk/package.json`.
- The last officially released anchor is the most recent commit message with a message in the form of `release x.y.z`.
- `scripts/publish-npm.sh` must be executed by the user himself, and the agent cannot run it on his behalf.
- Don't just look at the exit code of `scripts/publish-npm.sh`; this script will continue to execute when a single package publish fails, so you must additionally verify whether the publish on npm is actually successful.
- Production deployments must follow `claw/sop/deploy-to-prod.md`.
- The code that will actually be deployed to production machines must already be on `origin/main`.
- Homebrew CLI archives are produced by `.github/workflows/cli-release-archives.yml` and are triggered by pushing a `vX.Y.Z` tag. Do not push the tag until the npm packages for that exact version are visible on `registry.npmjs.org`, because the archive workflow installs `@love-moon/conductor-cli@X.Y.Z` from npm.
- The repository tracks `cli/Formula/conductor.rb.template`, not the generated `cli/Formula/conductor.rb`. The generated Formula must be rendered only after release archives and their real sha256 files exist.
- GitHub Release notes are extracted from the matching `CHANGELOG.md` section by `scripts/extract-changelog-release-notes.sh`; the archive workflow must fail rather than publish generated notes if the changelog section is missing.
- `lovemoon-ai/homebrew-tap` is **updated manually** by the release agent after the archive workflow finishes. The conductor workflow only produces `conductor.rb` and attaches it to the GitHub Release; it no longer pushes to the tap and no longer requires a `HOMEBREW_TAP_TOKEN` secret on the conductor repo.
## Suggested workflow
1. First locate the latest `bomp to x.y.z` or `release x.y.z` commit.
2. Use `git log <last_bump>..HEAD --oneline` to summarize the commits included in this version.
3. Check the files in the current workspace that are directly related to the release:   
   - `CHANGELOG.md`
   - `cli/package.json`
   - `modules/ai-sdk/package.json`
   - `modules/conductor-sdk/package.json`
   - `scripts/publish-npm.sh`
4. Update `CHANGELOG.md`:
   - Add this version number and date- Organize content by `Added / Changed / Fixed / Removed / Security / Commits`
   - The content should be user-oriented as much as possible, don't just write implementation details
5. Clarify the target version number, and then let the user execute: `./scripts/publish-npm.sh <target_version>`
   - Must include a clear version number, do not omit it; otherwise the script will automatically bump patch
6. After the user executes it, check whether the release is really successful:
   - First read the logs posted by users- Then use `npm view <pkg>@<version> version --registry=https://registry.npmjs.org` to verify- Check `gitCommitId` if necessary
7. If npm publish fails:
   - Prioritize whether it is a registry / auth problem- If web page login confirmation or `npm adduser` is required, explicitly let the user handle it.- After repairing, let the user execute publish again.- Do not declare the ship to be successful before npm confirms the success.
8. When npm release:
   - `git add` Related documents for this release
   - commit message using `release x.y.z`
   - push to remote
   - If additional hotfix commits are generated to fix the release blocking problem, they are also allowed to be retained; but there still needs to be a `release x.y.z` in the end
9. After `release x.y.z` is on `origin/main`, trigger the CLI archive release:
   - Confirm the current local branch is up to date with `origin/main`.
   - Create a tag that matches the npm version exactly: `git tag v<x.y.z> <release_commit_hash>`.
   - Push the tag: `git push origin v<x.y.z>`.
   - Watch the `Build CLI Release Archives` GitHub Actions workflow.
   - Verify the GitHub Release notes match the `CHANGELOG.md` section for that version.
   - Verify the GitHub Release contains these assets:
     - `conductor-v<x.y.z>-darwin-arm64.tar.gz`
     - `conductor-v<x.y.z>-darwin-arm64.tar.gz.sha256`
     - `conductor-v<x.y.z>-darwin-x64.tar.gz`
     - `conductor-v<x.y.z>-darwin-x64.tar.gz.sha256`
     - `conductor-v<x.y.z>-linux-arm64.tar.gz`
     - `conductor-v<x.y.z>-linux-arm64.tar.gz.sha256`
     - `conductor-v<x.y.z>-linux-x64.tar.gz`
     - `conductor-v<x.y.z>-linux-x64.tar.gz.sha256`
     - `conductor.rb`
10. Manually update the Homebrew tap after the archive workflow succeeds:
   - Wait until the `Build CLI Release Archives` workflow for `v<x.y.z>` is green AND the GitHub Release has `conductor.rb` plus all 8 archive / sha256 assets.
   - Do not hand-edit `cli/Formula/conductor.rb`; update `cli/Formula/conductor.rb.template` only when the Formula structure changes.
   - Clone (or refresh) the tap with a remote that your SSH key can push to; `lovemoon-ai/homebrew-tap` uses the same GitHub org as the conductor repo, so use the same SSH host alias you use for the conductor remote:
     ```bash
     target_version=x.y.z
     tmp_dir=$(mktemp -d)
     git clone git@github-dang217:lovemoon-ai/homebrew-tap.git "$tmp_dir/homebrew-tap"
     cd "$tmp_dir/homebrew-tap"
     ```
   - Download the rendered `conductor.rb` from the GitHub Release and drop it in:
     ```bash
     curl -fsSL "https://github.com/lovemoon-ai/conductor/releases/download/v$target_version/conductor.rb" \
       -o Formula/conductor.rb
     ruby -c Formula/conductor.rb
     ```
   - Cross-check the four `sha256` lines in the formula against the `.sha256` files on the GitHub Release (guards against mismatched or stale uploads):
     ```bash
     for plat in darwin-arm64 darwin-x64 linux-arm64 linux-x64; do
       rb_sha=$(grep -A1 "conductor-v#{version}-$plat\.tar\.gz\"" Formula/conductor.rb | grep sha256 | sed 's/.*"\(.*\)".*/\1/')
       rel_sha=$(curl -fsSL "https://github.com/lovemoon-ai/conductor/releases/download/v$target_version/conductor-v$target_version-$plat.tar.gz.sha256" | awk '{print $1}')
       [ "$rb_sha" = "$rel_sha" ] && echo "OK $plat" || { echo "MISMATCH $plat rb=$rb_sha rel=$rel_sha"; exit 1; }
     done
     ```
   - Commit and push to the tap:
     ```bash
     git add Formula/conductor.rb
     git commit -m "conductor $target_version"
     git push origin main
     ```
   - Verify on the remote side (do NOT trust `raw.githubusercontent.com` — that CDN can serve a stale copy; use the GitHub API or the web UI):
     ```bash
     curl -fsS -H "Accept: application/vnd.github+json" \
       "https://api.github.com/repos/lovemoon-ai/homebrew-tap/commits?per_page=1" \
       | python3 -c "import json,sys; c=json.load(sys.stdin)[0]; print(c['sha'][:7], c['commit']['message'].split(chr(10))[0])"
     ```
   - Before running `brew install`, make sure no conductor daemon / fire process is still running from a previous brew install — a live daemon that gets its Cellar path removed (by later `brew uninstall` or `brew upgrade`) becomes a zombie: it stays connected but every child spawn fails with `ENOENT`, which breaks kill/restart for every task bound to it.
   - If `lovemoon-ai/tap` is already tapped locally, Homebrew's cache of the tap clone can be stale; refresh it before `brew install` or the install will pick up the previous version:
     ```bash
     tap_path=$(brew --repository lovemoon-ai/tap)
     (cd "$tap_path" && git fetch origin main && git reset --hard origin/main)
     ```
     (If the tap is not tapped yet, a plain `brew install lovemoon-ai/tap/conductor` will clone it fresh and you can skip this.)
   - Verify at least the current local platform: `brew install lovemoon-ai/tap/conductor` and `conductor --version` should print the new `x.y.z`.
   - Keep brew installed conductor.
11. After npm and CLI archives are successfully released, press `claw/sop/deploy-to-prod.md` to deploy production:
   - Determine whether `web/package.json` / `web/pnpm-lock.yaml` is involved
   - Determine whether Prisma schema / migrations are involved
   - Perform production deployments and health checks
12. If the CLI archive workflow fails:
   - First check whether the exact npm package version exists on `registry.npmjs.org` — `@love-moon/conductor-cli@<version>` must be published, because the archive workflow installs it from npm.
   - Check the failed matrix platform logs, especially `node-pty` verification and bundled Node download failures.
   - Make the minimal fix on `origin/main`, then move the tag only if the original tag points at a broken release commit and the user explicitly approves retagging.
   - The archive workflow no longer pushes to `lovemoon-ai/homebrew-tap`; a tap push failure is now impossible from CI. If the manual tap push in step 10 fails, the typical causes are: wrong SSH remote host alias (needs the same alias used for the conductor repo), missing write access on `lovemoon-ai/homebrew-tap`, or a non-fast-forward because someone else updated the tap in parallel — pull with `--ff-only` and retry.
   - Do not declare Homebrew release success until the GitHub Release assets, the tap formula, and `brew install` + `conductor --version` all point to the same version.
13. If production deployment fails:
   - First reproduce and locate the failure
   - Make minimal repairs- If the fix involves code changes, submit it first and push it to `origin/main`
   - Then re-execute the production deployment
14. Last reply `Ship successfully!`

## Git tag operation details
- Tags are the trigger for Homebrew CLI archive publishing. A normal commit push does not run `.github/workflows/cli-release-archives.yml`; only a pushed `vX.Y.Z` tag or manual `workflow_dispatch` does.
- Always tag the `release x.y.z` commit on `origin/main`, not a local-only branch commit.
- Before creating the tag, run:
  ```bash
  target_version=x.y.z
  git fetch origin main --tags
  release_commit=$(git rev-parse origin/main)
  git log -1 --oneline "$release_commit"
  npm view @love-moon/conductor-cli@"$target_version" version --registry=https://registry.npmjs.org
  npm view @love-moon/ai-sdk@"$target_version" version --registry=https://registry.npmjs.org
  npm view @love-moon/conductor-sdk@"$target_version" version --registry=https://registry.npmjs.org
  npm view @love-moon/ai-manager@"$target_version" version --registry=https://registry.npmjs.org
  git tag --list "v$target_version"
  ```
- If `git tag --list "v$target_version"` returns anything, stop and inspect it with:
  ```bash
  git show --no-patch --decorate "v$target_version"
  ```
  Do not move or replace an existing tag without explicit user approval.
- Create and push an annotated release tag:
  ```bash
  git tag -a "v$target_version" "$release_commit" -m "release $target_version"
  git push origin "v$target_version"
  ```
- After pushing the tag, verify the workflow started:
  ```bash
  gh run list --workflow "Build CLI Release Archives" --limit 5
  ```
- If the tag was created on the wrong commit, do not silently retag. Explain the wrong tag target and the intended target, then ask for explicit approval. Only after approval:
  ```bash
  git tag -d "v$target_version"
  git push origin ":refs/tags/v$target_version"
  git tag -a "v$target_version" "$correct_release_commit" -m "release $target_version"
  git push origin "v$target_version"
  ```
- If the archive workflow has already published release assets for the wrong tag, delete or replace those assets deliberately before rerunning, and record the correction in the release notes.

## Recommended check items
- `git log --oneline --decorate -n 30`
- `git log --reverse --oneline <last_bump>..HEAD`
- `git status --short`
- `git diff --name-only <last_bump>..HEAD`
- `npm config get registry`
- `npm whoami --registry=https://registry.npmjs.org`
- `npm view @love-moon/ai-sdk@<version> version --registry=https://registry.npmjs.org`
- `npm view @love-moon/conductor-sdk@<version> version --registry=https://registry.npmjs.org`
- `npm view @love-moon/ai-manager@<version> version --registry=https://registry.npmjs.org`
- `npm view @love-moon/conductor-cli@<version> version --registry=https://registry.npmjs.org`
- `gh run list --workflow "Build CLI Release Archives" --limit 5`
- `gh release view v<version> --json tagName,assets`
- `brew install lovemoon-ai/tap/conductor`
- `conductor --version`

## Common judgment rules
- `npm publish failed ... continuing` appears in publish log- It cannot be regarded as successful, and you must continue to verify whether the version already exists on the npm registry.- The local default npm registry is `npmmirror`, but the token is configured in `registry.npmjs.org`- Most likely publish failed; need to fix registry explicitly or let user handle npm login first.- Build failure found during production deployment- First repair the local code and verify it, then push it, and then redeploy it.- The changes to fix the release/deployment blocking problem are code bugs, not bugs encountered by users in daily use- There is no need to specifically patch the `claw/lessons/` document for this temporary release blocking, unless the user explicitly requests it.- There are changes in the workspace that are not related to this release.- Do not submit casually; only submit documents directly related to this release.
## Minimum acceptance criteria
1. Can be found on npm:   
   - `@love-moon/ai-sdk@x.y.z`
   - `@love-moon/conductor-sdk@x.y.z`
   - `@love-moon/ai-manager@x.y.z`
   - `@love-moon/conductor-cli@x.y.z`
2. There is a `release x.y.z` commit on `origin/main`.
3. There is a `vX.Y.Z` tag on the release commit, and the `Build CLI Release Archives` workflow has succeeded.
4. The GitHub Release contains all four platform archives, their `.sha256` files, and `conductor.rb`.
5. The Homebrew tap formula has been updated **manually** (a new commit on `lovemoon-ai/homebrew-tap` whose subject is `conductor <x.y.z>`) and verified on at least one local platform with `brew install lovemoon-ai/tap/conductor` + `conductor --version`.
6. The production deployment is successful and meets the health check standards in `claw/sop/deploy-to-prod.md`.
7. Final reply includes:- Final release commit hash- Git tag- CLI archive workflow URL/status- Homebrew tap commit hash- Production deployment commit hash- Whether `pnpm -C web install` was executed- Whether database migration was performed- Three local health check status codes-Whether artificial regression has been performed; if not, please explain clearly
## Output requirements
- Give the conclusion first, then the evidence.- If it fails, explicitly write:- Failure stage- failed command- Key log- Suggestions for next steps- If successful, the last fixed reply is:  - `Ship successfully!`
