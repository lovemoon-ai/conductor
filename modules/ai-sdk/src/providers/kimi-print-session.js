import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import readline from "node:readline";

import { KIMI_CLI_PRINT_VARIANT as KIMI_PRINT_PROVIDER_VARIANT } from "../built-in-backends.js";
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
const DEFAULT_KIMI_COMMAND = "kimi";

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

function normalizeKimiBackend(backend) {
  const normalized = String(backend || "").trim().toLowerCase();
  if (normalized === "kimi-cli" || normalized === "kimi-code") {
    return "kimi";
  }
  return normalized || "kimi";
}

function injectJsonSchemaPrompt(promptText, jsonSchema) {
  const schemaText = typeof jsonSchema === "string" ? jsonSchema : JSON.stringify(jsonSchema, null, 2);
  return `You must respond with valid JSON that strictly conforms to the following JSON Schema. Do not include any markdown formatting or explanation outside the JSON object.

JSON Schema:
${schemaText}

${promptText}`;
}

function buildHistoryPrompt(history, promptText) {
  let effectivePrompt = String(promptText || "").trim();
  if (!effectivePrompt) {
    return "";
  }
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
  if (!historyText) {
    return effectivePrompt;
  }
  return [
    "Continue the existing conversation with this history.",
    "",
    historyText,
    "",
    `User: ${effectivePrompt}`,
  ].join("\n");
}

function statusLineForPhase(phase) {
  switch (phase) {
    case "turn_started":
      return "Kimi is working on it";
    case "reasoning":
      return "Kimi is thinking";
    case "command_execution":
      return "Kimi is calling a tool";
    case "message_aggregation":
      return "Kimi is writing the reply";
    case "turn_completed":
      return "Kimi finished";
    case "turn_failed":
      return "Kimi failed";
    default:
      return "Kimi is working";
  }
}

function filterKimiPrintBaseArgs(args, cliMode = "legacy-print") {
  const filtered = [];
  let skipNext = false;
  for (const rawArg of Array.isArray(args) ? args : []) {
    const arg = String(rawArg || "");
    if (!arg) {
      continue;
    }
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (
      arg === "--wire" ||
      arg === "--print" ||
      arg === "--final-message-only" ||
      arg === "--yolo" ||
      arg === "--yes" ||
      arg === "--auto-approve" ||
      arg === "--auto" ||
      arg === "--plan" ||
      arg === "--continue" ||
      arg === "-C" ||
      arg === "-y" ||
      (cliMode === "prompt" && arg === "-c")
    ) {
      continue;
    }
    if (
      arg === "--input-format" ||
      arg === "--output-format" ||
      arg === "--prompt" ||
      arg === "--command" ||
      arg === "--session" ||
      arg === "--resume" ||
      arg === "--work-dir" ||
      arg === "--model" ||
      arg === "-S" ||
      arg === "-r" ||
      arg === "-m" ||
      arg === "-p" ||
      arg === "-w" ||
      (cliMode === "legacy-print" && arg === "-c")
    ) {
      skipNext = true;
      continue;
    }
    if (
      arg.startsWith("--input-format=") ||
      arg.startsWith("--output-format=") ||
      arg.startsWith("--prompt=") ||
      arg.startsWith("--command=") ||
      arg.startsWith("--session=") ||
      arg.startsWith("--resume=") ||
      arg.startsWith("--work-dir=") ||
      arg.startsWith("--model=") ||
      ["-S", "-r", "-m", "-p", "-w", "-c"].some(
        (prefix) => arg.startsWith(prefix) && arg.length > prefix.length,
      )
    ) {
      continue;
    }
    filtered.push(arg);
  }
  return filtered;
}

function quoteShellArg(value) {
  const normalized = String(value ?? "");
  if (!normalized) {
    return "''";
  }
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(normalized)) {
    return normalized;
  }
  return `'${normalized.replace(/'/g, `'\\''`)}'`;
}

function normalizeTextContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("");
  }
  return "";
}

function guessMimeType(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

function filePathToDataUri(filePath) {
  const buffer = fs.readFileSync(filePath);
  const mimeType = guessMimeType(filePath);
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

export class KimiPrintSession extends EventEmitter {
  constructor(backend, options = {}) {
    super();
    this.backend = normalizeKimiBackend(backend);
    this.options = options;
    this.logger = normalizeLogger(options.logger);
    this.cwd =
      typeof options.cwd === "string" && options.cwd.trim()
        ? options.cwd.trim()
        : process.cwd();
    this.cliMode = options.kimiCliMode === "prompt" ? "prompt" : "legacy-print";
    this.resumeSessionId = typeof options.resumeSessionId === "string" ? options.resumeSessionId.trim() : "";
    this.sessionId = this.resumeSessionId || (this.cliMode === "prompt" ? "" : randomUUID());
    this.sessionInfo = {
      backend: this.backend,
      sessionId: this.sessionId || undefined,
      sessionIdDeferred: this.cliMode === "prompt" && !this.sessionId,
      model:
        typeof options.model === "string" && options.model.trim()
          ? options.model.trim()
          : this.backend,
    };
    this.history = Array.isArray(options.initialHistory) ? [...options.initialHistory] : [];
    this.pendingHistorySeed = this.history.length > 0;
    this.closeRequested = false;
    this.closed = false;
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
      process.env.CONDUCTOR_KIMI_COMMAND ||
      options.commandLine ||
      process.env.CONDUCTOR_CLI_COMMAND ||
      DEFAULT_KIMI_COMMAND;
    const { command, args } = parseCommandParts(commandLine);
    if (!command) {
      throw new Error("Invalid kimi print command");
    }
    this.command = command;
    this.baseArgs = filterKimiPrintBaseArgs(args, this.cliMode);
  }

  writeLog(message) {
    emitLog(this.logger, message);
  }

  trace(message) {
    this.writeLog(`[${this.backend}] [kimi-print] ${message}`);
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
    };
  }

  buildManualResumeCommand() {
    if (!this.sessionId) {
      return "";
    }
    const parts = [...this.baseArgs];
    if (this.cliMode === "legacy-print") {
      parts.push("--work-dir", this.cwd);
    }
    parts.push("--session", this.sessionId);
    if (typeof this.options.model === "string" && this.options.model.trim()) {
      parts.push("--model", this.options.model.trim());
    }
    const command = [this.command, ...parts].map(quoteShellArg).join(" ");
    return this.cliMode === "prompt"
      ? `cd ${quoteShellArg(this.cwd)} && ${command}`
      : command;
  }

  getSnapshot() {
    return {
      backend: this.backend,
      provider: KIMI_PRINT_PROVIDER_VARIANT,
      cwd: this.cwd,
      sessionId: this.sessionId || undefined,
      sessionInfo: this.getSessionInfo(),
      useSessionFileReplyStream: this.usesSessionFileReplyStream(),
      resumeReady: Boolean(this.sessionId),
      manualResume: this.sessionId
        ? {
            ready: true,
            command: this.buildManualResumeCommand(),
          }
        : null,
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
    if (!this.sessionInfo?.sessionIdDeferred) {
      this.announceSession();
    }
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
      manualResume: this.sessionId
        ? {
            ready: true,
            command: this.buildManualResumeCommand(),
          }
        : null,
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
    if (this.sessionAnnounced || !this.sessionId) {
      return;
    }
    this.sessionAnnounced = true;
    this.emit("session", this.getSessionInfo());
  }

  adoptSessionId(sessionId) {
    const normalizedSessionId = typeof sessionId === "string" ? sessionId.trim() : "";
    if (!normalizedSessionId || normalizedSessionId === this.sessionId) {
      return;
    }
    this.sessionId = normalizedSessionId;
    this.sessionInfo = {
      ...this.sessionInfo,
      sessionId: normalizedSessionId,
      sessionIdDeferred: false,
    };
    this.trace(`session ready id=${sanitizeForLog(normalizedSessionId, 120)}`);
    this.announceSession();
  }

  createSessionClosedError() {
    return createTurnError("Kimi print session closed", {
      reason: "session_closed",
    });
  }

  updateCurrentTurnStatus(payload) {
    const updatedAtMs = Date.now();
    this.currentTurnStatus = {
      source: KIMI_PRINT_PROVIDER_VARIANT,
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
      provider: KIMI_PRINT_PROVIDER_VARIANT,
    };
    if (typeof this.sessionMessageHandler === "function") {
      await this.sessionMessageHandler(payload);
    }
    this.emit("assistant_message", payload);
  }

  buildPrompt(promptText) {
    const normalizedPrompt = String(promptText || "").trim();
    if (!normalizedPrompt) {
      return "";
    }
    if (!this.pendingHistorySeed) {
      return normalizedPrompt;
    }
    this.pendingHistorySeed = false;
    return buildHistoryPrompt(this.history, normalizedPrompt);
  }

  buildPrintArgs(promptText = "") {
    const args = [...this.baseArgs];
    if (this.cliMode === "prompt") {
      args.push("--output-format=stream-json");
      if (this.sessionId) {
        args.push(`--session=${this.sessionId}`);
      }
      if (typeof this.options.model === "string" && this.options.model.trim()) {
        args.push(`--model=${this.options.model.trim()}`);
      }
      args.push("--prompt", promptText);
      return args;
    }
    args.push("--print");
    args.push("--input-format=stream-json");
    args.push("--output-format=stream-json");
    args.push(`--work-dir=${this.cwd}`);
    if (this.sessionId) {
      args.push(`--session=${this.sessionId}`);
    }
    if (typeof this.options.model === "string" && this.options.model.trim()) {
      args.push(`--model=${this.options.model.trim()}`);
    }
    return args;
  }

  buildUserMessage(promptText, { useInitialImages = false } = {}) {
    const images = useInitialImages && Array.isArray(this.options.initialImages)
      ? this.options.initialImages.filter((item) => typeof item === "string" && item.trim())
      : [];
    if (images.length === 0) {
      return {
        role: "user",
        content: promptText,
      };
    }
    const content = [];
    if (promptText) {
      content.push({ type: "text", text: promptText });
    }
    for (const imagePath of images) {
      content.push({
        type: "image_url",
        image_url: {
          url: filePathToDataUri(imagePath),
        },
      });
    }
    return {
      role: "user",
      content,
    };
  }

  maybeEmitAuthRequired(stderrTail) {
    const lastMessage = Array.isArray(stderrTail) ? String(stderrTail.filter(Boolean).at(-1) || "") : "";
    const normalized = lastMessage.toLowerCase();
    if (
      !normalized.includes("login") &&
      !normalized.includes("auth") &&
      !normalized.includes("api key") &&
      !normalized.includes("credential") &&
      !normalized.includes("llm is not set")
    ) {
      return;
    }
    this.emit("auth_required", {
      reason: "login_required",
      message: lastMessage || "Kimi authentication required",
    });
  }

  async interruptCurrentTurn() {
    const currentTurn = this.currentTurn;
    if (!currentTurn?.child) {
      return false;
    }
    currentTurn.interruptRequested = true;
    try {
      currentTurn.child.kill("SIGINT");
      return true;
    } catch {
      return false;
    }
  }

  async runTurn(promptText, { useInitialImages = false, onProgress = null, jsonSchema = null } = {}) {
    if (this.closeRequested || this.closed) {
      throw this.createSessionClosedError();
    }
    if (this.currentTurn) {
      throw createTurnError("Kimi print turn already running", {
        reason: "turn_already_running",
      });
    }

    let effectivePrompt = this.buildPrompt(promptText);
    const imagePaths = useInitialImages && Array.isArray(this.options.initialImages)
      ? this.options.initialImages.filter((item) => typeof item === "string" && item.trim())
      : [];
    if (jsonSchema && typeof jsonSchema === "object") {
      const promptWithSchema = effectivePrompt || (imagePaths.length > 0 ? "Analyze the attached images." : "");
      if (promptWithSchema) {
        effectivePrompt = injectJsonSchemaPrompt(promptWithSchema, jsonSchema);
      }
    }
    if (this.cliMode === "prompt" && imagePaths.length > 0) {
      const imageContext = imagePaths.map((item, index) => `${index + 1}. ${item}`).join("\n");
      effectivePrompt = `${effectivePrompt || "Analyze the attached images."}\n\nAttached image files:\n${imageContext}`;
    }
    if (!effectivePrompt && imagePaths.length === 0) {
      return buildEmptyTurnResult();
    }

    this.announceSession();
    this.history.push({ role: "user", content: String(promptText || "") });

    const currentTurn = {
      child: null,
      fullText: "",
      items: [],
      stderrTail: [],
      settled: false,
      interruptRequested: false,
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

      const args = this.buildPrintArgs(effectivePrompt);
      const argsForLog = this.cliMode === "prompt"
        ? [...args.slice(0, -2), "--prompt", `<redacted:${effectivePrompt.length} chars>`]
        : args;
      this.trace(`spawn ${[this.command, ...argsForLog].join(" ")}`);

      const result = await new Promise((resolve, reject) => {
        const child = spawn(this.command, args, {
          cwd: this.cwd,
          env: {
            ...process.env,
            PWD: this.cwd,
            ...this.env,
          },
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
            createTurnError("Kimi print turn timed out", {
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
            payload = { role: "raw", content: normalizedLine };
          }
          currentTurn.items.push(payload);
          const role = String(payload?.role || "").trim().toLowerCase();
          if (role === "meta") {
            const type = String(payload?.type || "").trim().toLowerCase();
            if (type === "session.resume_hint") {
              this.adoptSessionId(payload?.session_id);
            }
            return;
          }
          if (role === "assistant") {
            const assistantText = normalizeTextContent(payload.content);
            if (Array.isArray(payload?.tool_calls) && payload.tool_calls.length > 0) {
              void this.emitWorkingStatus(
                {
                  phase: "command_execution",
                  reply_in_progress: true,
                  status_line: statusLineForPhase("command_execution"),
                },
                onProgress,
              );
            } else {
              void this.emitWorkingStatus(
                {
                  phase: "message_aggregation",
                  reply_in_progress: true,
                  status_line: statusLineForPhase("message_aggregation"),
                },
                onProgress,
              );
            }
            if (assistantText) {
              currentTurn.fullText += assistantText;
              void this.emitAssistantMessage(assistantText);
            }
            return;
          }
          if (role === "tool") {
            void this.emitWorkingStatus(
              {
                phase: "command_execution",
                reply_in_progress: true,
                status_line: statusLineForPhase("command_execution"),
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
          this.writeLog(`[kimi-print] stderr ${sanitizeForLog(normalizedLine, 300)}`);
        });

        child.on("error", (error) => {
          settle(error);
        });

        child.on("close", (code, signal) => {
          if (this.closeRequested) {
            settle(this.createSessionClosedError());
            return;
          }
          if (currentTurn.interruptRequested) {
            settle(
              createTurnError("Kimi print turn interrupted", {
                reason: "turn_interrupted",
                code,
                signal,
              }),
            );
            return;
          }
          if (code !== 0) {
            this.maybeEmitAuthRequired(currentTurn.stderrTail);
            const stderrSummary = sanitizeForLog(currentTurn.stderrTail.filter(Boolean).at(-1), 200);
            settle(
              createTurnError(stderrSummary ? `Kimi print failed: ${stderrSummary}` : "Kimi print failed", {
                reason: code === 75 ? "retryable_turn_failed" : "turn_failed",
                retryable: code === 75,
                code,
                signal,
                stderr: [...currentTurn.stderrTail],
              }),
            );
            return;
          }
          settle(null, {
            text: currentTurn.fullText,
            items: [...currentTurn.items],
          });
        });

        if (this.cliMode === "legacy-print") {
          const userMessage = this.buildUserMessage(effectivePrompt, { useInitialImages });
          child.stdin.write(`${JSON.stringify(userMessage)}\n`);
        }
        child.stdin.end();
      });

      if (result?.text) {
        this.history.push({ role: "assistant", content: result.text });
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

      return {
        text: result?.text || "",
        usage: null,
        items: result?.items || [],
        events: result?.items || [],
        provider: this.backend,
        metadata: {
          source: KIMI_PRINT_PROVIDER_VARIANT,
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
            status_done_line: error?.message || "Kimi print failed",
          },
          onProgress,
        );
      }
      throw error;
    } finally {
      this.currentTurn = null;
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
