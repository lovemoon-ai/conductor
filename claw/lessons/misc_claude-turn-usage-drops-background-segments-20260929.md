# Claude turn usage drops background segments and subagents

## Symptom
Two tasks with the same prompt: the local Claude task (1b4ad7b2) showed 294K
tokens and the remote-workspace one (6fbc1a5d) 1.48M, so remote looked 5x more
expensive. The transcripts told the opposite story: local really used 12.59M
(main thread 0.88M + two background Explore subagents 1.63M and 10.08M), the
remote one exactly 1.48M.

## Root cause
When the main agent launches background subagents, it ends its reply, and each
`task_notification` resumes it inside the same `query()`. So one turn yields
several `result` messages. `claude-agent-sdk-session.js` kept only the last
one and reported `result.usage`, which covers just the segment after the last
notification (here the final 4 API calls = 294,175). Earlier segments and all
subagent calls were dropped.

## Fix
On a finished turn, report the sum of the last result's `modelUsage`
(per model: input / cacheCreation / cacheRead / output). The SDK accumulates it
over every API call the query's process made (all segments, subagents and side
calls) and resets it per `query()`, verified against real SDK 0.3.220 runs.
It falls back to `usage` when `modelUsage` is missing. Session/context
summaries still read the last segment's `usage`, which is the context size.

## How to avoid next time
- Provider usage fields have different scopes (per API call, per segment, per
  process). Check the scope against a real transcript before summing or
  reporting one. A background-subagent run is the case that tells them apart.
- When a task card number looks off, recompute it from the session JSONL
  (dedupe by requestId, include `subagents/*.jsonl`) before drawing cost
  conclusions.

## Same gap in Codex (fixed the same day)
Codex multi-agent streams every spawned sub-agent thread over the parent's
app-server connection. `handleNotification` drops all events whose `threadId`
is not the session's thread. That filter exists so a sub-agent's
`turn/completed` cannot end the parent turn, but it also drops the sub-agent's
`thread/tokenUsage/updated`, so the turn counted only the main thread.
The fix records each sub-agent thread's total. The first update seen in a turn
fixes the baseline (the previous known total, else `total - last`), and the
turn's usage adds each sub-thread's delta. Context size stays the main
thread's. Verified live on ruofo (codex 0.156.1): the turn reported 72,084 =
main 42,744 + sub-agent 29,340, where the old code reported 42,744.
Lesson: a "not my thread" filter must still let accounting events through.

## Review follow-ups
- Resume: on codex 0.156.1 a fresh app-server that resumes the parent and then
  messages the old sub-agent does *not* replay the sub-thread total. Its first
  update is the new response on top of the old total, so `total - last` is
  right (recorded in a test). The sub-agent's `turn/started` id matches its
  usage `turnId`, so an update under a turn id we never saw start is treated
  as a replay (baseline = its total), the same way the main thread's is.
- Sub-agent spend between turns goes to the next turn: at turn start each
  sub-thread's baseline moves to what the last snapshot reported.
- Sub-agent spend counts even when the main thread sent no in-turn update.
- Claude error path: a `result` clears the streamed-usage map, and a failure
  reports that result's `modelUsage` plus what streamed after it.
