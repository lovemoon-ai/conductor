# Task restart entry and inplace semantics bug

## Symptom
- Restart was surfaced inconsistently in the app UI, including places that did not match the mobile swipe action model.
- Running tasks and stopped tasks did not clearly expose different restart behavior.
- The restart pipeline could blur the boundary between inplace resume and new-task context reuse, making debugging harder when users switched backends or restarted from a running task.

## Root cause
- Restart UI had grown in multiple places instead of having one primary mobile entry point.
- Restart semantics were modeled mostly around backend switching, not around the more important product distinction of:
  - resume the same task in place
  - create a new task from existing context
- That made it too easy for protocol and UI behavior to drift apart.

## Fix
- Move restart entry to the task item's swipe action menu and keep it always available there.
- Remove the old inline/detail-pane restart affordances.
- Add a restart dialog that:
  - enables `inplace` only for stopped tasks on the current backend
  - forces `new_task` for running tasks
- Keep conductor protocol semantics simple:
  - `resume_inplace` always resumes directly and never uses ai-bridge
  - `fork_to_new_task` always creates a new task and reuses context through ai-bridge
- Add regression tests for:
  - dialog defaults
  - running vs stopped behavior
  - task list swipe restart entry
  - API restart routing
  - daemon-side guarantee that `resume_inplace` does not call ai-bridge

## How to avoid next time
- Define product semantics first around user intent, then map transport/protocol names afterward.
- For restart-like actions, treat “same task” vs “new task” as the primary axis; backend changes are secondary.
- Keep one primary entry point per surface on mobile to avoid duplicated interaction patterns.
- Add daemon tests for negative guarantees, not only happy paths, when a flow must not call an integration like ai-bridge.
