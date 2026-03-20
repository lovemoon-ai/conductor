# ui: task chat page copy gesture and status bar display review (2026-03-19)

## Symptoms
- When the user clicks on the chat message, a copy button will pop up, which may easily conflict with normal reading, text selection and other operations.
- The status bar above the Task chat input box displays `Task status: running` and `Backend: codex` for a long time, and the information is noisy.
- For the codex backend, what users really care about is the real-time task status returned by ai-sdk, rather than the general task status inferred locally by the frontend.

## Root Cause
- `MessageBubble` binds the toolbar expansion to the click event. The interaction threshold is too low, resulting in high-frequency accidental touches.
- The `ChatView` status bar directly displays the task list status, backend name and websocket connection status in a mixed manner, without distinguishing between "basic connection information" and "AI real running status".
- The real progress of the codex has been returned through ai-sdk `task_runtime_status`, but the frontend has no priority and only displays this type of more valuable status text.

## Fix
- Changed the message bubble copy toolbar from single-click trigger to double-click trigger to reduce the probability of accidental touch.
- Remove the `Task status: running` and `Backend: codex` display in the chat box status bar.
- Only show `statusLine` / `statusDoneLine` when runtime status comes from ai-sdk real source (such as `ai-sdk`, `*-sdk`, `*-app-server`).
- Supplement the front-end test to cover the scenarios of "double-click to pop up the copy button" and "only display the real AI status copy".

## Prevention
- Shortcut operations for chat UI should prioritize the cost of accidental touches and avoid binding auxiliary functions to the main click gesture by default.
- When displaying the running status, prioritize filtering information based on "whether it is of decision-making value to the user" to avoid exposing the internal general status directly to the main interface.
- As long as there is a more realistic upstream status source (such as ai-sdk runtime status), do not overlay the front-end local backend status to cause duplication or conflict.