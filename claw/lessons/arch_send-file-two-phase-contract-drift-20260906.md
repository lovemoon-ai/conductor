# arch: `conductor send-file` uploaded bytes that never reached the chat, and rejected all video

- Date: 2026-09-06
- Severity: P1 (feature silently non-functional since `a6a4924`)
- Component: `cli/bin/conductor-send-file.js`, `web/src/app/api/tasks/[taskId]/attachments/route.ts`,
  `web/src/lib/channel/task-ingress-service.ts`, `web/nginx_conf`

## Symptom

A user reported `conductor send-file ./clip.mp4` failing with:

```
Error: Upload failed (415): video attachments are not supported
```

The 415 was real but it was only the outermost of four independent walls. Behind it,
`send-file` was fully broken for *every* file type: the CLI printed
`Uploaded <name> to task <id>`, yet nothing ever appeared in the chat UI and the bytes were
deleted minutes later. The success message made the failure invisible.

## Root cause

Four separate defects stacked:

1. **Contract drift (the real bug).** `a6a4924` converted `POST /api/tasks/:id/attachments`
   from a single-phase endpoint (upload → create Message → broadcast) into a *pure staging*
   endpoint, and updated the browser to a two-phase flow (`ChatView.tsx` posts
   `/messages` with `attachmentIds`). `cli/bin/conductor-send-file.js` was never updated and
   stayed on the old single-phase contract: it uploaded and returned. The staged row kept
   `messageId: null`, so it was never rendered (the UI only reads `message.attachments`) and
   `pruneExpiredStagedTaskAttachments` deleted it once the staging window closed.
2. **Silently dropped fields.** The CLI still sent `content` and `role` as multipart fields,
   but the new route sets busboy `limits.fields = 0` and registers no `field` /`fieldsLimit`
   handler, so both were discarded server-side with no error. `--content` was a no-op.
3. **`sdk` role could not bind at all.** Binding lives only in `appendUserMessageToTask`, which
   resolved `userMessageTargetHost` for `role === "user"` only, then required an agent on that
   host advertising `task_attachments_v1`. An `sdk` message therefore hit
   `ATTACHMENTS_UNSUPPORTED_BY_AGENT` 409 — even though it is delivered to the *browser*, not
   to an agent, and needs no agent capability.
4. **Two conflicting size ceilings.** The app allowed 100 MB, but `web/nginx_conf` capped
   bodies at `client_max_body_size 20m`, so anything larger was rejected by nginx with an
   opaque 413 before Next.js saw it. Measured against prod: 15 MB → reached the app; 25 MB →
   413 after only 65 KB. The web UI advertised a 100 MB limit it could not honour.

The video ban itself was deliberate (`32c97d4`, enforced by extension, MIME and file-header
sniffing) but was never a size or safety requirement the product needed.

## Fix

- CLI now performs the two-phase flow: stage the bytes, then `POST /messages` with
  `attachmentIds`, sending `content` / `role` as JSON where they are actually read.
- `appendUserMessageToTask` gates the agent-capability check, the chat-web type restriction and
  the transfer-token signing on `role === "user"`; `sdk` messages bind and broadcast without an
  agent.
- Removed the video ban from all three layers (route, storage sniffer, chat UI) and its tests.
- `client_max_body_size` 20m → 110m (100 MB payload + multipart overhead), plus
  `proxy_request_buffering off` so large uploads stream instead of spooling to disk.
- Attachment TTL default 10 → 5 minutes. It bounds only *staged* uploads and post-delivery
  retention; binding sets `expiresAt: null`, so it is not a download deadline.

## How to avoid this next time

- **When a refactor splits one endpoint into two phases, grep every client of that route.**
  The browser was migrated in the same commit; the CLI was not. A route's callers include
  `cli/` and `modules/`, not just `src/`.
- **Never let a write path report success it did not verify.** The CLI printed `Uploaded ...`
  after a 201 that only meant "bytes staged". Worse, it read `response.attachments` (plural)
  while the route returned `attachment` (singular) — a shape mismatch that silently fell back
  to the local filename, hiding the drift. Assert on the field you actually depend on.
- **A capability gate belongs on the delivery path, not the message path.** The
  `task_attachments_v1` check was applied to all attachment messages, but only agent-bound
  messages need it. Gate on what actually consumes the data.
- **Keep proxy limits and app limits in one place, and test at the real boundary.** The 20m/100 MB
  split survived because every test exercised the route directly, never through nginx. `nginx_conf`
  now carries a comment tying it to `MAX_ATTACHMENT_BYTES`.
