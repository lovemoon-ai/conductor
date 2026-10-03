# Claude background subagents killed 10 minutes after the turn ends

## Symptom

Long multi-agent Claude tasks (e.g. task faa889ac "【开发】pdebug 研发" on ruofo)
kept going quiet: the main agent launched background subagents, ended its
turn, and then nothing happened until the user asked "进展如何了？怎么都没动静呢？".
The agent itself explained that "the session ended, so the subagents stopped",
and asked the user to send "继续" periodically.

## Root cause

ai-sdk ran every turn as a one-shot `query({ prompt: "<string>" })`. With a
string prompt the SDK closes claude's stdin right away, so the bundled claude
CLI is in print mode with its input closed. In that state, once the main
agent's turn is over, claude waits for background tasks for at most
`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` (default 600000 = 10 min), then kills
them ("-p giving up on a background subagent still running at its wait
ceiling") and exits.

Evidence from the session transcript on ruofo: all 15 times subagents received
`[Request interrupted by user]` between 10-01 and 10-03, it was exactly
10:00–10:01 after the main agent's last activity. The next process started
with `--resume` then reported "N background agents didn't finish before the
previous session ended". The daemon did nothing in those windows, and
ai-sdk's own 12-minute inactivity deadline did not match the timings.

So Claude behaved as designed; the bug was how conductor drove it.

## Fix

`ClaudeAgentSdkSession` keeps one long-lived query per session whose prompt is
an async iterable that stays open between turns:

- `runTurn` pushes a user message (with a `uuid`) into the stream and settles on
  the `result` that echoes that uuid in `user_message_uuids`. If a result echoes
  no uuid, it still settles the turn, unless one of claude's own follow-up turns
  is running.
- Output that does not belong to a user turn (claude answering a finished
  subagent's notification) is handled as a background turn: replies are posted
  to the chat, and a terminal working status is emitted when it ends.
- `modelUsage` is cumulative for the process, so turn usage is the difference
  from the previous user turn; follow-up turns are counted with the next user
  turn.
- Interrupt uses `query.interrupt()` and only tears the process down if no result
  arrives within 10 s. A turn timeout or `close()` closes the process. If the
  process dies, the next turn respawns it with `resume`.
- jsonSchema turns (serve-ai structured output) keep the one-shot path, because
  `outputFormat` is fixed at spawn.
- Subagent text (`parent_tool_use_id` set) is no longer posted as a reply.

Verified against the real claude CLI with the ceiling lowered to 30 s and a
subagent that runs for 80 s. Old code: the turn returned only at 43 s, when the
process wound down, and the subagent was killed. New code: the turn returned at
11.6 s, and at 104.5 s claude posted `BACKGROUND_DONE SUBAGENT_FINISHED` on its own.

## How to avoid next time

- A provider CLI driven in print/one-shot mode may treat "input closed" as
  "wind down". When a backend supports background work, drive it through its
  streaming/interactive mode and keep the input open for the session's
  lifetime.
- When "the task just stopped" keeps recurring, line up the stop times against
  the last activity in the transcript; a constant gap points straight at a
  timer. Then search the CLI binary's strings for the knob.
