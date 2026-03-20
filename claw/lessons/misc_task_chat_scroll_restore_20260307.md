# misc: The scroll position is lost after the task chat page is returned (2026-03-07)

## Symptoms
- After the user views earlier messages on the Task chat page, returns to the task list and re-enters the same task, the message list will continue to scroll to the bottom.
- The result on the user side is:
- Unable to go back to where you were reading
- Every time you switch out and come back, you have to manually search up the context again.
- When new messages arrive, it is easy to interrupt the process of reading old messages.

## Root Cause
- `ChatView` The old implementation made an unconditional `scrollIntoView` to the `messages.length` change. As long as the component is remounted or the number of messages is updated, it will jump directly to the bottom.
- The chat page does not save the scrolling state by pressing `taskId`. When re-entering the task after switching the route, there is no restorable reading position.
- There is no distinction between the two states of "the user is reading old news" and "the user is following the latest news at the bottom".

## Fix
- Add scroll state persistence according to `taskId` dimension to the task chat list, write `sessionStorage` before leaving the page and during scrolling.
- When re-entering the task, priority is given to restoring the last `scrollTop`; if it was already at the bottom before leaving, it will be restored to continue sticking to the bottom.
- When new messages arrive, they will automatically scroll to the bottom only when the user is already at the bottom, or when the user sends a message himself, to avoid interrupting reading old messages.
- Supplemented frontend testing, covering three scenarios: scroll position recovery, not jumping to the bottom when reading old messages, and bottom status recovery.

## Prevention
- For long list UIs such as chat, log, and terminal, the state boundary between "reading position recovery" and "automatic follow" must be designed by default.
- Any automatic scrolling logic cannot only be bound to data changes, but needs to explicitly distinguish between initial loading, route return, user active sending, background new message push and other scenarios.
- This type of interactive repair should be supplemented with tests simultaneously to prevent subsequent refactoring from returning to the "unconditional bottom-out" implementation.