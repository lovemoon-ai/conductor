# stable: v0.9.0 web deploy briefly took production down — attachments env guard not flagged

## Symptom

During the v0.9.0 web production deploy (2026-08-22, commit `606e5a6`), the new
web process died immediately on boot and `https://conductor-ai.top` was
unavailable for ~2–3 minutes (between `.next` swap + old-process kill and the
fix). `deploy-prod.sh` health check reported `Next.js (6152): ❌ Failed`.

## Root cause

The task-attachments feature added a hard production startup guard
(`assertTaskAttachmentStorageConfigured`, `web/src/lib/tasks/task-file-storage.ts`):
in production it throws unless `CONDUCTOR_FILE_STORAGE_DIR` is set and
`CONDUCTOR_FILE_STORAGE_SHARED=true`. Neither the feature PR nor the release
notes flagged the new required env vars (the repo guideline "Flag schema changes
or new environment variables" was not followed), and `web/.env.production.local`
on the Volc box did not have them. The deploy went: build OK → swap → restart →
crash-loop-free but dead process.

Two secondary deploy frictions (no outage, but time lost):

- `next build` TypeScript phase OOM'd at Node's default 2 GB heap on the 8 GB
  box; needed `NODE_OPTIONS=--max-old-space-size=4096`.
- A `node_modules` backup dir left inside `web/` (`web/node_modules.old-*`) was
  picked up by the TypeScript check and failed the build; backups must live
  outside the app tree.

## Fix

```sh
mkdir -p /opt/conductor/attachments
# web/.env.production.local (backed up first):
CONDUCTOR_FILE_STORAGE_DIR=/opt/conductor/attachments
CONDUCTOR_FILE_STORAGE_SHARED=true   # single-box deploy: trivially true
```
Restart service → health 200, site 200, `/api/cli-version` = 0.9.0 @ 606e5a6.
DB migration (`20260801120000_task_attachments`) had applied cleanly beforehand
and is additive, so the old process kept serving until the swap.

## How to avoid next time

- Any PR that adds a production env requirement (especially a startup assert)
  MUST list the new env vars in the PR body and in a
  `claw/notes-before-release/` note so the release operator applies them
  before restart.
- Before a web deploy, grep the release delta for new env reads/asserts:
  `git diff <prev>..HEAD -- web | grep -nE "process\.env\.[A-Z_]+"` and diff
  against the box's `.env.production.local`.
- Deploy SOP: prefer configuring new env vars BEFORE running
  `scripts/deploy-prod.sh`, so the restart window stays seconds, not minutes.
