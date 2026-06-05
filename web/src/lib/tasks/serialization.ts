import {
  normalizeTaskStatus,
  normalizeTaskType,
  parseJsonObject,
} from '@/lib/tasks/task-config';

type SerializablePtySession = {
  id: string;
  taskId: string;
  state: string;
  entrypointType: string | null;
  toolPreset: string | null;
  commandJson: string | null;
  cwd: string | null;
  envJson: string | null;
  shell: string | null;
  pid: number | null;
  cols: number | null;
  rows: number | null;
  lastOutputSeq: number;
  startedAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type SerializableAttachedTerminalSummary = {
  id: string;
  ptyTaskId: string;
  ptyTaskStatus: string | null;
};

type SerializableTask = {
  id: string;
  projectId: string;
  issueId?: string | null;
  title: string;
  taskType?: string | null;
  status: string;
  agentHost: string | null;
  executionHost: string | null;
  backendType: string | null;
  sessionId: string | null;
  sessionFilePath: string | null;
  launchConfig?: unknown;
  metadata: unknown;
  lastUserMessage?: string | null;
  lastAssistantMessage?: string | null;
  createdAt: Date;
  updatedAt: Date;
  ptySession?: SerializablePtySession | null;
  attachedTerminal?: SerializableAttachedTerminalSummary | null;
};

const serializePtySession = (ptySession: SerializablePtySession | null) =>
  ptySession
    ? {
        id: ptySession.id,
        task_id: ptySession.taskId,
        state: ptySession.state,
        entrypoint_type: ptySession.entrypointType,
        tool_preset: ptySession.toolPreset,
        command: parseJsonObject(ptySession.commandJson),
        cwd: ptySession.cwd,
        env: parseJsonObject(ptySession.envJson),
        shell: ptySession.shell,
        pid: ptySession.pid,
        cols: ptySession.cols,
        rows: ptySession.rows,
        last_output_seq: ptySession.lastOutputSeq,
        started_at: ptySession.startedAt?.toISOString() ?? null,
        closed_at: ptySession.closedAt?.toISOString() ?? null,
        created_at: ptySession.createdAt.toISOString(),
        updated_at: ptySession.updatedAt.toISOString(),
      }
    : null;

export const serializeTaskResponse = (task: SerializableTask) => ({
  id: task.id,
  project_id: task.projectId,
  issue_id: task.issueId ?? null,
  title: task.title,
  task_type: normalizeTaskType(task.taskType),
  status: normalizeTaskStatus(task.status),
  agent_host: task.agentHost,
  execution_host: task.executionHost,
  backend_type: task.backendType,
  session_id: task.sessionId,
  session_file_path: task.sessionFilePath,
  launch_config: parseJsonObject(task.launchConfig),
  metadata: parseJsonObject(task.metadata),
  last_user_message: task.lastUserMessage ?? null,
  last_assistant_message: task.lastAssistantMessage ?? null,
  created_at: task.createdAt.toISOString(),
  updated_at: task.updatedAt.toISOString(),
  pty_session: serializePtySession(task.ptySession ?? null),
  attached_terminal: task.attachedTerminal
    ? {
        id: task.attachedTerminal.id,
        pty_task_id: task.attachedTerminal.ptyTaskId,
        pty_task_status: task.attachedTerminal.ptyTaskStatus
          ? normalizeTaskStatus(task.attachedTerminal.ptyTaskStatus)
          : null,
      }
    : null,
});
