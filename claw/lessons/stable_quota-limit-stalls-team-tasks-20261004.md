# Model quota hit leaves tasks stalled until someone writes

## Symptom
A six-agent team sharing one Claude subscription (real2sim, 2026-10-03/04) used
up its 5-hour quota about an hour into each window. Every task then stopped:
19:05–23:00 and 00:10–06:50 (Beijing time) had no commits at all. Each message
sent to a member while waiting failed again and posted the raw error plus
"claude 处理失败: You've hit your session limit · resets …" — Physics and
Perception each logged about 80 such failures (160+ messages). After the reset
nothing resumed until Lead was woken by hand and pinged everyone.

## Root cause
Fire treated a quota error like any other turn failure: report it and wait for
the next message. It never used the reset time the error names, and its
repeated-error suppression (`isExecutionFailureLoopError`) only covers PTY/TUI
exits, so every queued message re-ran a doomed turn.

## Fix
`cli/src/fire/quota-resume.js` recognises quota errors and parses the reset time
("resets 1:20am (Asia/Shanghai)", dated, epoch and "try again in" forms). Fire
then enters a quota wait:
- creates a one-off scheduled message (`source: "quota_resume"`) at reset + 1
  minute + up to 4 minutes jitter, so it survives fire/daemon restarts and can
  be canceled from the schedule list; the server keeps one active such row per
  task;
- posts one notice and a `quota_wait` runtime status;
- queues messages that arrive before the reset (and keeps the schedule's text
  updated with them) instead of running turns;
- resumes with the original message plus everything queued, either when the
  schedule fires or when a message arrives after the reset (the schedule is
  then canceled);
- re-schedules if the resume hits the quota again, up to 3 times;
- falls back to fire's own clock if the schedule cannot be created.

Review follow-ups (fixed before commit):
- A fire that restarted mid-wait lost the queued messages: a resume that hit
  the quota again rescheduled with only the bare prompt, and a new wait replaced
  the old schedule with its list. Fire now reads the list back out of the resume
  text and merges any active quota_resume schedule before replacing it.
- `start()` ran the initial prompt right after the pre-prompt hit the quota,
  and the second wait overwrote the first's queue. Synthetic turns now queue
  while waiting, and a second quota failure folds into the existing wait.
- A quota hit inside a background turn (claude working on its own) never
  reached fire's error path: the error result has subtype "success", and the
  process exit after it was only traced. ai-sdk now marks it failed with
  `background: true`, and fire parks the task on it.
- Ending a wait early could DELETE a schedule that had already been sent, which
  erases its history. Fire cancels only before the send time, with
  `?cancel_only=1`, which never deletes.

## Avoiding it next time
Errors that carry a retry time (quota, rate limits) need their own handling
path: park, schedule the retry, queue input. A generic "report and wait for the
user" path silently turns them into indefinite stalls for autonomous agents.
