# Web Atomic Build Temporary Directory Failure

## Symptom

During the production Web rollout, `next build` failed before the atomic
bundle swap with an `ENOENT` error writing:

```text
web/.next.tmp/static/<build-id>/_buildManifest.js.tmp.<suffix>
```

The existing Web service also briefly stopped responding while the failed
deployment was being recovered.

## Root Cause

The deployment script selected `.next.tmp` as the custom Next.js `distDir`.
On the production Next.js 16.1.2 Turbopack build, that directory failed while
Turbopack was writing its own `.tmp.*` manifest artifact. An isolated build on
the same host and commit completed successfully when the output directory was
renamed to `.next.build`.

## Fix

- Build the atomic production bundle into `.next.build`, then swap it into
  `.next` after `BUILD_ID` is validated.
- Keep TypeScript generated-type includes aligned with the new build directory.
- Ignore `.next.build/` so an interrupted build does not dirty the remote
  worktree.

## Prevention

Exercise the production atomic build directory on the target host after a
Next.js bundler upgrade, and keep deploy output directories out of naming
patterns used for bundler temporary files.
