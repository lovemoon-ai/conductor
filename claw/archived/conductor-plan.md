# Conductor Technical Design Document (plan.md)

This technical document is based on the finalized three-layer architecture **App / Backend / SDK**, describing the system technical structure, protocols, data flows, module implementation details and future expansion directions.

---

# 1. Overall architecture

```
┌──────────────────────────────────────────────────────────┐
│                  External AI Processes                   │
│ (Codex / CC / Custom Agent) ││ - Runs in a separate process ││ - Connect to SDK through MCP Client │└───────────────↓───────────────────────────────┬──────────┘
                          MCP
┌───────────────────────────────────────────────┴──────────┐
│                             SDK                           │
│   - MCP Server（create_task / send_message / receive / notification）              │
│ - Session Management / Message Routing ││   - WebSocket Client                                      │
└───────────────↑───────────────────────────────┬──────────┘
                          WS (long-lived)
┌───────────────────────────────────────────────┴──────────┐
│                         Backend                           │
│  - User/Auth                                               │
│  - Project/Task/Message Store                              │
│ - WS Hub (App ↔ SDK Routing) ││  - Push Notification                                       │
│  - Agent Registry / Heartbeat                              │
└───────────────↑───────────────────────────────┬──────────┘
                                HTTPS / WS
┌──────────────────────────────────────────────────────────┐
│                       Conductor App                      │
│   - Flutter UI                                           │
│   - Chat / Task / Log UI                                 │
│   - HTTPS / WebSocket client                             │
└──────────────────────────────────────────────────────────┘
```

---

# 2. Module design

## 2.1 App module (Flutter)
### Function module:
- **Task List**: Filter by status, display recent progress
- **Chat Interface**: Supports Markdown, code blocks, message types
- **Action Button**: Run Tests / Build / Patch etc. ChatOps
- **Log View**: Streaming log rendering
- **Push system**
- **Multi-Agent Management (v0.3)**

### Technical selection:
- Flutter
- dio（HTTP）
- web_socket_channel（WS）
- riverpod (status management)
- isar (local offline cache)
- flutter_markdown (rendering AI output)

---

## 2.2 Backend module (control plane)

### Core Responsibilities:
- User authentication
- Project/task/message data layer
- Two-way message routing between App and SDK
- Push system (FCM/APNS)
- Agent registration and status management

### Technical selection:
- NestJS (recommended) / Go (optional)
- PostgreSQL
- Redis (WS Routing & Cache)
- Socket.IO / native WS
- JWT Auth
- Docker/K8s

### Backend module structure:
- `auth/`
- `project/`
- `task/`
- `message/`
- `realtime/`（WS Hub）
- `agent/`
- `notify/`

---

## 2.3 SDK module (execution layer)

### Responsibilities:
- Establish a persistent WS connection with Backend and sense task/message events on the App side.
- Expose basic tools (create task sessions, send messages, receive App-side replies) through MCP Server for calls by external AI processes.
- Maintain task session status and message buffering to ensure consistency during multi-Agent/multi-model collaboration.
- Synchronize external AI's replies and status to Backend → App to form a remote collaboration closed loop.

### Technical selection:
- Python 3.10+
- websockets or aiohttp
- httpx (calling Backend REST auxiliary interface)
- MCP protocol implementation (such as open-mcp / self-developed implementation)
- asyncio
- pydantic (configuration & data structures)

### SDK module structure:
- `client/ws_client.py` (WS long connection)
- `mcp/server.py` (MCP Server, external exposure tool)
- `session/session_manager.py` (task session status, message cache)
- `message/message_router.py` (message routing, deduplication, replay)
- `context/project_context.py` (path mapping, repo metadata, used to provide context for tools)
- `reporter/event_stream.py` (status/event reporting)
- `config/config.yaml`

First batch of MCP tools (v1):

| Tool name | Function | Input parameters | Return value |
| --- | --- | --- | --- |
| `create_task_session` | Create a Task in Backend and drive the App to generate a new chat dialog box. | `project_id`, `title`, optional initial user message `prefill` | `{ "task_id": "...", "session_id": "...", "app_url": "..." }` |
| `send_message` | Inject responses from external AI into Backend → App, support Markdown/code blocks. | `task_id`, `content`, `metadata` (optional, such as model name, delay) | `{ "message_id": "...", "delivered": true }` |
| `receive_messages` | Pull App user/system messages, support offset / ack, only return unread by default. | `task_id`, `ack_token` (optional), `limit` | `{ "messages": [...], "next_ack_token": "...", "has_more": true/false }` |
| `ack_messages` | Explicitly confirm the processed message to avoid repeated push. | `task_id`, `ack_token` | `{ "status": "ok" }` |
| `message_notification` | Backend → SDK → MCP Notification, reminds LLM to call `receive_messages` when there is a new message. | System automatically | `notifications/message` log notification |
| `list_sessions`(optional) | List the session context (task_id, last message time) maintained by the current SDK. | `project_id`(optional) | `[{ "task_id": "...", "title": "...", "last_message_at": "..." }]` |

## 2.4 Module task disassembly and dependencies

### 2.4.1 Principles
- Modules need to have independent interface contracts and observable outputs (logs, API, UI) to facilitate separate compilation/running/testing.
- First implement the dependent base modules (configuration, data layer, protocol layer), and then implement the upper-layer interaction module to avoid repeated rework.
- Define direct dependencies and test entries (unit/integration/widget/E2E stub) for each module to ensure independent execution in CI.

### 2.4.2 Backend control plane tasks
| Module | Main tasks | Independently testable | Direct dependencies | Priority |
| --- | --- | --- | --- | --- |
| `db/redis foundation` | Define PostgreSQL schema, Redis key convention, basic repository(project/task/message). | SQL migration test + repository single test (NestJS testing module). | None | P0 |
| `auth` | JWT issuance/verification, Agent Token, user CRUD API. | controller/service single test + token integration test (mock db). | Data layer | P0 |
| `project-task` | Project/Task API, state machine, task filtering. | service single test + API contract test (supertest). | Data layer, auth | P1 |
| `message` | Message persistence, paging, rich text (Markdown) verification. | repository single test + API contract. | Data layer, project-task | P1 |
| `realtime` | WS Hub, session routing, message fan-out, heartbeat. | WebSocket integration test (supertest + ws client mock). | auth, message | P2 |
| `agent` | Agent registration, heartbeat, capability description, task allocation. | service single test + WS stub test. | realtime, project-task | P2 |
| `notify` | Push/email, failure retry, subscription preferences. | Integration testing (using local FCM/APNS mock). | message, agent | P3 |

### 2.4.3 SDK execution layer tasks
| Module | Main tasks | Independently testable | Direct dependencies | Priority |
| --- | --- | --- | --- | --- |
| `config` | Parse config.yaml/env, verify required items. | pydantic model single test. | None | P0 |
| `ws_client` | Establish/maintain WebSocket with Backend, automatically reconnect. | async single test (pytest + pytest-asyncio). | config | P0 |
| `session_manager` | Task session life cycle, message buffering, replay. | state single test (pytest). | config, ws_client | P1 |
| `message_router` | App ↔ SDK message routing, deduplication, filtering. | integration test(mock ws client). | ws_client, session_manager | P1 |
| `project_context` | Provide project/repository meta information to MCP tools. | Local repository fixture single test. | config | P1 |
| `mcp_server` | MCP Server, exposing `create_task` / `send_message` / `receive_message` tools + MCP Notification reminder. | integration test(pytest-asyncio + mock ws). | ws_client, session_manager, message_router, project_context | P2 |
| `reporter/event_stream` | SDK → Backend status synchronization, tool call audit. | aiohttp mock integration test. | ws_client | P2 |
| `orchestrator` | Session orchestration, error recovery, coordinating external AI processes. | end-to-end stub(mock ws + mock mcp client). | All of the above | P3 |

### 2.4.4 App (Flutter) tasks
| Module | Main tasks | Independently testable | Direct dependencies | Priority |
| --- | --- | --- | --- | --- |
| `data/http_client` | dio encapsulation, authentication interceptor, error handling. | unit test(mocktail). | None | P0 |
| `data/ws_client` | web_socket_channel encapsulation, heartbeat reconnection. | unit test + integration(fake backend). | http_client | P0 |
| `state/project_task_provider` | riverpod store, state cache, offline strategy. | riverpod unit test. | data layer | P1 |
| `ui/task_list` | Task list, filter, refresh. | widget test(golden). | state layer | P1 |
| `ui/chat` | Message flow + Markdown rendering + action bar. | widget test + markdown rendering single test. | state layer, ws client | P2 |
| `ui/log_view` | Log stream terminal, copy, color mapping. | widget test (log simulation). | ws client | P2 |
| `agent_management` | Agent list, health instructions, push subscription. | widget test + integration(fake push). | state layer, push svc | P3 |

### 2.4.5 Cross-layer dependency order
1. Backend `db foundation` + `auth` determines the API/WS protocol → SDK/App generates the client according to the schema.
2. After Backend `realtime` is completed, SDK `ws_client` and App `ws_client` can enter joint debugging.
3. SDK `mcp_server` depends on `ws_client`, `session_manager`, and `project_context`. After completion, external AI can drive the Backend → App task dialogue through the MCP tool.
4. App UI modules all rely on `state layer`, so data and status management must be implemented first, and then gradually unlocked Task List → Chat → Log → Agent management.
5. Integration test sequence: Backend+SDK (task execution link) → Backend+App (task visualization) → full link (E2E).

---

# 3. Data model (technical version)

## Task
```json
{
  "id": "uuid",
  "project_id": "uuid",
  "title": "string",
  "status": "CREATED|RUNNING|DONE|FAILED",
  "created_at": "timestamp"
}
```

## Message
```json
{
  "id": "uuid",
  "task_id": "uuid",
  "role": "user|ai|sdk|system|log",
  "content": "string",
  "timestamp": "timestamp"
}
```

## Agent
```json
{
  "id": "uuid",
  "token": "string",
  "status": "ONLINE|OFFLINE",
  "projects": ["path1", "path2"]
}
```

## TaskSession
```json
{
  "task_id": "uuid",
  "session_id": "string",
  "project_id": "uuid",
  "status": "ACTIVE|ENDED",
  "created_at": "timestamp",
  "last_message_at": "timestamp"
}
```

## MCPMessage
```json
{
  "message_id": "uuid",
  "task_id": "uuid",
  "role": "user|app|sdk|system",
  "content": "markdown string",
  "ack_token": "string",
  "created_at": "timestamp"
}
```

---

# 4. API design (Backend)

## 4.1 REST API

### POST /auth/login
### GET /projects
### GET /tasks?project_id=xxx
### POST /tasks
### GET /tasks/:id/messages
### POST /tasks/:id/messages

## 4.2 WebSocket Channel
- `/ws/app` → app connection
- `/ws/agent` → sdk connection

The backend enters different namespaces based on the connection type.

---

# 5. WebSocket protocol (core)

## 5.1 App → Backend
### Send chat message:
```json
{
  "type": "user_message",
  "task_id": "uuid",
  "content": "string"
}
```

### Send action request:
```json
{
  "type": "action",
  "task_id": "uuid",
  "action": "run_tests",
  "args": {}
}
```

---

## 5.2 Backend → SDK
```json
{
  "type": "task_event",
  "task_id": "uuid",
  "content": "string or action"
}
```

---

## 5.3 SDK → Backend
### AI output
```json
{
  "type": "ai_message",
  "task_id": "uuid",
  "content": "string"
}
```

### Log stream
```json
{
  "type": "log_chunk",
  "task_id": "uuid",
  "content": "partial log"
}
```

### state
```json
{
  "type": "status",
  "agent_id": "uuid",
  "status": "ONLINE|OFFLINE"
}
```

---

# 6. Execution process (technology)

## 6.1 AI reply process
```
App → Backend → SDK
SDK → AI model → SDKSDK → Backend → App
```

## 6.2 Action execution process
```
App → Backend → SDK
SDK → shell subprocess → SDK
SDK → Backend → App (Streaming Log)```

---

# 7. Configuration system (SDK)

`~/.conductor/config.yaml`
```yaml
agent_token: "xxx"
```

---

# 8. Deployment plan

## Backend (recommended):
- Docker Compose（MVP）
- or K8s (production)
- PostgreSQL + Redis
- Nginx reverse proxy

## SDK：
- Local resident process (systemd)
- Mac/Linux/Windows universal

## App：
- iOS / Android released separately

---

# 9. Safe design
- Full link HTTPS/WSS
- Agent Token (outbound only, no service port exposed)
- JWT(App user)
- SDK sandbox (limit executable actions)
- Backend permission verification (task ownership)

---

# 10. Scalability design
-Multi-Agent extension
-Multi-model routing
- Model cache (reduce consumption)
- Perform queuing/concurrency control
- Action Plugin System

---

# 11. Subsequent version planning

## v0.1
- Basic three-layer communication
- Chat + AI reply
- run_tests
- Log stream

## v0.2
- patch generation
- Document analysis
- Action plug-in system

## v0.3
-Multiple Agents
- Project review
- Local LLM backend

---

# 12. Summary
This technical solution is built based on a three-layer architecture: App → Backend → SDK, with clear responsibilities, easy expansion, and security and controllability. The SDK execution layer is responsible for all actual local operations and realizes the core features of Conductor: **Dialogue-driven real local task execution**.



# 13. SDK and Backend WebSocket protocol JSON Schema

> The following is a logical JSON Schema, used to constrain the WS message structure between SDK ↔ Backend (it is not required to be strictly implemented as a JSON Schema file, but can be used as a type definition reference).

## 13.1 General package structure

All messages transmitted via WS use the same:

```json
{
  "type": "string",         
  "request_id": "string",   
  "timestamp": "string",    
  "payload": {}              
}
```

- `type`: Message type enumeration
- `request_id`: Optional, used for request-response pairing (generated by Backend or SDK)
- `timestamp`:ISO 8601 timestamp
- `payload`: Specific content under different types

## 13.2 Messages from Backend → SDK

### 13.2.1 Distributing user messages (AI dialogue)

```json
{
  "type": "task_user_message",
  "request_id": "uuid",
  "timestamp": "2025-01-01T00:00:00Z",
  "payload": {
    "task_id": "uuid",
    "project_id": "uuid",
"content": "Help me analyze the update() of navigation/path_planner.py",    "meta": {
      "user_id": "uuid",
      "conversation_id": "uuid"
    }
  }
}
```

### 13.2.2 Action request (execution instruction)

```json
{
  "type": "task_action",
  "request_id": "uuid",
  "timestamp": "2025-01-01T00:00:00Z",
  "payload": {
    "task_id": "uuid",
    "project_id": "uuid",
    "action": "run_tests",           
    "args": {                         
      "command": "pytest tests/nav"  
    }
  }
}
```

### 13.2.3 Agent configuration update

```json
{
  "type": "agent_config_update",
  "request_id": "uuid",
  "timestamp": "2025-01-01T00:00:00Z",
  "payload": {
    "agent_id": "uuid",
    "configs": {
      "default_model": "gpt-4.1-mini",
      "max_parallel_tasks": 2
    }
  }
}
```

---

## 13.3 Messages from SDK → Backend

### 13.3.1 AI Message

```json
{
  "type": "ai_message",
  "request_id": "uuid",
  "timestamp": "2025-01-01T00:00:01Z",
  "payload": {
    "task_id": "uuid",
    "role": "ai",
"content": "Here are three optimization solutions...",    "meta": {
      "model": "gpt-4.1-mini",
      "tokens": 1234
    }
  }
}
```

### 13.3.2 Log fragmentation (streaming)

```json
{
  "type": "log_chunk",
  "request_id": "uuid",
  "timestamp": "2025-01-01T00:00:02Z",
  "payload": {
    "task_id": "uuid",
    "chunk": "[INFO] Running pytest...",
    "is_last": false
  }
}
```

### 13.3.3 Task status update

```json
{
  "type": "task_status_update",
  "request_id": "uuid",
  "timestamp": "2025-01-01T00:00:03Z",
  "payload": {
    "task_id": "uuid",
    "status": "RUNNING",
    "progress": 0.3,
"summary": "Test is executing",    "meta": {
      "started_at": "2025-01-01T00:00:01Z"
    }
  }
}
```

### 13.3.4 Agent status heartbeat

```json
{
  "type": "agent_heartbeat",
  "request_id": "uuid",
  "timestamp": "2025-01-01T00:00:05Z",
  "payload": {
    "agent_id": "uuid",
    "status": "ONLINE",              
    "version": "0.1.0",
    "projects": [
      {
        "path": "/repo/nav",
        "project_id": "uuid"
      }
    ]
  }
}
```

### 13.3.5 Error reporting

```json
{
  "type": "agent_error",
  "request_id": "uuid",
  "timestamp": "2025-01-01T00:00:06Z",
  "payload": {
    "task_id": "uuid",
    "error_code": "SCRIPT_FAILED",
    "message": "pytest exited with code 1",
    "details": "traceback..."
  }
}
```

## 13.6 MCP Tool Contract

### 13.6.1 create_task_session

**Request**
```json
{
  "task_title": "Fix crash",
  "project_id": "uuid",
"prefill": "User context, optional"}
```

**Response**
```json
{
  "task_id": "uuid",
  "session_id": "string",
  "app_url": "https://app.conductor/tasks/uuid"
}
```

### 13.6.2 send_message

**Request**
```json
{
  "task_id": "uuid",
  "content": "Markdown text with code blocks",
  "metadata": {
    "model": "codex",
    "latency_ms": 1200
  }
}
```

**Response**
```json
{
  "message_id": "uuid",
  "delivered": true
}
```

### 13.6.3 receive_messages

**Request**
```json
{
  "task_id": "uuid",
  "ack_token": "opaque-string",
  "limit": 20
}
```

**Response**
```json
{
  "messages": [
    {
      "message_id": "uuid",
      "role": "user",
"content": "Please update the document",      "ack_token": "opaque-string",
      "created_at": "2025-01-01T00:00:06Z"
    }
  ],
  "next_ack_token": "opaque-string",
  "has_more": false
}
```

### 13.6.4 ack_messages

**Request**
```json
{
  "task_id": "uuid",
  "ack_token": "opaque-string"
}
```

**Response**
```json
{ "status": "ok" }
```

---

# 14. Backend OpenAPI 3.0 interface document (summary)

> A simplified version of the OpenAPI structure is given here to facilitate subsequent export to swagger.yaml / swagger.json.

## 14.1 Info

- title: Conductor Backend API
- version: 0.1.0

## 14.2 Paths (Core)

### POST /auth/login
- Description: Username/password login
- ask:
```json
{
  "email": "string",
  "password": "string"
}
```
- Response:
```json
{
  "access_token": "jwt",
  "refresh_token": "jwt"
}
```

---

### GET /projects
- Description: Get the list of items visible to the current user
- Response example:
```json
[
  {
    "id": "uuid",
    "name": "nav-system",
"description": "Navigation module",    "created_at": "2025-01-01T00:00:00Z"
  }
]
```

### GET /tasks
- Query parameters: `project_id?`, `status?`, paging parameters

### POST /tasks
- Create tasks
```json
{
  "project_id": "uuid",
  "title": "string",
  "description": "string (optional)"
}
```

### GET /tasks/{task_id}
- Return to task details (including recent status)

### GET /tasks/{task_id}/messages
- Return to the message list under this task (pagination)

### POST /tasks/{task_id}/messages
- Send user messages (for AI conversations)
```json
{
  "content": "string"
}
```

### POST /tasks/{task_id}/actions
- Send execution instructions to SDK
```json
{
  "action": "run_tests",
  "args": {
    "command": "pytest tests/nav"
  }
}
```

### GET /agents
- Administrators/users can view their own bound Agent list

### POST /agents/token
- Generate agent_token for SDK registration

---

## 14.3 Components Schemas (schematics)

- `Project`
- `Task`
- `Message`
- `Agent`
- `ActionRequest`
- `User`

Can be converted into full OpenAPI 3.0 documentation when implemented.

---

# 15. Three-terminal directory structure design

## 15.1 App directory structure (Flutter)

```text
conductor_app/
  lib/
    main.dart
    core/
      config/
      network/
      models/
    features/
      auth/
        login_page.dart
        auth_controller.dart
      projects/
        project_list_page.dart
      tasks/
        task_list_page.dart
        task_detail_page.dart
      chat/
        chat_page.dart
        chat_controller.dart
      logs/
        log_viewer_page.dart
    widgets/
      message_bubble.dart
      task_card.dart
      status_chip.dart
  assets/
  test/
```

## 15.2 Backend directory structure (NestJS example)

```text
conductor_backend/
  src/
    main.ts
    app.module.ts
    config/
    common/
      guards/
      interceptors/
      filters/
    auth/
      auth.controller.ts
      auth.service.ts
      auth.module.ts
    users/
    projects/
    tasks/
    messages/
    agents/
    realtime/
      ws.gateway.ts   # WS Hub (App & SDK)
    notify/
      push.service.ts
  prisma/ or entities/
  test/
```

## 15.3 SDK directory structure (Python)

```text
conductor_sdk/
  conductor/
    __init__.py
cli.py # Entry CLI    config/
loader.py # Read yaml    ws/
client.py # WS with Backendhandlers.py #Message processing    mcp/
server.py # MCP Server, register create_task/send_message/receive and other tools + message notificationtools.py #Exposed tool definitions    session/
session_manager.py # Task session and message cache    message/
router.py # Message routing/deduplication    context/
project_context.py # repo meta information, path mapping    reporter/
      event_stream.py
```

---

# 16. Message sequence diagram/architecture diagram (Mermaid)

## 16.1 AI dialogue sequence diagram

```mermaid
sequenceDiagram
    participant U as User (App)
    participant A as App
    participant B as Backend
    participant S as SDK
    participant X as External AI (MCP Client)

U->>A: Enter question    A->>B: POST /tasks/{id}/messages
    B->>S: WS task_user_message
    S->>X: MCP receive_messages
    X-->>S: MCP send_message
    S->>B: WS sdk_message
    B->>A: WS push
A->>U: Show AI reply```

## 16.2 MCP session sequence diagram (create_task + send/receive)

```mermaid
sequenceDiagram
    participant X as External AI (MCP Client)
    participant S as SDK (MCP Server)
    participant B as Backend
    participant A as App
    participant U as User

    X->>S: MCP create_task_session(project, title)
    S->>B: POST /tasks
    B-->>S: task_id
S-->>X: return task_idB->>A: Push new conversation    X->>S: MCP send_message(task_id, content)
    S->>B: WS sdk_message
    B->>A: WS push
A->>U: Display AI messageU->>A: input feedback    A->>B: POST /tasks/{id}/messages
    B->>S: WS task_user_message
    S->>X: MCP receive_messages(task_id)
    X-->>S: ack message_id
```

---

# 17. App UI wireframe (Wireframe, text version)

## 17.1 Home: Project & Task Overview
- Top: Conductor title + user avatar
- Central:
  - Tab1：Projects
  - Tab2：Tasks
- Project card: name / description / number of recent tasks
- Task card: title / status label / update time

## 17.2 Task details page
- Top: Task title + status (color Chip)
- Central:
  - Segment control: Chat | Logs | Info
- Chat：
  - Similar to chat bubble UI
  - Left: AI/system messages
  - Right: User messages
  - Intermediately embed execution logs/status messages
- Bottom input box:
  - Text box + send button
  - Action button bar: Run Tests / Build / Patch / More

## 17.3 Log view
- Similar to terminal style
- support:
  - Automatically scroll to bottom
  - Copy the entire log
  - Distinguish by severity color (INFO/WARN/ERROR)

## 17.4 Agent management page
- List all Agents:
  - name/online status/version
- Click to enter details:
  - Binding project list
  - Recent task execution records

---

# 18. Development roadmap (Roadmap detailed version)

## Phase 0: PoC (1-2 weeks)
- Backend: Simple WS + REST
- SDK: Able to receive text, call AI, and then return text
- App: Web demo or simple Flutter interface

## Phase 1:MVP(4-6 weeks)
- Complete three-layer connectivity
- Task creation/message flow
- AI dialogue
- run_script basic action
- Streaming logs

## Phase 2:Developer Preview(6-8 weeks)
- Actions such as run_tests / build
- patch generation + diff display
- More complete project/task/message data structure
- Basic security solution (JWT + Agent Token)
- iOS/Android TestFlight internal testing

## Phase 3:Beta(8-12 weeks)
-Multi-Agent support
-Multi-model routing
- Better UI/UX
- Operational audit
- More granular permission control

## Phase 4：Public Release
- Documentation & SDK Release
- Plug-in system (custom Action)
- Some open source components (such as SDK)

---

# 19. Test Plan

## 19.1 Test scope
- App (UI & Function)
- Backend（API & WS）
- SDK (task execution & AI calling)
- Three-layer integration (E2E)

## 19.2 Test Types

### 19.2.1 Unit Testing
- Backend：service / controller / repository
- SDK：actions / mcp_server / script_runner
- App: state management logic

### 19.2.2 Integration testing
- Backend + DB + Redis
- SDK connection test environment Backend
- Simulate AI responses

### 19.2.3 End-to-end testing (E2E)
- Scene:
  - Create task → Send message → AI reply
  - Create task → trigger run_tests → generate log → status update
  - Agent disconnected → App status update & prompts

### 19.2.4 Performance Test
- Multitasking concurrently
- Log traffic test (long log)
- WS connection stability

### 19.2.5 Security Testing
- Authentication bypass testing
- Token forgery
- Illegal action injection (such as running commands that are not in the whitelist)

## 19.3 Test environment
- Dev: Local Docker Compose
- Staging: deploy a full set of links in the cloud

## 19.4 Acceptance Criteria
- E2E core process pass rate >= 95%
- Unit test coverage Backend & SDK >= 70%
- Log stream latency is controlled within target (<200ms average)

---

# 20. Summary and additions

The expanded plan.md includes:
- WebSocket protocol JSON Schema
- Backend OpenAPI 3.0 Summary
- Three-terminal directory structure
- Mermaid sequence diagram and architectural logic
- App UI wireframe text description
- More detailed development roadmap and test plan

It can be directly used as the technical blueprint of the project to guide subsequent implementation development and team collaboration.
