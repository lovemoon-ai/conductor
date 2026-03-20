The following solution focuses on MCP tool approval and permission control.
# Feature 5: Tool Approval/Permission Control (Tool Approval)
## Goals
- Confirmation by user before high-risk operations.
- Enhance remote execution reliability.
## Implementation steps
1. **SDK generates approval event**
- MCP server initiates `tool_approval_request` for sensitive tool calls.
- Record request_id for subsequent postback.
2. **Backend routing approval request**
- Push approval events to App via `RealtimeHub.routeToProjectApps`.
3. **App pop-up window approval**
- UI options: Allow once / Deny / Always allow.
- Return `tool_approval_response` after user selection.
4. **SDK Execution Allow List**
- Local persistence allowlist.
- Support command prefix matching.
## Expected outcome
- Reduce the risk of accidental operations.
- Increase user trust in AI.
## Planned file changes
- `sdk/typescript/src/mcp/server.ts`
- Add approval events and allowlist.
- `sdk/typescript/src/ws/client.ts`
- Process approval receipts.
- `web/backend/src/realtime/realtime.hub.ts`
- Routing approval events.
- `app/conductor_app/lib/src/features/tasks/task_detail_page.dart`
- Pop-up approval UI.