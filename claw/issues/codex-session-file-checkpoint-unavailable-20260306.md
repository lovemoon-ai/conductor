# Codex session file checkpoint unavailable problem record
Date:2026-03-06

## Phenomenon
When local `conductor-fire` uses Codex backend, an error occurs occasionally:
- `codex processing failed: Codex session file checkpoint unavailable`
Judging from the observed cases, this problem is "sporadic" and cannot be reproduced stably every time.

## Current confirmed behavior
This error is not thrown at the beginning of the turn, but after the current round has completed the following steps:
1. TUI is started and ready2. prompt has been entered and submitted3. Waiting for stream start / stream end4. Enter the `CAPTURE` stage and prepare to extract the final answer
Corresponding code:
- `<repo-root>/modules/tui-driver/src/driver/TuiDriver.ts`
Throw the error point directly:
- When `sessionCheckpoint` is empty and backend is `codex`, throw `Codex session file checkpoint unavailable`

## Current judgment
The essence of this problem is not "session file stat failed", but "the session file information corresponding to the current Codex session was not successfully parsed at the beginning of this round".
The reason is:
- `captureSessionFileCheckpoint()` will generate checkpoint only when `sessionInfo` exists
- If `sessionInfo` is `null`, checkpoint is directly `null`
- The current implementation of Codex does not allow falling back on TUI text extraction without checkpointing

## Why can't I get checkpoint?
The current more accurate statement should be: you can't get `checkpoint`, essentially you can't get `sessionInfo`.
Codex's session finds path dependencies:
1. `<codex-home>/state_5.sqlite`
2. The current CLI session record in the `threads` table
3. `rollout_path` in that record
4. The corresponding rollout `.jsonl` file actually exists
As long as any of the above links are not satisfied at the beginning of this round, it may cause `sessionInfo` to be empty.

## Possible reasons
Currently known high-probability causes include:
- `<codex-home>/state_5.sqlite` is temporarily unreadable or not updated in time
- The current session record in `threads` is written late and the discovery window is missed.
- The record exists, but does not meet the current query conditions:
  - `source='cli'`
  - `model_provider='openai'`
  - `created_at >= sessionDetectStartSec`
- If cwd is set, cwd is required to match exactly
- `rollout_path` is empty, or the rollout file path does not exist temporarily
## Why does it amplify into a user-visible issue?
In the current Codex logic, the session file monitor may have begun to continuously forward assistant messages to the front end, but `runTurn()` will still be judged as failed because there is no checkpoint in the `CAPTURE` stage.
Once it is determined to be a failure, two problems will arise:
1. The front end sees the error message: `codex processing failed: Codex session file checkpoint unavailable`2. `replyTo` will not be written to `processedMessageIds` in this round. If the message is delivered/replayed again later, it will easily cause the same prompt to be sent to Codex again.

## Current conclusion
This is a problem of "occasional failure of the session discovery chain", not a problem that is guaranteed to be stable.
Its current harm has two levels:
- Surface layer: False positive failure occurs
- Deep level: It is possible to enlarge to the same user prompt and rerun it.

## Tentative strategy
This time we only record the problem and will not fix it at this stage.
If you deal with it later, it is recommended to choose a main line from the following two directions:
### Direction A: Enhance session discovery stability
- Relax/retry Codex session discovery
- Improved tolerance for sqlite write delays and rollout_path delays
- Optimize cwd / baseline / created_at filter conditions
### Direction B: Reduce the failure level when checkpoint is missing
- Codex does not fail turn directly when checkpoint is missing
- Allow session monitor to continuously read session file as main path
- Avoid misjudgment of completed turns as failures due to missing checkpoints

## Related related issues
This problem has an amplified relationship with "the same app message is received twice by Codex", but it is not completely equivalent.
More precisely:
- `checkpoint unavailable` will cause this round not to be marked as processed
- This will increase the probability of rerunning the same prompt repeatedly

## Remark
Currently, we are only recording the problem and will not continue to process it. It is not the target of this round of code changes.
