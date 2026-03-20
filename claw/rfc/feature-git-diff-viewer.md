The following solution focuses on mobile Diff review capabilities.
# Feature 2:Git change view (Mobile Diff Viewer)
## Goals
- View the AI-modified diff on the mobile phone.
- Linked with task details page/chat page to improve review efficiency.
## Implementation steps
1. **SDK provides diff acquisition capability**
- Add `getDiff(staged?: boolean)` to `ProjectContext` to encapsulate the call entry based on the existing method.
2. **Backend adds Diff API**
- Added `GET /tasks/:taskId/diff` or `/projects/:projectId/diff`.
- Backend calls the SDK to get the diff (or via SDK side RPC events).
3. **Flutter App adds new Diff page**
- Create a new diff view page, supporting: copy, fold, search.
- The entrance is placed on the button in the upper right corner of Task Detail.
## Expected outcome
- Users can complete code review on the mobile phone.
- Reduce the friction of "returning to the computer to view changes".
## Planned file changes
- `sdk/typescript/src/context/project_context.ts`
- Reuse `getDiff` as diff data provider.
- `web/backend/src/projects/projects.controller.ts`
- Added diff API endpoint.
- `app/conductor_app/lib/src/features/tasks/task_detail_page.dart`
- Added "View Diff" entry and diff page navigation.
- `app/conductor_app/lib/src/features/tasks/diff_view_page.dart` (new file)
- Basic diff UI components.