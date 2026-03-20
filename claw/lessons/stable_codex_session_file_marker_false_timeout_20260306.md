# stable: Codex session-file completes mark misjudgment timeout review (2026-03-06)

## Symptoms
- Online task `b32f2f3c-ecc5-417a-9c55
- 63970cb6d8e1` did not receive a normal reply from the AI ​​for a long time after the user sent the second message.
- It was observed on site that the Codex process spawned by fire is still running, and there is normal assistant output in the session file.
- But the fire side reported:
- `Stream end timeout: session completion marker not observed`
- `Stream start timeout: session file did not grow`
- On the user side, the task still displays `running`, but in fact it is no longer possible to get this round of replies.

## Root Cause
- After getting Codex `sessionFilePath`, `tui-driver` will give priority to session-file to determine the link, and will no longer fall back to PTY/snapshot to extract answers.
- The old logic treats `event_msg.payload.type === "task_complete"` of Codex as a hard completion condition that must appear in every round of answers.
- But the actual Codex rollout file does not guarantee that a new `task_complete` will be written in every round:
- New assistant `response_item` can continue to appear in the same session
- But a new `task_complete` may not appear at the same time. As a result:
- The session file has indeed grown, and there is also assistant text
- But because there is no new completion marker, `waitForSessionFileIdle()` is still sentenced to timeout
- Subsequent fire enters error processing/retry for the same user message, and eventually misjudges normal output as failure.

## Fix
- Retain `task_complete` as a strong signal for Codex session-file, but no longer regard it as the only closing condition.
- When the session file is stable and the assistant reply can be extracted after checkpoint, it is allowed to press the successful button to close.
- Only when there is "neither completion marker nor assistant reply", continue to report `session completion marker not observed`.
- Add regression testing to cover:
- There is no new `task_complete` in Codex but when there is an assistant reply, it should be regarded as successful.
- When there is neither marker nor reply, the timeout failure should still be maintained

## Prevention
- For session-file backend, the completion mark can only be used as a priority signal, and cannot be assumed to be "must be present in every round" by default.
- Any link that "completes the judgment first, then extracts the answer" must verify whether the answer extraction fallback is really reachable, to avoid having a fallback in the code but never being able to reach it in the process.
- When connecting to the local persistence format of the third-party CLI, regression testing must be done based on the actual latest samples, and you cannot just rely on early format assumptions.
- For the scenario where "the user sees no AI reply, but the underlying sub-process is still outputting", the stability test is kept separately to prevent misjudgment from returning again.
