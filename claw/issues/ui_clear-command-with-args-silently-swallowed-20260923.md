# `/clear` with trailing text is silently swallowed — no clear, no error, no AI reply

- **Severity**: P2 (minor) — **pre-existing, not a regression of this release**
- **Layer**: execution (claude backend's own slash-command handling, passed through by fire)
- **Found**: release QA round for v0.13.3 → next, 2026-09-23
- **Build**: local `main` @ `2470407`, dev CLI `./bin/conductor-dev`, daemon `qa-dev-daemon`
- **Related feature**: `/clear` in task chats (changeset `clear-command.md`)

## Symptom

A chat message that **starts with `/clear` but has trailing text** produces a dead end:
the turn reports `Turn 0` (no tokens), the reply bubble renders `(no content)`, and the
context is **not** cleared. The user gets no answer and no error.

## Reproduction

1. Open any task chat backed by `claude`.
2. Send `/clear now` (or `/clear the context please`).
3. Reply bubble shows `(no content)`; `Turn 0 · Task <unchanged>`.

A secret established before the message is still recalled afterwards, proving no clear happened.

## Root cause (verified)

`isClearCommand()` in `cli/bin/conductor-fire.js` deliberately matches only a **bare**
`/clear` — exactly as the changeset specifies ("Fire detects a bare `/clear` message …
instead of sending the text to the model"). So `/clear now` correctly falls through to
`backendSession.runTurn(content)` and is sent to the model as ordinary text.

The swallow happens **downstream, inside claude's own CLI**, which treats a leading
`/clear` as its native slash command, rejects the unexpected argument, and returns an
empty turn consuming 0 tokens. Conductor never sees an error.

## Why this is NOT a release blocker

A/B against the previous release settles it:

| build | input | result |
|-------|-------|--------|
| **v0.13.3** (npm global, has **no** `/clear` feature) | `/clear now` | **`(no content)`, no reply** |
| this build | `/clear now` | **`(no content)`, no reply** |

Identical on both, so this release did not introduce or worsen it. The same class of
pass-through affects any claude-native slash command typed into a conductor chat.

## What still works

- Bare `/clear` works correctly, including `/clear ` with a trailing space (trimmed).
- The session stays usable — the next message gets a normal reply.
- Chat history is preserved.

## Why it still deserves a fix

This release **advertises** `/clear` as a conductor feature, so users will now type it —
and typing `/clear the context` is a natural thing to do. Sibling commands are
inconsistent, which makes the dead end surprising:

| input | result |
|-------|--------|
| `/notacommand hello there…` | `Unknown command: /notacommand` (claude answers) |
| `/compact extra words here…` | conductor executes compact, ignoring the extra text |
| `/clear now` | **`(no content)`** — nothing at all |

`/compact`'s own parser (`parseCompactDirectiveFromMessage`) accepts
`^/compact(?:\s+(.*))?$` and treats the remainder as instructions. Making
`isClearCommand` symmetric — accept `/clear <anything>`, run the clear, and note that the
extra text was ignored — would close the gap and match the stated precedent
("detects a bare `/clear` message (like `/compact`)"). `/compact` is not actually
bare-only, so `/clear` is the odd one out.

## Environment

- Web: `http://localhost:6152/` dev server, build `2470407`
- Tasks: `8f975f1e-bad6-468b-8bc9-46a0a9a92df8` (new build), `63f4ed2f-c311-4af8-a895-ae623d867521` (old 0.13.3 fire)
- Evidence: `claw/issues/tmp_release-qa-20260923/tmp_evidence/C6_repro_confirmed.png`,
  `C6_slash_baseline.png`, `C6_variants.png`, `AB_old_fire_clear_args.png`

## Follow-up

Per `CLAUDE.md`, whoever fixes this should also write a lesson under `claw/lessons/`
(bug type `ui`).
