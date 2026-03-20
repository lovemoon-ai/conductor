The following solution focuses on project meta-information synchronization and provides implementable steps for Conductor's existing architecture.
# Feature 1: Project Metadata Sync
## Goals
- Allow the App to display the real repo name, path, branches, recent commits and other information.
- Let the backend have project-level context capabilities to facilitate multi-Agent management.
## Implementation steps
1. **SDK generates project meta information**
- Added `toMetadata()` method in `sdk/typescript/src/context/project_context.ts`.
- Field suggestions:     
- `project_root`、`repo_root`、`repo_name`
     
- `branch`（`git rev-parse --abbrev-ref HEAD`）
     
- `last_commit`（`git log -1 --pretty=format:%h %s`）
     
- `file_count`（`git ls-files | wc -l`）
2. **SDK reporting event**
- `project_upsert` event is triggered when SDK starts or task is created.
- Event payload: `project_id` + `metadata`.
3. **Backend receives and updates**
- Added `ProjectsController` or `ProjectService` method `upsertMetadata()`.
- Write `ProjectEntity.metadata` JSON field.
4. **Realtime Push**
- Push `project_updated` to App after successful update.
5. **Flutter App Display**
- Project List shows repo name + branch.
- Project Detail displays the path and commit.
## Expected outcome
- The App Project list is upgraded from "ID" to "Real Project Information".
- Users can quickly locate the repo corresponding to the task.
## Planned file changes
- `sdk/typescript/src/context/project_context.ts`
- Added `toMetadata()` and git information collection logic.
- `sdk/typescript/src/ws/client.ts`
- Send `project_upsert` event during initialization.
- `web/backend/src/project-task/project.service.ts`
- Added `upsertProjectMetadata`, write metadata.
- `web/backend/src/entities/project.entity.ts`
- Maintain the metadata JSON field and allow new keys.
- `app/conductor_app/lib/src/features/tasks/task_list_page.dart`
- show repo_name/branch.