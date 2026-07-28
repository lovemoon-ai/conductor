import { randomUUID } from "crypto";
import { enqueueAndAttemptAgentCommand } from "@/lib/realtime/agent-outbox";
import {
  normalizeOptionalString,
  normalizePositiveInteger,
  parseJsonObject,
  type JsonObject,
} from "./task-config";
import { isConductorFireHost } from "@/lib/subscription/plan-limits";

export type ConnectedAgent = {
  id: string;
  host: string;
  supportedBackends: string[];
  capabilities: string[];
};

const PTY_TASK_CAPABILITY = "pty_task";

export const normalizeBackendType = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized || null;
};

const hasOwn = (value: JsonObject | null, key: string): boolean =>
  Boolean(value) && Object.prototype.hasOwnProperty.call(value, key);

const parsePositiveTerminalDimension = (value: unknown): number | null =>
  normalizePositiveInteger(value);

export const validatePtyLaunchConfig = (launchConfig: JsonObject | null): string | null => {
  if (!launchConfig) return null;

  if (
    (hasOwn(launchConfig, "cols") || hasOwn(launchConfig, "columns")) &&
    parsePositiveTerminalDimension(launchConfig.cols ?? launchConfig.columns) === null
  ) {
    return "launch_config.cols must be a positive integer";
  }

  if (
    hasOwn(launchConfig, "rows") &&
    parsePositiveTerminalDimension(launchConfig.rows) === null
  ) {
    return "launch_config.rows must be a positive integer";
  }

  return null;
};

export const buildPtySessionConfigPatch = (launchConfig: JsonObject | null) => {
  const command = normalizeOptionalString(launchConfig?.command);
  const args = Array.isArray(launchConfig?.args)
    ? launchConfig.args.filter((value): value is string => typeof value === "string")
    : [];
  const env = parseJsonObject(launchConfig?.env);

  return {
    entrypointType:
      normalizeOptionalString(launchConfig?.entrypoint_type) ??
      normalizeOptionalString(launchConfig?.entrypointType),
    toolPreset:
      normalizeOptionalString(launchConfig?.tool_preset) ??
      normalizeOptionalString(launchConfig?.toolPreset),
    commandJson:
      command || args.length > 0
        ? JSON.stringify({
            ...(command ? { command } : {}),
            ...(args.length > 0 ? { args } : {}),
          })
        : null,
    cwd: normalizeOptionalString(launchConfig?.cwd),
    envJson: env ? JSON.stringify(env) : null,
    shell: normalizeOptionalString(launchConfig?.shell),
    cols: parsePositiveTerminalDimension(launchConfig?.cols ?? launchConfig?.columns),
    rows: parsePositiveTerminalDimension(launchConfig?.rows),
  };
};

export const buildPtySessionCreateSeed = (
  taskId: string,
  launchConfig: JsonObject | null,
) => ({
  taskId,
  state: "pending",
  ...buildPtySessionConfigPatch(launchConfig),
});

export const buildPtySessionRestartPatch = (launchConfig: JsonObject | null) => ({
  state: "pending",
  pid: null,
  lastOutputSeq: 0,
  startedAt: null,
  closedAt: null,
  ...buildPtySessionConfigPatch(launchConfig),
});

const resolvePtyRequiredBackend = (
  requestedBackendType: string | null,
  launchConfig: JsonObject | null,
): string | null =>
  normalizeBackendType(
    requestedBackendType ??
      launchConfig?.backendType ??
      launchConfig?.toolPreset ??
      launchConfig?.tool_preset,
  );

const supportsPtyTask = (
  agent: ConnectedAgent,
  requiredBackendType: string | null,
): boolean =>
  !isConductorFireHost(agent.host) &&
  agent.capabilities.includes(PTY_TASK_CAPABILITY) &&
  (!requiredBackendType ||
    agent.supportedBackends.length === 0 ||
    agent.supportedBackends.includes(requiredBackendType));

const pickDefaultPtyAgentHost = (
  agents: ConnectedAgent[],
  requiredBackendType: string | null,
): string | undefined =>
  (requiredBackendType
    ? agents.find((agent) => supportsPtyTask(agent, requiredBackendType))?.host
    : undefined) ??
  agents.find((agent) => supportsPtyTask(agent, null))?.host;

export const resolvePtyAgentHost = (args: {
  connectedAgents: ConnectedAgent[];
  requestedAgentHost?: string | null;
  requestedBackendType: string | null;
  launchConfig: JsonObject | null;
}):
  | {
      agentHost: string;
      requiredBackendType: string | null;
    }
  | {
      agentHost: null;
      requiredBackendType: string | null;
      error: string;
      status: number;
    } => {
  const requiredBackendType = resolvePtyRequiredBackend(
    args.requestedBackendType,
    args.launchConfig,
  );
  const requestedAgent = args.requestedAgentHost
    ? args.connectedAgents.find((agent) => agent.host === args.requestedAgentHost) ?? null
    : null;

  if (args.requestedAgentHost) {
    if (!requestedAgent) {
      return {
        agentHost: null,
        requiredBackendType,
        error: `PTY-capable daemon ${args.requestedAgentHost} is not connected`,
        status: 409,
      };
    }
    if (!supportsPtyTask(requestedAgent, requiredBackendType)) {
      return {
        agentHost: null,
        requiredBackendType,
        error: requiredBackendType
          ? `Agent ${args.requestedAgentHost} does not support PTY task preset ${requiredBackendType}`
          : `Agent ${args.requestedAgentHost} does not support PTY tasks`,
        status: 409,
      };
    }
    return {
      agentHost: args.requestedAgentHost,
      requiredBackendType,
    };
  }

  const pickedHost = pickDefaultPtyAgentHost(args.connectedAgents, requiredBackendType) ?? null;
  if (!pickedHost) {
    return {
      agentHost: null,
      requiredBackendType,
      error: requiredBackendType
        ? `No PTY-capable daemon online for preset ${requiredBackendType}`
        : "No PTY-capable daemon online",
      status: 409,
    };
  }

  return {
    agentHost: pickedHost,
    requiredBackendType,
  };
};

export const pickDefaultAgentHost = (
  agents: ConnectedAgent[],
  requestedBackendType: string | null,
): string | undefined => {
  const daemonAgents = agents.filter((agent) => !isConductorFireHost(agent.host));
  if (daemonAgents.length === 0) return undefined;

  const findHost = (predicate: (agent: ConnectedAgent) => boolean): string | undefined =>
    daemonAgents.find(predicate)?.host;

  if (requestedBackendType) {
    return findHost((agent) => agent.supportedBackends.includes(requestedBackendType));
  }

  return (
    findHost((agent) => agent.supportedBackends.length > 0) ||
    daemonAgents[0].host
  );
};

export async function dispatchPtyTaskCreation(args: {
  userId: string;
  agentHost: string;
  task: { id: string; projectId: string; title: string };
  ptySessionId: string;
  launchConfig: JsonObject | null;
  bindTaskToAgent: (taskId: string, agentHost: string) => void;
  sendToAgentHost: (args: {
    userId: string;
    agentHost: string;
    envelope: Record<string, unknown>;
  }) => boolean;
  resolveTaskHost: (taskId: string) => string | null;
}) {
  args.bindTaskToAgent(args.task.id, args.agentHost);
  const requestId = randomUUID();
  await enqueueAndAttemptAgentCommand(
    {
      userId: args.userId,
      agentHost: args.agentHost,
      taskId: args.task.id,
      eventType: "create_pty_task",
      requestId,
      envelope: {
        type: "create_pty_task",
        payload: {
          task_id: args.task.id,
          project_id: args.task.projectId,
          title: args.task.title,
          pty_session_id: args.ptySessionId,
          launch_config: args.launchConfig ?? undefined,
          request_id: requestId,
        },
      },
    },
    {
      agentHost: args.agentHost,
      sendToAgentHost: args.sendToAgentHost,
      resolveTaskHost: args.resolveTaskHost,
    },
  );
}
