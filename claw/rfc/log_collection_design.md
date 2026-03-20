# Fire log passive collection system design
## Overview
**Passive on-demand pull** mode: logs are only collected during diagnosis, with Daemon as a unified agent and finding the Fire log location by reading the local Session file.
## Architecture
```
┌─────────────┐ WebSocket ┌─────────────┐ Read file ┌─────────────────────────┐│   Server    │ ◄──────────────────► │   Daemon    │ ◄────────────────► │  Session + conductor.log │
│ (Diagnostic trigger) │ collect_logs │ (Log agent) │ │ ~/.conductor/sessions/ ││             │ ◄──────────────────  │             │                    │  {project}/conductor.log │
│             │   agent_log_collected│             │                    │                          │
└─────────────┘                      └─────────────┘                    └─────────────────────────┘
```

## Core process
1. **Server initiates diagnosis** → call `buildTaskDiagnosticsPayload()`
2. **Find Daemon** → Get the bound daemon through `realtimeHub.getTaskAgentHost(taskId)`
3. **Send collection command** → WebSocket sends `collect_logs` to daemon
4. **Daemon location log** → Use `SessionDiskStore.findByTaskId(taskId)` to find `project_path`
5. **Read log file** → Read `${project_path}/conductor.log`
6. **Return to log** → WebSocket returns `agent_log_collected`
7. **Diagnosis display** → Server integrates logs into diagnostic results
## Module design
### 
1. Daemon log collection module
**File**: `cli/src/daemon/log-collector.ts`
```typescript
export class DaemonLogCollector {
  constructor(backendUrl: string) {
    this.sessionStore = SessionDiskStore.forBackendUrl(backendUrl);
  }

  collect(taskId: string, options: {
tailLines?: number; //default 200since?: string; // ISO timestamp, filter time  }): CollectLogsResult | null
}
```

**Log parsing format**:```
[2026-03-08T10:30:01+08:00] [INFO] [runTurn:start] requestId=req-123
[2026-03-08T10:30:05+08:00] [ERROR] [runTurn:failed] error="PTY session already spawned"
```

### 2. WebSocket protocol extension
**Server → Daemon**:
```json
{
  "type": "collect_logs",
  "payload": {
    "request_id": "uuid",
    "task_id": "task-uuid",
    "options": {
      "tail_lines": 100,
      "since": "2026-03-08T10:00:00Z"
    }
  }
}
```

**Daemon → Server**:
```json
{
  "type": "agent_log_collected",
  "payload": {
    "request_id": "uuid",
    "task_id": "task-uuid",
    "project_path": "<project-root>",
    "log_path": "<project-root>/conductor.log",
    "logs": [
      {"timestamp": "...", "level": "INFO", "message": "..."}
    ],
    "truncated": false,
    "collected_at": "2026-03-08T10:35:00Z"
  }
}
```

### 3. Session file format (existing)
**Path**: `~/.conductor/sessions/{host}.yaml`
```yaml
sessions:
  - project_id: proj-123
task_id: [task-abc, task-def] # or a single string    project_path: <project-root>
    session_id: sess-xyz
    backend_type: codex
    hostname: macbook-pro
```

### 4. Integration of diagnostic results
```typescript
// TaskDiagnosticsPayload extension{
// ... existing fields ...  fire_logs: {
    daemon_host: string;
    project_path: string;
    log_path: string;
    entries: Array<{
      timestamp: string;
      level: string;
      message: string;
    }>;
    truncated: boolean;
    error?: string;
    collected_at: string;
  } | null;
}
```

## Key Design Decisions
| Decision | Description ||-----|------|
| **Passive trigger** | Only collected when the diagnostic API is called, no ongoing overhead || **Daemon agent** | Fire is unaware and does not increase Fire code complexity || **Session File Index** | Reuse existing `SessionDiskStore`, no additional metadata files required || **Local log path** | `${projectPath}/conductor.log`, consistent with Fire's existing behavior || **Tail mode** | Read only the last N lines (default 200) to avoid large file transfers || **Time filter** | Supports `since` parameter, only returns diagnosis-related period |
## Implementation steps
### P0 - Core Functions1. [ ] `cli/src/daemon/log-collector.ts` - Daemon log collection module2. [ ] `cli/src/daemon.js` - integrated `collect_logs` command processing3. [ ] `web/src/lib/realtime/hub.ts` - Add `agent_log_collected` event support4. [ ] `web/src/lib/diagnostics/task-diagnostics.ts` - Integrated log collection request
### P1 - Optimization5. [ ] Log level filtering (error/warn/info)6. [ ] Keyword search support7. [ ] Server-side log archiving (optional)
## Dependencies
- **SDK**: `SessionDiskStore.forBackendUrl()` (already exists)- **Session file**: `~/.conductor/sessions/{host}.yaml` (already exists)- **Fire Log**: `${projectPath}/conductor.log` (already exists)
## Notes
1. **Session file may not exist**: If Fire is started directly (not started by daemon), there may be no session record2. **Log file may not exist**: Fire may not generate `conductor.log` (such as `CONDUCTOR_CLI_COMMAND` mode)3. **Concurrent diagnosis**: It is necessary to consider the situation of multiple diagnosis of the same task in a short period of time (cache can be added)4. **Large log files**: Need to limit the read size to avoid memory problems
## Failure handling
| Scene | Behavior ||-----|------|
| Session file does not exist | Return `error: "Task not found in session store"` || Log file does not exist | Return `error: "Log file not found"` || Read failed | Return `error: "Failed to read log file"` || Daemon not responding | Return `error: "Timeout waiting for logs"` || The log is too large | Return `truncated: true`, only the tail is returned |