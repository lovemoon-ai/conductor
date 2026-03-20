# stable: Manual fire multiple openings lead to Codex session crosstalk review (2026-03-06)

## Symptoms
- After the user manually started multiple `conductor fire` tasks in the same project directory, reply crosstalk occurred between different tasks.
- It can be seen on site that although multiple fire processes correspond to different tasks, they are actually restored to the same Codex session/thread.
- The user side behaves as:
- A task received a reply from another task context
- Session history and current question do not match
- After running for a long time, it is more likely to appear "It looks like it is still alive, but the task boundaries are messed up"

## Root Cause
- In the old implementation, Codex session found that `cwd -> latest thread` fallback logic existed.
- When multiple fresh fires are started under the same `cwd`, but the task has not yet obtained and persisted its own `session_id`:
- When found for the first time, the same local Codex threads table will be checked.
- The query condition will hit the most recently updated thread under the same `cwd`.
- Different fires may be bound to the same backend session at the same time.
- Although the task already has its own running process, the wrong session is bound from the beginning, and crosstalk will continue later.

## Fix
- Retain the persistent binding of `session_id/session_file_path` at the task level, and give priority to explicit binding in subsequent rounds and reconnections.
- Delete the `cwd latest` discovery strategy of Codex, and no longer guess the session based on the "latest thread in the same directory".
- Change to structured discovery:
- Record startup time window before fire `boot`.
- At the same time, collect the baseline collection of the current Codex thread.
- The first discovery only recognizes threads that are newly created after `boot` and are not in the baseline.
- Add a layer of `backend + realpath(cwd)` cross-process file locking to fresh `codex` fire.
- In this way, the new Codex session bootstrap in the same directory will be completed serially.
- Avoid competing for the same new thread when two fresh fires are concurrent.
- Add regression testing:
- Codex discovery must take precedence over explicit session binding.
- First discovered walking `launch window + baseline exclusion`.
- The fresh session bootstrap lock path is stable and can be released after execution.

## Prevention
- For backends with local session status, it is prohibited to use heuristic fallbacks such as `cwd latest` as the main path.
- "First binding backend session" and "Resume/reconnect after binding" must be divided into two sets of logical designs, and discovery strategies cannot be mixed.
- Any discovery logic that will share the local state library across processes must first consider concurrency isolation, rather than just looking at the correctness of a single process.
- Reserve separate regression tests for "opening multiple tasks with the same cwd" because this is the real user scenario that is most likely to induce crosstalk.