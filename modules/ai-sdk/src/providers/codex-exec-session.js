import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import readline from "node:readline";

import { CODEX_EXEC_VARIANT as CODEX_EXEC_PROVIDER_VARIANT } from "../built-in-backends.js";
import {
  emitLog,
  getBoundedEnvInt,
  loadEnvConfig,
  normalizeLogger,
  parseCommandParts,
  proxyToEnv,
  sanitizeForLog,
} from "../shared.js";

const DEFAULT_TURN_DEADLINE_MS = 12 * 60 * 1000;
const MIN_TURN_DEADLINE_MS = 30 * 1000;
const MAX_TURN_DEADLINE_MS = 30 * 60 * 1000;
const DEFAULT_CODEX_EXEC_COMMAND = "codex";

function createTurnError(message, extras = {}) {
  const error = new Error(message);
  for (const [key, value] of Object.entries(extras)) {
    error[key] = value;
  }
  return error;
}

function buildEmptyTurnResult() {
  return {
    text: "",
    usage: null,
    items: [],
    events: [],
  };
}

function isCodexBackend(backend) {
  const normalized = String(backend || "").trim().toLowerCase();
  return normalized === "codex" || normalized === "code";
}

function normalizeCodexBackend(backend) {
  return isCodexBackend(backend) ? "codex" : String(backend || "codex").trim().toLowerCase();
}

function normalizeJsonSchema(jsonSchema) {
  if (!jsonSchema) {
    return null;
  }
  if (typeof jsonSchema === "string") {
    return JSON.parse(jsonSchema);
  }
  if (typeof jsonSchema === "object") {
    return jsonSchema;
  }
  return null;
}

function buildHistoryPrompt(history, promptText) {
  const normalizedPrompt = typeof promptText === "string" ? promptText.trim() : "";
  const historyText = Array.isArray(history)
    ? history
        .map((item) => {
          const role = String(item?.role || "").toLowerCase() === "assistant" ? "Assistant" : "User";
          const content = String(item?.content || "").trim();
          return content ? `${role}: ${content}` : "";
        })
        .filter(Boolean)
        .join("\n\n")
    : "";

  if (historyText && normalizedPrompt) {
    return [
      "Continue the existing conversation with this history.",
      "",
      historyText,
      "",
      `User: ${normalizedPrompt}`,
    ].join("\n");
  }
  if (historyText) {
    return [
      "Continue the existing conversation with this history.",
      "",
      historyText,
    ].join("\n");
  }
  return normalizedPrompt;
}

function resolveExecPhase(event) {
  const type = String(event?.type || "").trim().toLowerCase();
  const itemType = String(event?.item?.type || "").trim().toLowerCase();
  if (type.includes("reason") || itemType.includes("reason")) {
    return "reasoning";
  }
  if (
    itemType.includes("command") ||
    itemType.includes("tool") ||
    itemType.includes("patch") ||
    type.includes("command") ||
    type.includes("tool")
  ) {
    return "command_execution";
  }
  if (itemType.includes("agent_message") || type.includes("message")) {
    return "message_aggregation";
  }
  return "";
}

function statusLineForPhase(phase) {
  switch (phase) {
    case "reasoning":
      return "codex is thinking";
    case "command_execution":
      return "codex is running tools";
    case "message_aggregation":
      return "codex is composing reply";
    case "turn_started":
      return "codex is working";
    case "turn_completed":
      return "codex finished";
    case "turn_failed":
      return "codex failed";
    default:
      return "codex is working";
  }
}

function filterCodexExecBaseArgs(args) {
  const filtered = [];
  let skipNext = false;
  let afterAppServer = false;
  for (const rawArg of Array.isArray(args) ? args : []) {
    const arg = String(rawArg || "");
    if (!arg) {
      continue;
    }
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (arg === "app-server") {
      afterAppServer = true;
      continue;
    }
    if (afterAppServer && arg === "--listen") {
      skipNext = true;
      continue;
    }
    if (arg === "exec") {
      continue;
    }
    filtered.push(arg);
  }
  return filtered;
}

function readTextFileIfExists(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return "";
    }
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function buildCodexExecEnv({ cwd, extraEnv = {}, ignoreCodexApiKey = false } = {}) {
  const env = {
    ...process.env,
    PWD: cwd,
    ...(extraEnv && typeof extraEnv === "object" ? extraEnv : {}),
  };
  if (ignoreCodexApiKey) {
    delete env.CODEX_API_KEY;
  }
  return env;
}

export class CodexExecSession extends EventEmitter {
  constructor(backend, options = {}) {
    super();
    this.backend = normalizeCodexBackend(backend);
    this.options = options;
    this.logger = normalizeLogger(options.logger);
    this.cwd =
      typeof options.cwd === "string" && options.cwd.trim()
        ? options.cwd.trim()
        : process.cwd();
    this.resumeSessionId = typeof options.resumeSessionId === "string" ? options.resumeSessionId.trim() : "";
    this.sessionId = this.resumeSessionId || `codex-exec-${randomUUID()}`;
    this.sessionInfo = {
      backend: this.backend,
      sessionId: this.sessionId,
      model:
        typeof options.model === "string" && options.model.trim()
          ? options.model.trim()
          : this.backend,
    };
    this.history = Array.isArray(options.initialHistory) ? [...options.initialHistory] : [];
    this.closeRequested = false;
    this.closed = false;
    this.ignoreCodexApiKey = options.ignoreCodexApiKey === true;
    this.currentTurn = null;
    this.currentTurnStatus = null;
    this.sessionAnnounced = false;
    this.sessionMessageHandler = null;
    this.workingStatusHandler = null;
    this.activeReplyTarget = "";
    this.lastReplyTarget = "";
    this.turnDeadlineMs = getBoundedEnvInt(
      "CONDUCTOR_TURN_DEADLINE_MS",
      DEFAULT_TURN_DEADLINE_MS,
      MIN_TURN_DEADLINE_MS,
      MAX_TURN_DEADLINE_MS,
    );

    const envConfig = loadEnvConfig(options.configFile);
    const proxyEnv = proxyToEnv(envConfig);
    this.env = {
      ...(envConfig && typeof envConfig === "object" ? envConfig : {}),
      ...proxyEnv,
      ...(options.env && typeof options.env === "object" ? options.env : {}),
    };

    const commandLine =
      process.env.CONDUCTOR_CODEX_EXEC_COMMAND ||
      options.commandLine ||
      process.env.CONDUCTOR_CLI_COMMAND ||
      DEFAULT_CODEX_EXEC_COMMAND;
    const { command, args } = parseCommandParts(commandLine);
    if (!command) {
      throw new Error("Invalid codex exec command");
    }
    this.command = command;
    this.baseArgs = filterCodexExecBaseArgs(args);
  }

  writeLog(message) {
    emitLog(this.logger, message);
  }

  trace(message) {
    this.writeLog(`[${this.backend}] [codex-exec] ${message}`);
  }

  get threadId() {
    return this.sessionId;
  }

  get threadOptions() {
    return {
      model:
        this.sessionInfo?.model ||
        (typeof this.options.model === "string" && this.options.model.trim()
          ? this.options.model.trim()
          : this.backend),
      modelProvider: this.sessionInfo?.modelProvider || undefined,
    };
  }

  getSnapshot() {
    return {
      backend: this.backend,
      provider: CODEX_EXEC_PROVIDER_VARIANT,
      cwd: this.cwd,
      sessionId: this.sessionId || undefined,
      sessionInfo: this.getSessionInfo(),
      useSessionFileReplyStream: this.usesSessionFileReplyStream(),
      resumeReady: false,
      manualResume: null,
      currentTurnStatus: this.getCurrentTurnStatus(),
      pid: this.currentTurn?.child?.pid || undefined,
    };
  }

  getSessionInfo() {
    return this.sessionInfo ? { ...this.sessionInfo } : null;
  }

  getCurrentTurnStatus() {
    return this.currentTurnStatus ? { ...this.currentTurnStatus } : null;
  }

  async ensureSessionInfo() {
    this.announceSession();
    return this.getSessionInfo();
  }

  async getSessionUsageSummary() {
    return {
      sessionId: this.sessionId || undefined,
      sessionFilePath: undefined,
      tokenUsagePercent: undefined,
      contextUsagePercent: undefined,
      tokenUsage: null,
      rateLimits: null,
      manualResume: null,
    };
  }

  usesSessionFileReplyStream() {
    return true;
  }

  setSessionMessageHandler(handler) {
    this.sessionMessageHandler = typeof handler === "function" ? handler : null;
  }

  setWorkingStatusHandler(handler) {
    this.workingStatusHandler = typeof handler === "function" ? handler : null;
  }

  setSessionReplyTarget(replyTo) {
    const normalizedReplyTo = typeof replyTo === "string" ? replyTo.trim() : "";
    this.activeReplyTarget = normalizedReplyTo;
    if (normalizedReplyTo) {
      this.lastReplyTarget = normalizedReplyTo;
    }
  }

  getCurrentReplyTarget() {
    return this.activeReplyTarget || this.lastReplyTarget || undefined;
  }

  announceSession() {
    if (this.sessionAnnounced) {
      return;
    }
    this.sessionAnnounced = true;
    this.emit("session", this.getSessionInfo());
  }

  createSessionClosedError() {
    return createTurnError("Codex exec session closed", {
      reason: "session_closed",
    });
  }

  updateCurrentTurnStatus(payload) {
    const updatedAtMs = Date.now();
    this.currentTurnStatus = {
      source: CODEX_EXEC_PROVIDER_VARIANT,
      replyTo: this.getCurrentReplyTarget(),
      thread_id: this.sessionId || undefined,
      session_id: this.sessionId || undefined,
      ...payload,
      updated_at: new Date(updatedAtMs).toISOString(),
    };
  }

  async emitWorkingStatus(payload, onProgress = null) {
    this.updateCurrentTurnStatus(payload);
    const normalized = this.getCurrentTurnStatus();
    if (typeof onProgress === "function") {
      await onProgress(normalized);
    }
    if (typeof this.workingStatusHandler === "function") {
      await this.workingStatusHandler(normalized);
    }
    this.emit("working_status", normalized);
    return normalized;
  }

  async emitAssistantMessage(text) {
    const normalizedText = typeof text === "string" ? text : "";
    if (!normalizedText) {
      return;
    }
    const payload = {
      text: normalizedText,
      preserveWhitespace: true,
      replyTo: this.getCurrentReplyTarget(),
      sessionId: this.sessionId || undefined,
      backend: this.backend,
      provider: CODEX_EXEC_PROVIDER_VARIANT,
    };
    if (typeof this.sessionMessageHandler === "function") {
      await this.sessionMessageHandler(payload);
    }
    this.emit("assistant_message", payload);
  }

  buildPrompt(promptText) {
    return buildHistoryPrompt(this.history, promptText);
  }

  buildExecArgs({ useInitialImages = false, schemaFilePath = "", lastMessageFilePath = "" } = {}) {
    const args = [...this.baseArgs];
    args.push("exec");
    args.push("--json");
    args.push("--color", "never");
    args.push("--skip-git-repo-check");
    args.push("--full-auto");
    if (lastMessageFilePath) {
      args.push("--output-last-message", lastMessageFilePath);
    }
    if (schemaFilePath) {
      args.push("--output-schema", schemaFilePath);
    }
    if (typeof this.options.model === "string" && this.options.model.trim()) {
      args.push("--model", this.options.model.trim());
    }
    const images = useInitialImages && Array.isArray(this.options.initialImages)
      ? this.options.initialImages.filter((item) => typeof item === "string" && item.trim())
      : [];
    for (const imagePath of images) {
      args.push("--image", imagePath);
    }
    return args;
  }

  maybeEmitAuthRequired(stderrTail) {
    const lastMessage = Array.isArray(stderrTail) ? String(stderrTail.filter(Boolean).at(-1) || "") : "";
    const normalized = lastMessage.toLowerCase();
    if (
      !normalized.includes("login") &&
      !normalized.includes("auth") &&
      !normalized.includes("api key") &&
      !normalized.includes("credential")
    ) {
      return;
    }
    this.emit("auth_required", {
      reason: "login_required",
      message: lastMessage || "Codex authentication required",
    });
  }

  async runTurn(promptText, { useInitialImages = false, onProgress = null, jsonSchema = null } = {}) {
    if (this.closeRequested || this.closed) {
      throw this.createSessionClosedError();
    }
    if (this.currentTurn) {
      throw createTurnError("Codex exec turn already running", {
        reason: "turn_already_running",
      });
    }

    const effectivePrompt = this.buildPrompt(promptText);
    const imagePaths = useInitialImages && Array.isArray(this.options.initialImages)
      ? this.options.initialImages.filter((item) => typeof item === "string" && item.trim())
      : [];
    const stdinPrompt = effectivePrompt || (imagePaths.length > 0 ? "Analyze the attached image." : "");
    if (!stdinPrompt && imagePaths.length === 0) {
      return buildEmptyTurnResult();
    }

    const normalizedSchema = normalizeJsonSchema(jsonSchema);
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codex-exec-turn-"));
    const lastMessageFilePath = path.join(tempDir, "last-message.txt");
    const schemaFilePath = normalizedSchema ? path.join(tempDir, "schema.json") : "";
    if (normalizedSchema) {
      await fs.promises.writeFile(schemaFilePath, JSON.stringify(normalizedSchema, null, 2), "utf8");
    }

    this.announceSession();
    this.history.push({ role: "user", content: String(promptText || "") });

    const currentTurn = {
      child: null,
      stdoutEvents: [],
      stderrTail: [],
      settled: false,
    };
    this.currentTurn = currentTurn;

    try {
      await this.emitWorkingStatus(
        {
          phase: "turn_started",
          reply_in_progress: true,
          status_line: statusLineForPhase("turn_started"),
        },
        onProgress,
      );

      const args = this.buildExecArgs({
        useInitialImages,
        schemaFilePath,
        lastMessageFilePath,
      });
      this.trace(`spawn ${[this.command, ...args].join(" ")} <stdin prompt>`);

      const result = await new Promise((resolve, reject) => {
        const child = spawn(this.command, args, {
          cwd: this.cwd,
          env: buildCodexExecEnv({
            cwd: this.cwd,
            extraEnv: this.env,
            ignoreCodexApiKey: this.ignoreCodexApiKey,
          }),
          stdio: ["pipe", "pipe", "pipe"],
        });
        currentTurn.child = child;

        const stdoutReader = readline.createInterface({ input: child.stdout });
        const stderrReader = readline.createInterface({ input: child.stderr });
        let timeoutId = null;

        const settle = (error, value = null) => {
          if (currentTurn.settled) {
            return;
          }
          currentTurn.settled = true;
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
          stdoutReader.close();
          stderrReader.close();
          if (error) {
            reject(error);
            return;
          }
          resolve(value);
        };

        timeoutId = setTimeout(() => {
          try {
            child.kill("SIGTERM");
          } catch {
            // ignore
          }
          settle(
            createTurnError("Codex exec turn timed out", {
              reason: "turn_timeout",
            }),
          );
        }, this.turnDeadlineMs);

        stdoutReader.on("line", (line) => {
          const normalizedLine = String(line || "").trim();
          if (!normalizedLine) {
            return;
          }
          let payload = null;
          try {
            payload = JSON.parse(normalizedLine);
          } catch {
            payload = { type: "raw", line: normalizedLine };
          }
          currentTurn.stdoutEvents.push(payload);
          const phase = resolveExecPhase(payload);
          if (phase) {
            void this.emitWorkingStatus(
              {
                phase,
                reply_in_progress: true,
                status_line: statusLineForPhase(phase),
              },
              onProgress,
            );
          }
        });

        stderrReader.on("line", (line) => {
          const normalizedLine = String(line || "");
          if (!normalizedLine.trim()) {
            return;
          }
          currentTurn.stderrTail.push(normalizedLine);
          if (currentTurn.stderrTail.length > 20) {
            currentTurn.stderrTail.shift();
          }
          this.writeLog(`[codex-exec] stderr ${sanitizeForLog(normalizedLine, 300)}`);
        });

        child.on("error", (error) => {
          settle(error);
        });

        child.stdin.on("error", () => {
          // best effort; the process may exit before reading stdin
        });

        child.on("exit", (code, signal) => {
          if (this.closeRequested) {
            settle(this.createSessionClosedError());
            return;
          }
          if (code !== 0) {
            this.maybeEmitAuthRequired(currentTurn.stderrTail);
            const stderrSummary = sanitizeForLog(currentTurn.stderrTail.filter(Boolean).at(-1), 200);
            settle(
              createTurnError(stderrSummary ? `Codex exec failed: ${stderrSummary}` : "Codex exec failed", {
                reason: "turn_failed",
                code,
                signal,
                stderr: [...currentTurn.stderrTail],
              }),
            );
            return;
          }
          settle(null, {
            text: readTextFileIfExists(lastMessageFilePath),
            events: [...currentTurn.stdoutEvents],
            stderr: [...currentTurn.stderrTail],
          });
        });

        child.stdin.end(stdinPrompt);
      });

      const text = typeof result?.text === "string" ? result.text : "";
      if (text) {
        this.history.push({ role: "assistant", content: text });
      }
      this.activeReplyTarget = "";

      await this.emitWorkingStatus(
        {
          phase: "turn_completed",
          reply_in_progress: false,
          status_line: statusLineForPhase("turn_completed"),
        },
        onProgress,
      );
      await this.emitAssistantMessage(text);

      return {
        text,
        usage: null,
        items: result?.events || [],
        events: result?.events || [],
        provider: this.backend,
        metadata: {
          source: CODEX_EXEC_PROVIDER_VARIANT,
          sessionId: this.sessionId || undefined,
        },
      };
    } catch (error) {
      if (!this.closeRequested && error?.reason !== "session_closed") {
        await this.emitWorkingStatus(
          {
            phase: "turn_failed",
            reply_in_progress: false,
            status_line: statusLineForPhase("turn_failed"),
            status_done_line: error?.message || "Codex exec failed",
          },
          onProgress,
        );
      }
      throw error;
    } finally {
      this.currentTurn = null;
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async close() {
    if (this.closed) {
      return;
    }
    this.closeRequested = true;
    this.closed = true;
    const child = this.currentTurn?.child;
    if (child) {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
  }
}
