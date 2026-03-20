# Goal

Implement active status refresh for the last self-sent message when the user double-clicks it.
## Inputs
1. Start the server locally: cd web && unset http_proxy && unset_https_proxy && unset_all_proxy && npm install && npm run dev
2. Local test method: Use chrome-devtools mcp to open http://localhost:6152/, use `env:CONDUCTOR_PHONE` to complete the login
3. Start conductor-daemon locally: conductor-daemon --config-file ~/.conductor/config-dev.yaml
## Non-goals
1. Do not change the message sending protocol and message persistence structure
2. No new global shortcut keys or right-click menus will be added.
3. Do not support double-click refresh on arbitrary messages. Only the last self-sent message is in scope.
## Steps
1. Use codemap to understand the current code. Focus only on the web chat page message rendering, status bar status source, and task status refresh link.
2. Define interaction rules:
   - Only triggered when the target message is sent by the current user and is the last user message in the current session.
   - Double-click to enter loading to avoid repeated triggering (throttling/anti-shake)
3. Implement the status refresh action (reuse the existing status query interface or WS event), and write it to the status bar data source after the refresh is successful.
4. Add frontend testing:
   - When a hit triggers a message, double-clicking will trigger a refresh.
   - Non-hit messages are not triggered when double-clicked.
   - If the refresh fails, an error message will be displayed and the original state will not be polluted.
5. Local manual verification: double-click the latest self-sent message after sending the message, and observe the status bar changes and error details.
## Rules
1. Do not regress existing message card interactions (click, copy, scroll positioning)
2. When testing locally, turn off all proxies and then test: unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy
3. Triggering refresh must be idempotent to avoid concurrent requests caused by consecutive double-clicks.
## Implementation points
1. Add `onDoubleClick` event to message item component
2. Add `isLastSelfMessage(messageId)` judgment in session store/selectors
3. The status bar is updated uniformly through a single status source to avoid inconsistency between local status and global status.
## Acceptance criteria
1. After double-clicking the last message to send by yourself, the latest status or error message will appear in the status bar within 3 seconds.
2. Double-clicking other messages has no side effects
3. After network failure, the refresh can be triggered again without getting stuck on loading.
## Risks and rollback
1. Risk: Misjudgment of "the last self-sent message" leads to false triggering
2. Rollback: Close the double-click trigger entry through the feature flag, and only retain the original state refresh mechanism
## Done
Local testing verifies active status refresh for the last self-sent message on double-click.
Do not stop until the done condition is satisfied.