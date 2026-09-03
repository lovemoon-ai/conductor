# P2: A daemon-sharing guest can enumerate the owner's Claude sessions

## Symptom

`GET /api/agents/<host>/sessions` (new in 0.11.2, backing the **Resume Session**
tab of the create-task dialog) answers for a *guest* of a shared daemon with the
**owner's** session list: session title (the first user prompt, verbatim),
absolute `session_file_path`, `cwd`, and `updated_at`.

Observed on 2026-09-03, local build `af3c71c`:

- owner A (`+8618707151525`) shares `qa-dev-daemon`; guest host is
  `shared-1525-qa-dev-daemon`.
- user B (`+8613900000002`) is signed in and correctly walled off elsewhere:
  A's task → `404`, A's task messages → `404`, A's own host `qa-dev-daemon`
  sessions → `404 daemon_offline`.
- but `GET /api/agents/shared-1525-qa-dev-daemon/sessions?backends=claude&limit=5`
  → `200` with A's private prompts, e.g.
  `"qa and release based on sop, target verion 0.11.2"` and
  `/Users/wangwang/.claude/projects/-Users-wangwang-ws-conductor/<id>.jsonl`.

## Why this is filed as P2, not P1

The sharing UI states the intent as "Let a colleague run tasks on this machine,
with your files and your AI accounts". A guest can therefore already read the
owner's disk, so no capability boundary is crossed — but the new picker makes
the owner's prompt text visible directly in the guest's UI, which is a large
jump in discoverability. There is no PRD for the resume-session feature, so QA
cannot decide the intended behaviour.

## Ask

PM decision, one of:

1. **Intended** — document it in the sharing copy so the owner knows their
   session titles are visible to guests.
2. **Not intended** — scope `/api/agents/<host>/sessions` to the host owner
   (guests get an empty list or `403`), or filter to sessions whose `cwd` is
   inside a project the guest may use.

## Reproduction

1. Sign in as A, share the daemon with B from Settings → Daemon → Sharing.
2. Sign in as B in a separate browser profile.
3. As B, call `/api/agents/shared-<...>/sessions?backends=claude&limit=5`
   with B's bearer token, or open Create task → Resume Session and pick the
   shared host.

## Environment

Local `make run-dev` build `af3c71c`, daemon `qa-dev-daemon` (dev CLI), guest
host `shared-1525-qa-dev-daemon`.
