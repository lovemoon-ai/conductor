# Goal

Implement "Upgrade Project to Claw, and configure a project manager for each project to manage all development tasks under the project (refer to OpenClaw ideas)"
## Inputs
1. Start the server locally: cd web && unset http_proxy && unset_https_proxy && unset_all_proxy && npm install && npm run dev
2. Local test method: Use chrome-devtools mcp to open http://localhost:6152/, use `env:CONDUCTOR_PHONE` to complete the login
3. Start conductor-daemon locally: conductor-daemon --config-file ~/.conductor/config-dev.yaml
## Non-goals
1. There will be no one-time migration script for historical data in this issue (compatible with reading old fields first)
2. Not reconstructing all UI copywriting in this issue, only covering the core entrance and details page
3. Do not change the task execution engine, only add the "butler" role and routing relationship
## Steps
1. Codemap understands the current code and only looks at project/task/domain model, API, front-end display and real-time events
2. Design the Claw model:
   - Project -> Claw naming and compatibility strategy (API alias or field mapping)
   - Bind the manager (project manager) identification and configuration to each Claw
3. Backend implementation:
   - Add/extend Claw entity fields and service methods
   - Associate the Claw manager when the task is created
   - Add the manager dimension to the event stream
4. Front-end implementation:
   - Project list/details replaced with Claw semantics
   - Display the housekeeper information and its management scope
5. Test:
   - API single test covers Claw creation, query, task attribution
   - Page regression to verify that the old Project data is readable
## Rules
1. Prioritize compatibility to avoid full link interruption caused by one-time rename
2. When testing locally, turn off all proxies and then test: unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy
3. If schema changes are involved, migration and rollback instructions must be added
## Implementation points
1. It is recommended to retain the Project table first, add the Claw semantic layer and field mapping, and gradually replace it.
2. The manager can be configured with metadata first, and then independently materialized later.
3. The OpenClaw reference point is mainly used for the division of responsibilities and does not copy the implementation details.
## Acceptance criteria
1. The main UI and API processes are named Claw (compatible with old Project access)
2. Each Claw can configure and display a project manager
3. New tasks are mounted to the corresponding Claw steward context by default.
## Risks and rollback
1. Risk: Excessive naming substitution may cause inconsistency between front-end and back-end fields.
2. Rollback: Keep Project main field writing, Claw display is controlled by feature flag
## Done
Local testing to implement the function of "upgrade Project to Claw and configure a project manager for each project to manage all development tasks under the project (refer to OpenClaw ideas)"
Do not stop until the done condition is satisfied.