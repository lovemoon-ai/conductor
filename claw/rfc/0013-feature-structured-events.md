The following solution focuses on the structured event messaging system.
# Feature 3: Structured Events
## Goals
- Message types can be distinguished in the App (command execution, file changes, tool calls).
- Make logs/steps/results clearer and more traceable.
## Implementation steps
1. **Define event type protocol**
- Added: `task_action`, `task_file_change`, `task_tool_call`.
- Event payload structured fields (such as command/filename/tool/result).
2. **Backend save metadata**
- `MessageEntity.metadata` saves structured fields.
3. **Flutter message model supports metadata**
- `Message` adds `metadata` field.
4. **UI component rendering**
- Render card UI according to `metadata.type`.
## Expected outcome
- Clear visualization of task execution steps.
- Better support for "Review Task" and "Audit Log".
## Planned file changes
- `sdk/typescript/src/message/router.ts`
- Parse and report structured events.
- `web/backend/src/message/message.service.ts`
- Save metadata and broadcast types.
- `app/conductor_app/lib/src/models/message.dart`
- Added `metadata` field.
- `app/conductor_app/lib/src/features/chat/chat_page.dart`
- Render structured event cards.