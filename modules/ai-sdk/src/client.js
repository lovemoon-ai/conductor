import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

import {
  assertSupportedBackend,
  createLocalAiSession,
  providerVariantForBackend,
} from "./session-factory.js";
import { normalizeLogger, reviveError } from "./shared.js";

const WORKER_PATH = fileURLToPath(new URL("./worker.js", import.meta.url));

function sanitizeOptionsForWorker(options = {}) {
  const sanitized = {};
  for (const [key, value] of Object.entries(options)) {
    if (typeof value === "function" || key === "logger") {
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}

function createSessionClosedError() {
  const error = new Error("AI session worker closed");
  error.reason = "session_closed";
  return error;
}

function toSerializablePayload(payload) {
  return `${JSON.stringify(payload)}\n`;
}

export class RemoteAiSession extends EventEmitter {
  constructor(backend, options = {}) {
    super();
    this.backend = assertSupportedBackend(backend);
    this.options = options;
    this.logger = normalizeLogger(options.logger);
    this.variant = providerVariantForBackend(this.backend);
    this.threadIdValue =
      typeof options.resumeSessionId === "string" && options.resumeSessionId.trim()
        ? options.resumeSessionId.trim()
        : "";
    this.threadOptionsValue = {
      model:
        typeof options.model === "string" && options.model.trim()
          ? options.model.trim()
          : this.backend || "unknown",
    };
    this.useSessionFileReplyStreamValue = true;
    this.sessionInfo = null;
    this.snapshot = {
      backend: this.backend,
      provider: this.variant,
      sessionId: this.threadIdValue || undefined,
      useSessionFileReplyStream: this.useSessionFileReplyStreamValue,
      workerReady: false,
    };
    this.sessionMessageHandler = null;
    this.workingStatusHandler = null;
    this.pendingRequests = new Map();
    this.nextRequestId = 1;
    this.closed = false;
    this.workerExited = false;

    this.child = spawn(process.execPath, [WORKER_PATH], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.stdoutReader = readline.createInterface({ input: this.child.stdout });
    this.stderrReader = readline.createInterface({ input: this.child.stderr });
    this.stdoutReader.on("line", (line) => {
      this.handleWorkerLine(line);
    });
    this.stderrReader.on("line", (line) => {
      this.handleWorkerStderr(line);
    });

    this.exitPromise = new Promise((resolve) => {
      this.child.once("exit", (code, signal) => {
        this.workerExited = true;
        if (this.rejectReady) {
          this.rejectReady(createSessionClosedError());
          this.resolveReady = null;
          this.rejectReady = null;
        }
        this.rejectPendingRequests(createSessionClosedError());
        this.emit("process.exited", {
          pid: this.child.pid || null,
          code,
          signal,
        });
        resolve({ code, signal });
      });
    });

    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.readyPromise.catch(() => {
      // prevent unhandled rejection when callers only use sync getters then close immediately
    });

    this.child.on("error", (error) => {
      this.rejectReady?.(error);
      this.rejectPendingRequests(error);
    });

    this.child.stdin.write(
      toSerializablePayload({
        type: "create",
        backend: this.backend,
        options: sanitizeOptionsForWorker(options),
      }),
    );
  }

  get threadId() {
    return this.threadIdValue;
  }

  get threadOptions() {
    return { ...this.threadOptionsValue };
  }

  getSnapshot() {
    return {
      ...this.snapshot,
      sessionInfo: this.sessionInfo ? { ...this.sessionInfo } : null,
    };
  }

  usesSessionFileReplyStream() {
    return Boolean(this.useSessionFileReplyStreamValue);
  }

  getSessionInfo() {
    return this.sessionInfo ? { ...this.sessionInfo } : null;
  }

  setSessionMessageHandler(handler) {
    this.sessionMessageHandler = typeof handler === "function" ? handler : null;
  }

  setWorkingStatusHandler(handler) {
    this.workingStatusHandler = typeof handler === "function" ? handler : null;
  }

  setSessionReplyTarget(replyTo) {
    void this.callWorker("setSessionReplyTarget", [replyTo]).catch((error) => {
      if (error?.reason !== "session_closed") {
        this.logger.log?.(`[ai-sdk] failed to set session reply target: ${error?.message || error}`);
      }
    });
  }

  async ensureSessionInfo() {
    return this.callWorker("ensureSessionInfo", []);
  }

  async getSessionUsageSummary() {
    return this.callWorker("getSessionUsageSummary", []);
  }

  async runTurn(promptText, options = {}) {
    const { onProgress, ...restOptions } = options || {};
    return this.callWorker("runTurn", [promptText, restOptions], {
      progressHandler: typeof onProgress === "function" ? onProgress : null,
    });
  }

  async close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      if (!this.workerExited) {
        await this.callWorker("close", []);
      }
    } catch {
      // best effort
    }
    if (!this.workerExited) {
      try {
        this.child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
    await Promise.race([
      this.exitPromise,
      new Promise((resolve) => {
        const timer = setTimeout(resolve, 1500);
        if (typeof timer.unref === "function") {
          timer.unref();
        }
      }),
    ]);
    if (!this.workerExited) {
      try {
        this.child.kill("SIGKILL");
      } catch {
        // ignore
      }
      await this.exitPromise;
    }
  }

  async callWorker(method, args = [], { progressHandler = null } = {}) {
    if (this.closed) {
      throw createSessionClosedError();
    }
    await this.readyPromise;
    if (this.workerExited) {
      throw createSessionClosedError();
    }
    const requestId = this.nextRequestId++;
    const payload = {
      type: "request",
      id: requestId,
      method,
      args,
    };
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(requestId, {
        resolve,
        reject,
        progressHandler,
      });
      try {
        this.child.stdin.write(toSerializablePayload(payload));
      } catch (error) {
        this.pendingRequests.delete(requestId);
        reject(error);
      }
    });
  }

  handleWorkerStderr(line) {
    const normalized = String(line || "").trim();
    if (!normalized) {
      return;
    }
    this.logger.log?.(`[ai-sdk worker] ${normalized}`);
  }

  handleWorkerLine(line) {
    const normalized = String(line || "").trim();
    if (!normalized) {
      return;
    }
    let payload;
    try {
      payload = JSON.parse(normalized);
    } catch {
      this.logger.log?.(`[ai-sdk worker] invalid stdout: ${normalized}`);
      return;
    }

    switch (payload?.type) {
      case "ready":
        this.applyReadyPayload(payload);
        this.resolveReady?.(payload);
        this.resolveReady = null;
        this.rejectReady = null;
        return;
      case "create_error": {
        const error = reviveError(payload.error);
        this.rejectReady?.(error);
        this.resolveReady = null;
        this.rejectReady = null;
        return;
      }
      case "response":
        this.handleWorkerResponse(payload);
        return;
      case "progress":
        this.handleWorkerProgress(payload);
        return;
      case "event":
        this.handleWorkerEvent(payload);
        return;
      default:
        return;
    }
  }

  applyReadyPayload(payload) {
    const snapshot = payload?.snapshot && typeof payload.snapshot === "object" ? payload.snapshot : {};
    this.snapshot = {
      ...this.snapshot,
      ...snapshot,
      workerReady: true,
      workerPid: payload?.workerPid || undefined,
      workerProcessPid: payload?.workerProcessPid || undefined,
    };
    if (snapshot?.sessionInfo) {
      this.sessionInfo = { ...snapshot.sessionInfo };
    }
    if (snapshot?.sessionId) {
      this.threadIdValue = String(snapshot.sessionId);
    }
    if (snapshot?.useSessionFileReplyStream !== undefined) {
      this.useSessionFileReplyStreamValue = Boolean(snapshot.useSessionFileReplyStream);
    }
  }

  handleWorkerResponse(payload) {
    const pending = this.pendingRequests.get(payload.id);
    if (!pending) {
      return;
    }
    this.pendingRequests.delete(payload.id);
    if (payload.error) {
      pending.reject(reviveError(payload.error));
      return;
    }
    if (payload.result && typeof payload.result === "object" && payload.result.sessionId) {
      this.threadIdValue = String(payload.result.sessionId);
    }
    if (payload.result && typeof payload.result === "object" && payload.result.sessionFilePath) {
      this.sessionInfo = {
        ...(this.sessionInfo || {
          backend: this.backend,
          sessionId: this.threadIdValue || undefined,
        }),
        sessionFilePath: payload.result.sessionFilePath,
      };
    }
    pending.resolve(payload.result);
  }

  handleWorkerProgress(payload) {
    const pending = this.pendingRequests.get(payload.requestId);
    if (!pending || typeof pending.progressHandler !== "function") {
      return;
    }
    try {
      pending.progressHandler(payload.payload);
    } catch {
      // best effort
    }
  }

  async handleWorkerEvent(payload) {
    const name = String(payload?.name || "").trim();
    const eventPayload = payload?.payload;

    if (name === "log" && eventPayload?.message) {
      this.logger.log?.(String(eventPayload.message));
      this.emit("log", eventPayload);
      return;
    }

    if (name === "session" && eventPayload && typeof eventPayload === "object") {
      this.sessionInfo = { ...eventPayload };
      if (eventPayload.sessionId) {
        this.threadIdValue = String(eventPayload.sessionId);
      }
      this.snapshot = {
        ...this.snapshot,
        sessionId: this.threadIdValue || undefined,
        sessionInfo: this.sessionInfo,
      };
    }

    if (name === "assistant_message" && typeof this.sessionMessageHandler === "function") {
      await this.sessionMessageHandler(eventPayload);
    }

    if (name === "working_status" && typeof this.workingStatusHandler === "function") {
      await this.workingStatusHandler(eventPayload);
    }

    this.emit(name, eventPayload);
  }

  rejectPendingRequests(error) {
    if (this.pendingRequests.size === 0) {
      return;
    }
    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }
}

export function createAiSession(backend, options = {}) {
  const normalizedBackend = assertSupportedBackend(backend);
  if (process.env.CONDUCTOR_AI_SDK_DISABLE_WORKER === "1") {
    return createLocalAiSession(normalizedBackend, options);
  }
  return new RemoteAiSession(normalizedBackend, options);
}
