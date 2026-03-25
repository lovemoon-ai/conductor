#!/usr/bin/env node

import process from "node:process";
import yargs from "yargs/yargs";
import { hideBin } from "yargs/helpers";

import { loadConfig } from "@love-moon/conductor-sdk";

const CLI_NAME = process.env.CONDUCTOR_CLI_NAME || "conductor diagnose";
const DEFAULT_TIMEOUT_MS = 8000;

const args = yargs(hideBin(process.argv))
  .scriptName(CLI_NAME)
  .usage("Usage: $0 <task-id> [options]")
  .option("config-file", {
    type: "string",
    describe: "Path to Conductor config file",
  })
  .option("json", {
    type: "boolean",
    default: false,
    describe: "Print raw JSON output",
  })
  .option("timeout-ms", {
    type: "number",
    default: DEFAULT_TIMEOUT_MS,
    describe: "HTTP timeout in milliseconds",
  })
  .example("$0 3b3e09b8-6d6f-4f3b-9f2f-3fca86b9e3cb", "Diagnose a task")
  .example("$0 3b3e09b8-6d6f-4f3b-9f2f-3fca86b9e3cb --json", "Diagnose and print JSON")
  .demandCommand(1, "task-id is required")
  .help()
  .strictOptions()
  .parse();

const taskId = String(args._[0] || "").trim();
if (!taskId) {
  process.stderr.write("task-id is required\n");
  process.exit(1);
}

main().catch((error) => {
  process.stderr.write(`diagnose failed: ${error?.message || error}\n`);
  process.exit(1);
});

async function main() {
  const config = loadConfig(args.configFile);
  const timeoutMs = normalizePositiveInt(args.timeoutMs, DEFAULT_TIMEOUT_MS);
  const baseUrl = String(config.backendUrl || "").replace(/\/+$/, "");
  const endpoint = `${baseUrl}/api/diagnostics/tasks/${encodeURIComponent(taskId)}`;

  const full = await fetchJson(endpoint, config.agentToken, timeoutMs);
  let report;
  if (full.ok) {
    report = {
      mode: "full",
      endpoint,
      payload: full.body,
    };
  } else if (full.status === 404) {
    const fallback = await runFallbackDiagnosis(baseUrl, config.agentToken, taskId, timeoutMs);
    report = {
      mode: "fallback",
      endpoint,
      payload: fallback,
      note: "backend does not expose /api/diagnostics/tasks/:taskId yet",
    };
  } else {
    const body = full.body && typeof full.body === "object" ? full.body : null;
    const msg = body?.error || body?.message || `HTTP ${full.status}`;
    throw new Error(`diagnostics request failed: ${msg}`);
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  printReport(taskId, report);
}

async function runFallbackDiagnosis(baseUrl, token, taskId, timeoutMs) {
  const taskResp = await fetchJson(`${baseUrl}/api/tasks/${encodeURIComponent(taskId)}`, token, timeoutMs);
  if (!taskResp.ok) {
    throw new Error(`fallback: failed to fetch task (${taskResp.status})`);
  }

  const msgResp = await fetchJson(
    `${baseUrl}/api/tasks/${encodeURIComponent(taskId)}/messages`,
    token,
    timeoutMs,
  );
  if (!msgResp.ok) {
    throw new Error(`fallback: failed to fetch messages (${msgResp.status})`);
  }

  const agentsResp = await fetchJson(`${baseUrl}/api/agents`, token, timeoutMs);
  if (!agentsResp.ok) {
    throw new Error(`fallback: failed to fetch agents (${agentsResp.status})`);
  }

  const task = taskResp.body || {};
  const messages = normalizeMessageHistoryPayload(msgResp.body);
  const agents = Array.isArray(agentsResp.body) ? agentsResp.body : [];

  const latestUser = messages
    .filter((m) => normalizeRole(m?.role) === "user")
    .sort((a, b) => toMs(b?.created_at || b?.createdAt) - toMs(a?.created_at || a?.createdAt))[0] || null;
  const latestSdk = messages
    .filter((m) => {
      const role = normalizeRole(m?.role);
      return role === "sdk" || role === "assistant";
    })
    .sort((a, b) => toMs(b?.created_at || b?.createdAt) - toMs(a?.created_at || a?.createdAt))[0] || null;

  const latestUserMs = toMs(latestUser?.created_at || latestUser?.createdAt);
  const latestSdkMs = toMs(latestSdk?.created_at || latestSdk?.createdAt);
  const hasPendingUser = Boolean(latestUser && (!latestSdk || latestUserMs > latestSdkMs));
  const pendingAgeMs = hasPendingUser && Number.isFinite(latestUserMs) ? Date.now() - latestUserMs : null;
  const latestSdkFailureKey = detectExecutionFailureLoopKey(latestSdk?.content);

  const assignedHost = cleanText(
    task?.execution_host || task?.executionHost || task?.agent_host || task?.agentHost,
  );
  const assignedConnected = Boolean(
    assignedHost && agents.some((agent) => cleanText(agent?.host) === assignedHost),
  );

  const diagnosis = classifyFallback({
    taskStatus: normalizeTaskStatus(task?.status),
    hasPendingUser,
    pendingAgeMs,
    latestSdkFailureKey,
    assignedHost,
    assignedConnected,
  });

  return {
    task: {
      id: task?.id || taskId,
      status: normalizeTaskStatus(task?.status),
      agent_host: assignedHost || null,
      execution_host: cleanText(task?.execution_host || task?.executionHost) || null,
    },
    messages: {
      total: messages.length,
      latest_user: latestUser,
      latest_sdk: latestSdk,
      latest_sdk_failure_key: latestSdkFailureKey,
      has_pending_user: hasPendingUser,
      pending_age_ms: pendingAgeMs,
    },
    realtime: {
      connected_agents: agents,
      assigned_host_connected: assignedConnected,
    },
    diagnosis,
  };
}

function normalizeMessageHistoryPayload(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (payload && typeof payload === "object" && Array.isArray(payload.messages)) {
    return payload.messages;
  }
  return [];
}

function classifyFallback(input) {
  if (input.taskStatus === "completed" || input.taskStatus === "killed") {
    return {
      code: "task_terminal",
      confidence: "high",
      summary: `task is already ${input.taskStatus}`,
      reasons: [`task.status=${input.taskStatus}`],
      next_actions: [],
    };
  }

  if (!input.hasPendingUser) {
    if (input.latestSdkFailureKey) {
      return {
        code: "execution_failure_loop",
        confidence: "high",
        summary: "latest sdk message indicates execution-layer failure loop",
        reasons: [
          "latest user message is not newer than latest sdk message",
          `latest sdk failure key=${input.latestSdkFailureKey}`,
        ],
        next_actions: [
          "restart task-scoped fire process and verify PTY child cleanup",
          "if repeated, create a new task and terminate old stuck task",
        ],
      };
    }
    return {
      code: "no_pending_user",
      confidence: "high",
      summary: "no pending user message newer than last sdk reply",
      reasons: ["latest user message is not newer than latest sdk message"],
      next_actions: [],
    };
  }

  if (!input.assignedConnected) {
    return {
      code: "likely_ws_or_routing_issue",
      confidence: "high",
      summary: "pending user message and assigned agent is offline",
      reasons: [
        "latest user message is pending",
        input.assignedHost ? `assigned host ${input.assignedHost} is not connected` : "task has no assigned host",
      ],
      next_actions: [
        "check fire/daemon websocket reconnect logs",
        "verify task binding and outbox delivery on backend",
      ],
    };
  }

  if (typeof input.pendingAgeMs === "number" && input.pendingAgeMs > 120000) {
    return {
      code: "likely_runturn_stuck",
      confidence: "medium",
      summary: "agent is online but pending user message has waited >120s",
      reasons: [
        "assigned host is still connected",
        `pending age ${Math.round(input.pendingAgeMs / 1000)}s`,
      ],
      next_actions: [
        "inspect fire log for repeated turn waiting on same replyTo",
        "enable CONDUCTOR_TUI_TRACE=1 to confirm driver state progression",
      ],
    };
  }

  return {
    code: "pending_but_processing",
    confidence: "low",
    summary: "pending user message exists but may still be processing",
    reasons: [
      "assigned host is connected",
      typeof input.pendingAgeMs === "number" ? `pending age ${Math.round(input.pendingAgeMs / 1000)}s` : "pending age unknown",
    ],
    next_actions: [],
  };
}

function printReport(taskId, report) {
  const payload = report?.payload || {};
  const diagnosis = payload?.diagnosis || {};
  const task = payload?.task || {};
  const realtime = payload?.realtime || {};
  const ptyTransport = payload?.pty_transport || payload?.ptyTransport || {};
  const messages = payload?.messages || {};

  process.stdout.write(`Task: ${task?.id || taskId}\n`);
  process.stdout.write(`Mode: ${report.mode}${report.note ? ` (${report.note})` : ""}\n`);
  process.stdout.write(`Verdict: ${String(diagnosis.code || "unknown")} (${String(diagnosis.confidence || "unknown")})\n`);
  process.stdout.write(`Summary: ${String(diagnosis.summary || "n/a")}\n`);
  process.stdout.write("\n");
  process.stdout.write("Signals:\n");
  process.stdout.write(`- task.status: ${String(task?.status || "unknown")}\n`);
  process.stdout.write(`- task.agent_host: ${String(task?.agent_host || task?.agentHost || "n/a")}\n`);
  process.stdout.write(`- task.execution_host: ${String(task?.execution_host || task?.executionHost || "n/a")}\n`);
  process.stdout.write(`- bound_agent_host: ${String(realtime?.bound_agent_host || realtime?.boundAgentHost || "n/a")}\n`);
  process.stdout.write(
    `- pending user: ${Boolean(messages?.has_pending_user ?? messages?.hasPendingUser)}${
      typeof (messages?.pending_age_ms ?? messages?.pendingAgeMs) === "number"
        ? ` (${Math.round((messages?.pending_age_ms ?? messages?.pendingAgeMs) / 1000)}s)`
        : ""
    }\n`,
  );
  if (payload?.outbox) {
    process.stdout.write(`- outbox.available: ${Boolean(payload.outbox.available)}\n`);
    if (payload.outbox.latest_for_pending_user) {
      process.stdout.write(
        `- outbox.latest_for_pending_user: ${String(payload.outbox.latest_for_pending_user.status || "unknown")} (${String(
          payload.outbox.latest_for_pending_user.last_error || "no_error",
        )})\n`,
      );
    }
  }
  const latestLatency = ptyTransport?.latest_latency_sample || ptyTransport?.latestLatencySample;
  if (latestLatency) {
    process.stdout.write(
      `- pty.latest_latency: client->server=${formatLatencyMs(
        latestLatency.client_input_to_server_received_ms ?? latestLatency.clientInputToServerReceivedMs,
      )}, server->daemon=${formatLatencyMs(
        latestLatency.server_received_to_daemon_received_ms ?? latestLatency.serverReceivedToDaemonReceivedMs,
      )}, daemon->first_output=${formatLatencyMs(
        latestLatency.daemon_input_to_first_output_ms ?? latestLatency.daemonInputToFirstOutputMs,
      )}, client->first_output=${formatLatencyMs(
        latestLatency.client_input_to_first_output_ms ?? latestLatency.clientInputToFirstOutputMs,
      )}\n`,
    );
    process.stdout.write(
      `- pty.primary_bottleneck: ${String(
        ptyTransport?.primary_bottleneck || ptyTransport?.primaryBottleneck || "unknown",
      )}\n`,
    );
  }

  const reasons = Array.isArray(diagnosis.reasons) ? diagnosis.reasons : [];
  if (reasons.length > 0) {
    process.stdout.write("\nReasons:\n");
    for (const reason of reasons) {
      process.stdout.write(`- ${reason}\n`);
    }
  }

  const nextActions = Array.isArray(diagnosis.next_actions) ? diagnosis.next_actions : [];
  if (nextActions.length > 0) {
    process.stdout.write("\nNext Actions:\n");
    for (const action of nextActions) {
      process.stdout.write(`- ${action}\n`);
    }
  }
}

async function fetchJson(url, token, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    const body = await parseJsonSafe(response);
    return {
      ok: response.ok,
      status: response.status,
      body,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function parseJsonSafe(response) {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function normalizeRole(role) {
  return cleanText(role).toLowerCase();
}

function normalizeTaskStatus(status) {
  const normalized = cleanText(status).toLowerCase();
  if (normalized === "completed") return "completed";
  if (normalized === "init") return "init";
  if (normalized === "running") return "running";
  if (normalized === "killed" || normalized === "failed" || normalized === "cancelled") return "killed";
  return normalized || "unknown";
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function toMs(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : NaN;
}

function detectExecutionFailureLoopKey(value) {
  const normalized = cleanText(value).toLowerCase();
  if (!normalized) return null;
  if (normalized.includes("pty session already spawned")) return "pty_session_already_spawned";
  if (
    normalized.includes("tui process has exited") ||
    normalized.includes("cannot proceed: tui process has exited")
  ) {
    return "tui_process_exited";
  }
  if (normalized.includes("execution_failure_loop")) return "execution_failure_loop";
  return null;
}

function formatLatencyMs(value) {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) && num >= 0 ? `${Math.round(num)}ms` : "n/a";
}

function normalizePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
