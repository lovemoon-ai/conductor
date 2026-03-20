The following plan is based on a comparison of the existing code structure of Conductor and the corresponding implementation of ClaudeCodeUI. The goal is to turn the 5 learnable points into executable engineering improvements.
# Conductor Learn the implementation plan of ClaudeCodeUI
## 1) Project meta information synchronization (making Project readable and available)
### Current situation issues- Conductor's `Project` mainly uses `projectId` as the display name, and the meta information is insufficient.- The SDK already has `ProjectContext` (git root / file list / diff), but it has not been uploaded to the backend.
### Target income- The App side can display the real repo name, path, and branch information.- Supports multi-project, multi-Agent visual management.
### Implementation plan1. **SDK output project meta information event**- Add `toMetadata()` method (or independent helper) based on `sdk/typescript/src/context/project_context.ts`, return:     - `repo_root`、`project_root`、`repo_name`、`branch`、`last_commit`、`file_count`
- New event: `project_upsert`, sent to backend through SDK WebSocket.2. **Backend stores/updates project meta information**- Add fields in `ProjectEntity.metadata` (keep the JSON structure and avoid migrating and changing the table structure).- `ProjectService` Added `upsertProjectMetadata(userId, projectId, metadata)`.- `RealtimeHub.routeToProjectApps` emits the `project_updated` event.3. **Flutter App Display**- The Project list displays the short path of `repo_name` or `project_root`.- The Project details page displays git branch/commit.
### Involved files- `sdk/typescript/src/context/project_context.ts`
- `sdk/typescript/src/ws/client.ts`
- `web/backend/src/project-task/project.service.ts`
- `web/backend/src/entities/project.entity.ts`
- `app/conductor_app/lib/src/features/tasks/task_list_page.dart`

---

## 2) Git change view (code review on mobile terminal)
### Current situation issues- The SDK can get diff, but there is no diff entry on the App side.- Users must go back to the desktop to view code changes, which weakens the value of "mobile review".
### Target income- Review AI modifications and provide quick feedback on the mobile phone.- Linked with task logs/messages to improve closed-loop efficiency.
### Implementation plan1. **SDK provides diff pulling interface**- Use `ProjectContext.getDiff()` to encapsulate it into `task_get_diff` event or REST proxy request.2. **Backend adds Diff API**- Add `/projects/:id/diff` or `/tasks/:id/diff` in backend.- Get the diff through the project context of the SDK (go to SDK → backend → app).3. **Flutter App adds Diff Viewer**- Create a new Diff view page that supports copy, expand, and collapse.- The entrance is placed at the top of the Task details page or Chat page.
### Involved files- `sdk/typescript/src/context/project_context.ts`
- `sdk/typescript/src/backend/client.ts` (if necessary, add a new call)- `web/backend/src/projects/projects.controller.ts`
- `app/conductor_app/lib/src/features/tasks/task_detail_page.dart`

---

## 3) Structured event message (command/file-change/agent-step)
### Current situation issues- The App message model only supports `role/content` and cannot express tool calls, file changes and other events.- The SDK has been able to capture status and events, but the upload is not structured.
### Target income- The UI can display "Execution Steps/File Changes/MCP Call" cards to improve readability.- Enhanced task traceability.
### Implementation plan1. **Extend MessageEntity and Flutter Message model**- `MessageEntity.metadata` continues to carry structured fields.- Flutter `Message` adds `metadata` field and retains compatibility.2. **SDK Router adds event type mapping**- For example: `task_action` / `task_file_change` / `task_tool_call`.3. **App-side rendering strategy**- `message.metadata.type` determines rendering components (step cards, diff summary, tool cards).
### Involved files- `web/backend/src/message/message.service.ts`
- `app/conductor_app/lib/src/models/message.dart`
- `app/conductor_app/lib/src/features/chat/chat_page.dart`
- `sdk/typescript/src/message/router.ts`

---

## 4) Incremental push replaces full synchronization (real-time update optimization)
### Current situation issues- After WS is reconnected, the App will pull all tasks and messages, which will cause high performance costs.- WS already has a realtime hub, but lacks an incremental push strategy.
### Target income- The mobile network is more stable and CPU/power consumption is reduced.- UI response is more timely.
### Implementation plan1. **Backend broadcasts incremental events**- `MessageService.createMessage` has pushed messages in WS and can continue to expand task update events.- `TaskService.updateStatus` sends `task_status_update` to app.2. **App side difference processing**- `ws_event_handler.dart` directly updates `taskListProvider` / `chatProvider`.- Keep background sync as fallback (to avoid packet loss).3. **Disconnection recovery strategy**- When disconnected and reconnected, only "incremental pull of the latest N messages" will be performed.
### Involved files- `web/backend/src/message/message.service.ts`
- `web/backend/src/project-task/task.service.ts`
- `app/conductor_app/lib/src/ws/ws_event_handler.dart`
- `app/conductor_app/lib/src/sync/backend_sync.dart`

---

## 5) Tool approval/authority control (security and trust)
### Current situation issues- There is no user approval mechanism for MCP tool calls.- Lack of confirmation steps for high-risk operations.
### Target income- Users trust AI automated operations more.- Suitable for production environment/multi-person collaboration scenarios.
### Implementation plan1. **SDK adds Tool Approval event**- Send `tool_approval_request` for key operations and wait for feedback from the App.2. **Backend routing approval event**- RealtimeHub adds an approval channel for `routeToProjectApps` + `routeToProjectAgents`.3. **App UI adds approval pop-up window**- Support "Allow once/Deny/Always allow".4. **SDK persistent allowlist (local)**- Similar to ClaudeCodeUI's allowlist logic; supported based on command prefix.
### Involved files- `sdk/typescript/src/mcp/server.ts`
- `sdk/typescript/src/ws/client.ts`
- `web/backend/src/realtime/realtime.hub.ts`
- `app/conductor_app/lib/src/features/tasks/task_detail_page.dart`

---

# Implement priority recommendations
1. **P0: Project meta-information synchronization** (improve readability, infrastructure construction)2. **P0: Incremental push replaces full synchronization** (significantly improves experience)3. **P1: Git Diff mobile view** (improving the value of core scenarios)4. **P1: Structured event messages** (improved task traceability)5. **P2: Tool approval mechanism** (security enhancement)
---

# expected results
- The App can identify real projects and modification details- Task updates are more real-time and performance is more stable- AI operations are transparent, safe, and traceable
