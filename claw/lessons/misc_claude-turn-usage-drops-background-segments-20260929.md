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
