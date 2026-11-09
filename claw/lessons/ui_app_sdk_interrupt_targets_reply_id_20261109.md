# app-sdk ChatView interrupt targets the reply id instead of the user message

## Symptom

In a third-party app embedding `@love-moon/app-sdk/react` `<ChatView />` (robot-rsi web), pressing Stop
(or Esc on an empty composer) while an agent was replying failed with
`Task fire owner rejected interrupt request`. The task itself was healthy in the Conductor web app.

## Root cause

Conductor interrupts a turn by `target_reply_to` = the id of the **user message** being answered; the fire
owner rejects any other id. The widget uses `runtime.replyTo` when present and otherwise falls back to
`state.latestReplyId`. `SET_RUNTIME` stored the user message id there, but `APPEND_MESSAGE` overwrote it with
the assistant message's **own** id on every reply. Whenever the runtime status carried no `replyTo`, the
interrupt was aimed at a reply id and rejected.

## Fix

`modules/app-sdk/src/react/store/chat-store.tsx`

- `APPEND_MESSAGE`: an assistant message advances `latestReplyId` to its `metadata.reply_to`, never its own id.
- `CONFIRM_SEND`: the just-sent user message becomes the target, so Stop works before the first reply arrives
  (same fallback as the web app's `latestSentReplyTo`).

Regression tests in `modules/app-sdk/test/react/chat-view.test.tsx` cover both paths; both fail before the fix.

## How to avoid next time

- Keep one meaning per state field. `latestReplyId` was written with two different id kinds (reply-to vs.
  reply id) by two reducers; the inconsistency only showed up on the fallback path.
- When a client sends ids to a server-side check, test the fallback branch, not only the happy path where the
  server already supplies the right id.
