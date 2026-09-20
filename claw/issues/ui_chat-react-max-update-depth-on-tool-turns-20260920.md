# P2 — `Maximum update depth exceeded` on every tool-using turn (reproduces on a production build)

Supersedes the 2026-07-28 closure in
`claw/issues/message-input-update-loop-20260728.md`, which classified this
signature as dev-only noise. That closure explicitly said: *"If it is ever
reproduced on a production build, reopen with the production-build evidence
attached."* This ticket is that reopening.

## Symptom

During any AI turn that runs a tool, the browser console raises an uncaught
React error:

- dev build: `Maximum update depth exceeded. This can happen when a component
  repeatedly calls setState inside componentWillUpdate or componentDidUpdate.`
- production build: `Minified React error #185` (the same error, minified)

The turn itself still completes correctly — the reply streams in, Markdown /
tables render, and the task reaches `claude finished`. No user-visible
malfunction was observed; the cost is an uncaught error plus the renders React
discards when it bails out.

## Severity: P2

- Not cosmetic (a real uncaught error and wasted render passes), but no
  observable functional damage: content, ordering and terminal state were all
  correct in every run.
- **Not a regression in 0.13.3** — see the A/B below. It is pre-existing, so it
  does not gate this release.
- It is *not* low-frequency: it reproduces on essentially every tool-using turn,
  which is the product's most common interaction. That is why it should be
  fixed, and why the dev-only classification should not be restored without
  production evidence.

## Environment

- Build under test: local `main` @ `7df7447` (0.13.3 candidate).
- Web: **production build** (`pnpm build && pnpm start`) on `http://localhost:6152`
  — not `make run-dev`. This is the point of the ticket.
- Backend: claude, via `qa-dev-daemon` (dev CLI `./bin/conductor-dev`).
- Driver: Playwright + real Chromium, console captured via `page.on('pageerror')`.

## Reproduction

1. `cd web && pnpm build && pnpm start` (confirm the log prints `Ready on ...`,
   and that no earlier server still holds the port — see "Pitfall" below).
2. Sign in and open any AI task.
3. Send a prompt that forces exactly one tool call, e.g.
   `Use the Bash tool exactly once to run: python3 -c "import time; time.sleep(12); print('probe')". Then reply with the word: done.`
4. Watch `pageerror` in the console while the turn runs.

Observed: 1–2 × `Minified React error #185` per tool-using turn, on every run.

## A/B: pre-existing, not from this release

Same machine, same DB, same daemon, same prompt; only
`web/src/features/chat/components/` swapped between `v0.13.2` and the 0.13.3
candidate, with a **full rebuild and a genuine server restart** for each side:

| build | React #185 per tool turn |
|-------|--------------------------|
| `v0.13.2` chat components | 2, 2 |
| 0.13.3 candidate (`7df7447`) | 1 |

Each side carried a sanity check proving the intended bundle was actually being
served (on the `v0.13.2` side, Shift+Enter still *sent* the draft instead of
inserting a newline).

## Isolation already done

Zero errors were captured in these phases, so the trigger is specifically the
tool-call turn, not the composer and not page load:

- fresh page load of a task with history: 0
- typing in the composer without sending: 0
- send + reply for a prompt with **no** tool call: 0
- send + reply for a prompt **with** a tool call: 1–2

This also rules out `MessageInput` as the culprit, which is where the 2026-07-28
ticket looked. Suspect the status / runtime-status update path that drives the
"working" indicator during tool execution (it ticks repeatedly only while a tool
is running), interacting with a `setState` in an effect in the chat view.

## Pitfall for whoever verifies this

`pkill -f "next-server"` does **not** stop this app — it runs a custom server
(`tsx server.ts`). A second `pnpm start` then fails with
`EADDRINUSE` while the *old* build keeps serving, silently invalidating any A/B.
Always kill by port (`lsof -nP -iTCP:6152 -sTCP:LISTEN -t`) and confirm
`Ready on http://0.0.0.0:6152` in the new server's log before testing.

## Handoff

Per `CLAUDE.md`, the engineer who fixes this must also write a lesson under
`claw/lessons/` (bug type `ui`).
