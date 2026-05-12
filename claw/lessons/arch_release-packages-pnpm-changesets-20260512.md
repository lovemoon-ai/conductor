# Release `0.3.0` — npm publish workflow saga

- Date: 2026-05-12
- Affected release: `@love-moon/conductor-cli@0.3.0`, `@love-moon/conductor-sdk@0.3.0`
- Workflow file: `.github/workflows/release-packages.yml`
- Script: `scripts/release-packages.mjs`

## Symptom

The first automated release through `release-packages.yml` failed three
consecutive times before the packages reached npm at all, then succeeded
on the fourth attempt but the workflow still reported `failure`, leaving
`v0.3.0` untagged and the `cli-release-archives.yml` dispatch un-fired.
A human had to push the tag manually.

The four observed failure modes, in order:

| run | failing step | error |
|---|---|---|
| `3fdecee` | `Publish npm packages` | `🦋 error spawn pnpm ENOENT` (changesets routed publish to pnpm, runner has only npm) |
| `9d56ab6` | `Show tool versions` | `pnpm --version` after `npm install -g pnpm@9` — binary on PATH inside the install step, gone in the next step |
| `a6f34ad` | `Show tool versions` | same, after switching to `pnpm/action-setup@v4` |
| `be4d0cc` | `Show tool versions` | same, after `corepack disable` + `npm install -g pnpm@9` |
| `32d8804` | `Install pnpm` | `curl get.pnpm.io/install.sh \| sh -` — standalone installer failed silently |
| `b9f33cd` | `Publish npm packages` | step exit 1 **despite** both packages reaching npm 0.3.0 |

## Root causes

Two independent problems were braided together:

### 1. `changeset publish` routes to pnpm in workspaces that ship a pnpm-lock

`@changesets/cli`'s publish path calls `preferred-pm` on each subpackage's
directory. Every subpackage (`cli/`, `modules/ai-sdk/`, `modules/ai-manager/`,
`modules/conductor-sdk/`) ships its own `pnpm-lock.yaml` so local devs can
run `pnpm test` per-package (documented in `CLAUDE.md`). `preferred-pm`
sees the lockfile and returns `"pnpm"`, so changesets spawns
`pnpm publish` — but the GitHub Actions runner has only `npm`.

Installing pnpm on the runner is harder than it looks because root
`package.json` declares `"packageManager": "npm@11.5.1"`. corepack ships
with Node 24 and intercepts the `pnpm` binary symlink at the Node
toolcache path; the first time `pnpm` is invoked corepack reads the root
`packageManager` field, sees it doesn't match pnpm, and exits non-zero.
This bites even when `pnpm/action-setup@v4` (which uses corepack under
the hood) is the install method.

**Fix shipped (commit `b9f33cd`):** in the publish workflow, delete every
`pnpm-lock.yaml` under `cli/` and `modules/*/` **on the runner only**
before the publish step. preferred-pm then falls back to `npm`,
changesets spawns `npm publish`, the runner already has npm, the publish
succeeds. The repo files are untouched — the next workflow run
re-checks them out fresh.

Long-term alternative we did *not* take: drop the per-package
pnpm-lock files entirely and standardize on npm everywhere. That would
break `CLAUDE.md` instructions and the muscle memory of every dev who
currently runs `cd modules/conductor-sdk && pnpm test`. The lockfile-rm
workaround is contained to the workflow file with a comment block; the
day someone wants to migrate, they can revisit this lesson.

### 2. `changeset publish` exits non-zero on the post-publish git-tag step

Even after fix #1, the `Publish npm packages` step exited 1. Both
targeted packages reached npm (`cli@0.3.0` and `sdk@0.3.0` are visible
on the registry); the failure was in `@changesets/cli`'s post-publish
**annotated git tag** step. After every successful `npm publish`,
changesets calls:

```js
// node_modules/@changesets/git/dist/changesets-git.cjs.js
async function tag(tagStr, cwd) {
  const gitCmd = await spawn("git", ["tag", tagStr, "-m", tagStr], { cwd });
  return gitCmd.code === 0;
}
```

That `-m` makes it an **annotated** tag, which requires `user.name` and
`user.email` to be configured in git. GitHub Actions runners don't set
either by default. `changesets/action@v1` *does* set them when used for
the version + publish steps, but our workflow runs `changesets/action`
only for `version`; the `Publish npm packages` step calls
`node ./scripts/release-packages.mjs publish` directly, inheriting an
unconfigured git identity. So `git tag` failed with the canonical
"Please tell me who you are" error, changesets returned non-zero, and
`scripts/release-packages.mjs` let the synchronous throw propagate.

Because the script never reached `writeGitHubOutput()`, the workflow's
`if: steps.publish.outputs.cli_version != ''` gate skipped the
`Trigger CLI archive workflow` step, and an operator had to:

- `git tag -a v0.3.0 -m "release 0.3.0" <sha> && git push origin v0.3.0`
- Let the `push: tags: v*` trigger on `cli-release-archives.yml` take over.

**Fix shipped:** two complementary changes.

1. Pass `--no-git-tag` to `changeset publish`. The repo only ever ships
   one tag per release — the unified `vX.Y.Z` pushed by
   `scripts/dispatch-cli-release-archive.sh`. The per-package tags
   changesets would otherwise create (`@love-moon/conductor-cli@0.3.0`,
   `@love-moon/conductor-sdk@0.3.0`) are local-only and never pushed
   anywhere, so eliminating them removes a real failure mode and a pile
   of garbage local refs at no functional cost.
2. Keep the spurious-exit defense as belt-and-suspenders. The script
   catches a non-zero spawn from `changeset publish`, re-probes npm for
   every pending package, and:
   - If every pending version is on npm, writes GitHub Actions outputs
     and logs a warning about the unexpected exit so downstream steps
     run.
   - If any pending version is still missing, re-throws with a precise
     error naming which versions failed to ship.

The two fixes together make the workflow correct on the normal path
(no git-tag step → no fail) **and** self-healing if any future
changesets version trips a different post-publish step.

## How to avoid next time

- When introducing a new workspace package, decide deliberately whether
  it gets its own pnpm-lock.yaml. If yes, the publish workflow must
  either install pnpm or rely on the rm-lockfile workaround documented
  here.
- Treat `changeset publish` as "uploads artifacts, may exit non-zero
  for cosmetic reasons." The source of truth for "did this release
  ship" is the npm registry, not the spawn exit code. Any future
  wrapper around `changeset publish` should validate publish via a
  registry probe (already implemented in `publishCommand()` after this
  fix).
- The pre-release SOP step `npm run release:verify` builds and smokes
  the CLI but does **not** simulate the publish flow. Adding a
  dry-run-like check (`npm publish --dry-run --json` per workspace
  package) would have caught the pnpm-routing problem before we ever
  shipped a `0.3.0` PR.

## Rollback

- The workflow change (`b9f33cd`) only affects the runner's working
  copy; reverting it just re-introduces the original ENOENT failure.
- The script change in this commit is purely defensive — even on a
  release where `changeset publish` exits 0, behavior is identical
  because `changesetSpawnError` stays null. Safe to revert if the
  spurious non-zero exit goes away in a future changesets version, but
  there's no reason to.

## Reference

- Failed runs:
  - https://github.com/lovemoon-ai/conductor/actions/runs/25740124410
  - https://github.com/lovemoon-ai/conductor/actions/runs/25747319660
  - https://github.com/lovemoon-ai/conductor/actions/runs/25747447096
  - https://github.com/lovemoon-ai/conductor/actions/runs/25747566754
  - https://github.com/lovemoon-ai/conductor/actions/runs/25747677029
- Final successful publish (workflow exit 1 but artifacts shipped):
  - https://github.com/lovemoon-ai/conductor/actions/runs/25747767544
- Archive workflow (tag-triggered, succeeded end to end):
  - https://github.com/lovemoon-ai/conductor/actions/runs/25747942135
