The following solutions focus on real-time incremental updates to reduce full synchronization costs.
# Feature 4: Incremental push replaces full synchronization (Incremental Sync)
## Goals
- WebSocket only pulls incremental data after reconnection.
- Task list/message updates are more timely and save power.
## Implementation steps
1. **Backend broadcasts incremental events**
- `MessageService.createMessage` continues to push `task_user_message` / `task_sdk_message`.
- `TaskService.updateStatus` pushes `task_status_update`.
2. **Incremental update on App**
- `ws_event_handler.dart` directly updates `taskListProvider` / `chatProvider`.
3. **Reconnection strategy optimization**
- Added "Last N messages" pull mode to `BackendSyncManager`.
- Keep full sync as fallback.
## Expected outcome
- Mobile traffic and CPU usage are reduced.
- UI updates are more real-time.
## Planned file changes
- `web/backend/src/message/message.service.ts`
- Ensure incremental push of message events.
- `web/backend/src/project-task/task.service.ts`
- Push `task_status_update` on status change.
- `app/conductor_app/lib/src/ws/ws_event_handler.dart`
- Handle incremental events and update local state.
- `app/conductor_app/lib/src/sync/backend_sync.dart`
- Implement incremental pull strategy after disconnection.