# Conductor Flutter App Function and API Documentation

## Overview

Conductor Flutter App is a comprehensive task management and AI conversation application that supports web and native platforms. The application communicates with the backend through REST API and achieves real-time message synchronization through WebSocket.

---

## 1. Function module

### 1.1 Authentication System (Authentication)

**Location**: `lib/src/features/auth/`

**Function**:
- Log in and register with mobile phone number/email
- JWT Token session management
- Persistent storage of authentication status
- Platform specific storage implementation (Web vs Native)

**Key Documents**:
- `auth_page.dart` - Login UI and authentication process
- `auth_repository.dart` - Authentication API call
- `auth_controller.dart` - Certification status management
- `../data/auth_storage.dart` - Token persistent storage

---

### 1.2 Project Management (Projects)

**Location**: `lib/src/features/projects/`

**Function**:
- Create, edit, delete projects
- The project is bound to Daemon (specify local path)
- Filter tasks by project
- Default project protection (cannot be deleted)

**Key Documents**:
- `create_project_dialog.dart` - Project creation/edit dialog
- `project_repository.dart` - Project CRUD operations
- `project_list_controller.dart` - Project status management

---

### 1.3 Task Management (Tasks)

**Location**: `lib/src/features/tasks/`

**Function**:
- Create task (title, initial message, backend type, Agent selection)
- Task list view (status indicator, timestamp)
- Sliding operations (rename, move, delete)
- Task status tracking (CREATED, RUNNING, COMPLETED, etc.)
- Red dot reminder for unread messages
- Pull down to refresh
- Filter tasks by project
- Move tasks across projects

**Key Documents**:
- `task_list_page.dart` - Task list UI, sliding operation
- `create_task_dialog.dart` - Task creation dialog
- `task_repository.dart` - Task CRUD API
- `task_detail_page.dart` - Task details page

---

### 1.4 Chat/Message System (Chat)

**Location**: `lib/src/features/chat/`

**Function**:
- Live chat interface
- Markdown rendering (code blocks, formatting)
- Mermaid chart support
- User/assistant message bubble distinction
- Expandable input box (single line/multi-line switching)
- New messages automatically scroll
- Message cache (offline access)
- Message timestamp display

**Key Documents**:
- `chat_page.dart` - Chat UI, Markdown and Mermaid rendering
- `chat_repository.dart` - Message getting and sending
- `chat_controller.dart` - Chat status management
- `chat_cache.dart` - Message cache

---

### 1.5 Agent/Daemon Management

**Location**: `lib/src/features/agents/`

**Function**:
- List connected Daemon instances
- Backend type selection (each Agent reports supported backends)
- Agent host ID
- The project is bound to Daemon

**Key Documents**:
- `agent_repository.dart` - Agent List API
- `agent_list_provider.dart` - Agent status management

---

### 1.6 Real-time synchronization (WebSocket)

**Location**: `lib/src/sync/` and `lib/src/ws/`

**Function**:
- WebSocket connection (automatic reconnection, 5 seconds retry interval)
- Connection status indicator (green = connected, orange = connecting, red = offline)
- Real-time news updates
- Task status push
- Log streaming
- Backend synchronization after reconnection
- Unread message tracking

**Key Documents**:
- `ws/ws_client.dart` - WebSocket client, reconnection logic
- `ws/ws_event_handler.dart` - WebSocket event handling
- `sync/backend_sync.dart` - Sync when connection is restored
- `ws/message_stream_provider.dart` - WebSocket Streaming Provider

---

### 1.7 Log System (Logs)

**Location**: `lib/src/features/logs/`

**Function**:
- Live log streaming
- Log level color identification (ERROR=red, WARN=orange, INFO=green)
- View logs by task

**Key Documents**:
- `log_view_page.dart` - Log Viewer UI

---

### 1.8 Web-specific functions

**Location**: `lib/src/utils/`

**Function**:
- Cache cleaning (force refresh of web application)
- Home navigation
- Automatically redirect when not authenticated

**Key Documents**:
- `web_cache_web.dart` - Web cache management
- `home_nav_web.dart` - Web Navigation Tool
- `app_redirect_web.dart` - Web redirection logic

---

## 2. API endpoint

### 2.1 HTTP client configuration

**Location**: `lib/src/data/http_client.dart`

**Base URL configuration**:
- Development environment: `http://127.0.0.1:6152/api`
- Production environment: `https://conductor-ai.top/api`
- Vercel: `https://conductor-umber.vercel.app/api`

**Authentication method**: Bearer Token (Authorization Header)
**Timeout Setting**: 15 seconds for both connect and receive

---

### 2.2 Authentication endpoint

| Method | Endpoint | Purpose | Request Body | Response |
|------|------|------|--------|------|
| POST | `/api/auth/request-code` | Request login verification | `{email: string}` or `{phone: string}` | `{accepted: true}` |
| POST | `/api/auth/register` | Register new user | `{email/phone: string, authChallenge: string}` | `{token: string, user: {...}}` |
| POST | `/api/auth/login` | User login | `{identifier: string, authChallenge: string}` | `{token: string, user: {...}}` |
| GET | `/api/auth/me` | Get current user information | - | `{user: {id, email?, phone?}}` |
| GET | `/api/auth/tokens/latest` | Get the latest user Token | - | `{token: string}` |
| POST | `/api/auth/tokens` | Create new user Token | `{}` | `{token: string}` |

---

### 2.3 Project endpoint

| Method | Endpoint | Purpose | Request Body | Response |
|------|------|------|--------|------|
| GET | `/api/projects` | List all items | - | `Array<{id, name, description?, metadata?}>` |
| POST | `/api/projects` | Create Project | `{name, description?, metadata?}` | `{id, name, description?, metadata?}` |
| PATCH | `/api/projects/:projectId` | Update Project | `{name?, description?, metadata?}` | `{id, name, description?, metadata?}` |
| DELETE | `/api/projects/:projectId` | Delete item | - | - |

---

### 2.4 Task endpoint

| Method | Endpoint | Purpose | Request Body/Parameters | Response |
|------|------|------|-------------|------|
| GET | `/api/tasks` | List tasks | Query: `project_id?, status?` | `Array<{id, project_id?, title, status, created_at, updated_at?}>` |
| POST | `/api/tasks` | Create Task | `{project_id, title, backendType?, initialContent?, agent_host?}` | `{id, project_id?, title, status, ...}` |
| PATCH | `/api/tasks/:taskId` | Update task | `{project_id?, title?, status?}` | `{id, project_id?, title, status, ...}` |
| DELETE | `/api/tasks/:taskId` | Delete task | - | - |

---

### 2.5 Message endpoint

| Method | Endpoint | Purpose | Request Body | Response |
|------|------|------|--------|------|
| GET | `/api/tasks/:taskId/messages` | Get task message | - | `Array<{id, task_id, role, content, created_at?}>` |
| POST | `/api/tasks/:taskId/messages` | Send message | `{content: string, role?: string}` | - |

---

### 2.6 Agent endpoint

| Method | Endpoint | Purpose | Parameters | Response |
|------|------|------|------|------|
| GET | `/api/agents` | List connected Agents | Query: `project_id?` | `Array<{id, host, supportedBackends?}>` |

---

## 3. WebSocket connection

### 3.1 Connection configuration

**URL format**: `ws://127.0.0.1:6152/ws/app?token={userToken}` (HTTPS uses wss://)

**Location**: `lib/src/ws/message_stream_provider.dart`

### 3.2 WebSocket events

| Event type | Purpose | Payload structure |
|----------|------|--------------|
| `task_user_message` | User message update | `{type, payload: {id, task_id, role, content, created_at}}` |
| `task_sdk_message` | SDK/Assistant Message Update | `{type, payload: {id, task_id, role, content, created_at}}` |
| `task_log_chunk` | Task log stream | `{type, payload: {task_id, level, chunk}}` |
| `task_status_update` | Task status change | `{type, payload: {task_id, status}}` |

**Event processing location**: `lib/src/ws/ws_event_handler.dart`

---

## 4. Data model

### 4.1 AuthUser
```dart
{
  id: String,
  email?: String,
  phone?: String
}
```
**Location**: `lib/src/models/auth_models.dart`

### 4.2 AuthSession
```dart
{
jwtToken: String, // JWT for API authenticationuserToken: String, // Token for WebSocket connection  user: AuthUser
}
```
**Location**: `lib/src/models/auth_models.dart`

### 4.3 Project
```dart
{
  id: String,
  name: String,
  description?: String,
metadata?: Map<String, dynamic> // Contains localPaths: {daemonName: path}}
```
**Special Properties**: `boundDaemonNames` - Extract daemon name from metadata.localPaths

**Location**: `lib/src/models/project.dart`

### 4.4 Task
```dart
{
  id: String,
  projectId?: String,
  title: String,
status: String, // CREATED, RUNNING, COMPLETED, etc.  createdAt: DateTime,
  updatedAt?: DateTime
}
```
**Location**: `lib/src/models/task.dart`

### 4.5 Message
```dart
{
  id: String,
  taskId: String,
role: String, // 'user' or 'assistant'content: String, // Markdown content, may include mermaid charts  createdAt?: DateTime
}
```
**Location**: `lib/src/models/message.dart`

### 4.6 Agent
```dart
{
  id: String,
host: String, // Daemon host name/identitysupportedBackends: String[] // Such as ['claude', 'openai', 'kimi']}
```
**Location**: `lib/src/models/agent.dart`

### 4.7 LogEntry
```dart
{
  level: String,         // INFO, WARN, ERROR
  message: String
}
```
**Location**: `lib/src/models/log_entry.dart`

---

## 5. Status management

The application uses **Riverpod** for state management.

### Core Providers

| Provider | Purpose |
|----------|------|
| `appConfigProvider` | Application configuration (Base URL, WebSocket URL) |
| `authStorageProvider` | Persistent authentication storage |
| `apiClientProvider` | HTTP client with authentication interceptor |
| `authControllerProvider` | Certification status |
| `wsClientProvider` | WebSocket Client |
| `wsMessageStreamProvider` | WebSocket message flow |
| `wsConnectionStatusProvider` | WebSocket connection status |

### Function Providers

| Provider | Purpose |
|----------|------|
| `taskListProvider` | Task List Status |
| `projectListProvider` | Project List Status |
| `agentListProvider` | Agent list status |
| `chatProvider(taskId)` | Chat messages by task |
| `logEntriesProvider(taskId)` | Log entries by task |
| `unreadTaskProvider` | Unread task tracking |

---

## 6. Technology stack

| Dependencies | Version | Purpose |
|------|------|------|
| Flutter SDK | ^3.5.0 | Framework |
| flutter_riverpod | ^2.5.1 | State management |
| dio | ^5.7.0 | HTTP client |
| web_socket_channel | ^2.4.0 | WebSocket |
| flutter_markdown | ^0.7.3 | Markdown rendering |
| intl | ^0.19.0 | date formatting |
| html | ^0.15.6 | HTML parsing |

---

## 7. Function summary

1. **Authentication** - Log in with mobile number/email
2. **Project Management** - Create and organize projects, bind Daemon
3. **Task Management** - Create, update, delete tasks, sliding gesture operations
4. **Live Chat** - Markdown chat, supports Mermaid charts
5. **Agent Management** - Connect multiple conductor-daemon instances
6. **Real-time updates** - WebSocket real-time synchronization
7. **Log System** - Real-time task execution log stream
8. **Offline support** - message caching, reconnection synchronization
