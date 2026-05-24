import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

import {
  assertSupportedBackend,
  createLocalAiSession,
  providerVariantForBackend,
} from "./session-factory.js";
import {
  DEFAULT_SESSION_CAPABILITIES,
  normalizeLogger,
  resolveSessionCapabilities,
  reviveError,
} from "./shared.js";

function createUnsupportedGoalError(name) {
  const err = new Error(
    `runGoal() is not supported by backend session (${name || "unknown"}).`,
  );
  err.reason = "unsupported_goal";
  return err;
}

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
    this.options = options;
    this.logger = normalizeLogger(options.logger);
    this.threadIdValue =
      typeof options.resumeSessionId === "string" && options.resumeSessionId.trim()
        ? options.resumeSessionId.trim()
        : "";
    this.threadOptionsValue = {
      model:
        typeof options.model === "string" && options.model.trim()
          ? options.model.trim()
          : String(backend || "unknown").trim() || "unknown",
    };
    this.useSessionFileReplyStreamValue = true;
    this.sessionInfo = null;
    this.currentTurnStatus = null;
    this.snapshot = {
      backend: undefined,
      provider: undefined,
      sessionId: this.threadIdValue || undefined,
      useSessionFileReplyStream: this.useSessionFileReplyStreamValue,
      workerReady: false,
      capabilities: { ...DEFAULT_SESSION_CAPABILITIES },
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

    void this.initializeSession(backend, options);
  }

  async initializeSession(backend, options) {
    try {
      this.backend = await assertSupportedBackend(backend, options);
      this.variant = await providerVariantForBackend(backend, options);
      this.snapshot.backend = this.backend;
      this.snapshot.provider = this.variant;
      this.threadOptionsValue.model =
        typeof options.model === "string" && options.model.trim() ? options.model.trim() : this.backend || "unknown";
      this.child.stdin.write(
        toSerializablePayload({
          type: "create",
          backend: this.backend,
          options: sanitizeOptionsForWorker(options),
        }),
      );
    } catch (error) {
      this.rejectReady?.(error);
      this.resolveReady = null;
      this.rejectReady = null;
      this.rejectPendingRequests(error);
      try {
        this.child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
  }

  get threadId() {
    return this.threadIdValue;
  }

  get threadOptions() {
    const sessionInfo = this.sessionInfo && typeof this.sessionInfo === "object" ? this.sessionInfo : null;
    return {
      ...this.threadOptionsValue,
      ...(sessionInfo?.model ? { model: sessionInfo.model } : {}),
      ...(sessionInfo?.modelProvider ? { modelProvider: sessionInfo.modelProvider } : {}),
    };
  }

  getSnapshot() {
    return {
      ...this.snapshot,
      currentTurnStatus: this.getCurrentTurnStatus(),
      sessionInfo: this.sessionInfo ? { ...this.sessionInfo } : null,
    };
  }

  usesSessionFileReplyStream() {
    return Boolean(this.useSessionFileReplyStreamValue);
  }

  getSessionInfo() {
    return this.sessionInfo ? { ...this.sessionInfo } : null;
  }

  getCurrentTurnStatus() {
    return this.currentTurnStatus ? { ...this.currentTurnStatus } : null;
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

  async interruptCurrentTurn() {
    return this.callWorker("interruptCurrentTurn", [], {
      messageType: "control",
    });
  }

  async runTurn(promptText, options = {}) {
    const { onProgress, ...restOptions } = options || {};
    return this.callWorker("runTurn", [promptText, restOptions], {
      progressHandler: typeof onProgress === "function" ? onProgress : null,
    });
  }

  async runGoal(goal, options = {}) {
    // Wait for the worker bootstrap to finish so we can consult the snapshot's
    // capability flags. Critically, we must NOT swallow a `readyPromise`
    // rejection: when the worker fails to come up (binary missing, config
    // error, transport crash on init), the real error has to surface — masking
    // it as `unsupported_goal` would mislead operators about what's wrong.
    // See N3 in the review.
    await this.readyPromise;
    // Cheap capability gate: when the worker has reported a snapshot with
    // `capabilities.goal === false`, short-circuit instead of paying for an
    // IPC round-trip just to surface `unsupported_goal`.
    if (this.snapshot?.capabilities && this.snapshot.capabilities.goal === false) {
      throw createUnsupportedGoalError(this.snapshot.provider || this.snapshot.backend);
    }
    const { onProgress, ...restOptions } = options || {};
    return this.callWorker("runGoal", [goal, restOptions], {
      progressHandler: typeof onProgress === "function" ? onProgress : null,
    });
  }

  async getGoal() {
    // Propagate worker-creation errors instead of masking them as "no goal".
    // See N3 in the review.
    await this.readyPromise;
    if (this.snapshot?.capabilities && this.snapshot.capabilities.goal === false) {
      return null;
    }
    return this.callWorker("getGoal", []);
  }

  async clearGoal() {
    // Propagate worker-creation errors instead of masking them as "nothing
    // to clear". See N3 in the review.
    await this.readyPromise;
    if (this.snapshot?.capabilities && this.snapshot.capabilities.goal === false) {
      return false;
    }
    return this.callWorker("clearGoal", []);
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

  async callWorker(method, args = [], { progressHandler = null, messageType = "request" } = {}) {
    if (this.closed) {
      throw createSessionClosedError();
    }
    await this.readyPromise;
    if (this.workerExited) {
      throw createSessionClosedError();
    }
    const requestId = this.nextRequestId++;
    const payload = {
      type: messageType,
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
    const capabilities =
      snapshot && typeof snapshot.capabilities === "object" && snapshot.capabilities !== null
        ? { ...DEFAULT_SESSION_CAPABILITIES, ...snapshot.capabilities }
        : { ...DEFAULT_SESSION_CAPABILITIES };
    this.snapshot = {
      ...this.snapshot,
      ...snapshot,
      capabilities,
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
    if (snapshot?.currentTurnStatus && typeof snapshot.currentTurnStatus === "object") {
      this.currentTurnStatus = { ...snapshot.currentTurnStatus };
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
    if (payload?.payload && typeof payload.payload === "object") {
      this.currentTurnStatus = { ...payload.payload };
    }
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

    if (name === "working_status") {
      if (eventPayload && typeof eventPayload === "object") {
        this.currentTurnStatus = { ...eventPayload };
      }
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

const LOCAL_SESSION_EVENT_NAMES = ["session", "assistant_message", "working_status", "auth_required", "process.exited"];

class LocalAiSessionProxy extends EventEmitter {
  constructor(backend, options = {}) {
    super();
    this.backend = undefined;
    this.options = options;
    this.threadIdValue =
      typeof options.resumeSessionId === "string" && options.resumeSessionId.trim()
        ? options.resumeSessionId.trim()
        : "";
    this.threadOptionsValue = {
      model:
        typeof options.model === "string" && options.model.trim()
          ? options.model.trim()
          : String(backend || "unknown").trim() || "unknown",
    };
    this.useSessionFileReplyStreamValue = true;
    this.sessionInfo = null;
    this.currentTurnStatus = null;
    this.session = null;
    this.closed = false;
    this.sessionMessageHandler = null;
    this.workingStatusHandler = null;
    this.replyTarget = undefined;
    this.snapshot = {
      backend: undefined,
      provider: undefined,
      sessionId: this.threadIdValue || undefined,
      useSessionFileReplyStream: this.useSessionFileReplyStreamValue,
      workerReady: false,
      capabilities: { ...DEFAULT_SESSION_CAPABILITIES },
    };
    this.readyPromise = this.initializeSession(backend, options);
    this.readyPromise.catch(() => {
      // keep parity with RemoteAiSession and avoid unhandled rejections
    });
  }

  async initializeSession(backend, options) {
    const session = await createLocalAiSession(backend, options);
    if (this.closed) {
      await session.close?.();
      return session;
    }

    this.session = session;
    for (const eventName of LOCAL_SESSION_EVENT_NAMES) {
      if (typeof session.on === "function") {
        session.on(eventName, async (payload) => {
          if (eventName === "session" && payload && typeof payload === "object") {
            this.sessionInfo = { ...payload };
            if (payload.sessionId) {
              this.threadIdValue = String(payload.sessionId);
            }
          }
          if (eventName === "working_status" && payload && typeof payload === "object") {
            this.currentTurnStatus = { ...payload };
          }
          this.emit(eventName, payload);
        });
      }
    }

    if (this.sessionMessageHandler && typeof session.setSessionMessageHandler === "function") {
      session.setSessionMessageHandler(this.sessionMessageHandler);
    }
    if (this.workingStatusHandler && typeof session.setWorkingStatusHandler === "function") {
      session.setWorkingStatusHandler(this.workingStatusHandler);
    }
    if (this.replyTarget !== undefined && typeof session.setSessionReplyTarget === "function") {
      session.setSessionReplyTarget(this.replyTarget);
    }

    const snapshot = typeof session.getSnapshot === "function" ? session.getSnapshot() : {};
    this.backend = snapshot.backend || session.backend || this.backend;
    this.threadIdValue = session.threadId || snapshot.sessionId || this.threadIdValue;
    this.threadOptionsValue = session.threadOptions ? { ...session.threadOptions } : this.threadOptionsValue;
    this.useSessionFileReplyStreamValue =
      typeof session.usesSessionFileReplyStream === "function"
        ? Boolean(session.usesSessionFileReplyStream())
        : snapshot.useSessionFileReplyStream !== undefined
          ? Boolean(snapshot.useSessionFileReplyStream)
          : this.useSessionFileReplyStreamValue;
    this.sessionInfo =
      typeof session.getSessionInfo === "function"
        ? session.getSessionInfo()
        : snapshot.sessionInfo && typeof snapshot.sessionInfo === "object"
          ? { ...snapshot.sessionInfo }
          : this.sessionInfo;
    // Capability resolution: prefer the snapshot's `capabilities`, then fall
    // back to a runtime resolver that checks `session.getCapabilities()` and
    // `session.constructor.capabilities`.
    const capabilities =
      snapshot && typeof snapshot.capabilities === "object" && snapshot.capabilities !== null
        ? { ...DEFAULT_SESSION_CAPABILITIES, ...snapshot.capabilities }
        : resolveSessionCapabilities(session);
    this.snapshot = {
      ...this.snapshot,
      ...snapshot,
      backend: this.backend,
      sessionId: this.threadIdValue || undefined,
      sessionInfo: this.sessionInfo,
      currentTurnStatus:
        typeof session.getCurrentTurnStatus === "function" ? session.getCurrentTurnStatus() : this.currentTurnStatus,
      useSessionFileReplyStream: this.useSessionFileReplyStreamValue,
      workerReady: true,
      capabilities,
    };
    return session;
  }

  get threadId() {
    return this.session?.threadId || this.threadIdValue;
  }

  get threadOptions() {
    return this.session?.threadOptions ? { ...this.session.threadOptions } : { ...this.threadOptionsValue };
  }

  getSnapshot() {
    const sessionSnapshot = typeof this.session?.getSnapshot === "function" ? this.session.getSnapshot() : null;
    if (sessionSnapshot) {
      // N5: capabilities were resolved once during `initializeSession` and are
      // immutable for the lifetime of the underlying session. Reuse the cached
      // value instead of re-resolving on every `getSnapshot()` call — this
      // avoids per-call object identity flicker that breaks callers that
      // memoize on the snapshot reference (e.g. React selectors).
      const capabilities = this.snapshot?.capabilities
        ? this.snapshot.capabilities
        : sessionSnapshot && typeof sessionSnapshot.capabilities === "object" && sessionSnapshot.capabilities !== null
          ? { ...DEFAULT_SESSION_CAPABILITIES, ...sessionSnapshot.capabilities }
          : resolveSessionCapabilities(this.session);
      return {
        ...this.snapshot,
        ...sessionSnapshot,
        backend: sessionSnapshot.backend || this.snapshot.backend,
        currentTurnStatus:
          typeof this.session?.getCurrentTurnStatus === "function"
            ? this.session.getCurrentTurnStatus()
            : sessionSnapshot.currentTurnStatus || this.currentTurnStatus || null,
        sessionId: sessionSnapshot.sessionId || this.threadIdValue || undefined,
        sessionInfo:
          typeof this.session?.getSessionInfo === "function"
            ? this.session.getSessionInfo()
            : sessionSnapshot.sessionInfo || this.sessionInfo || null,
        capabilities,
      };
    }
    return {
      ...this.snapshot,
      currentTurnStatus: this.getCurrentTurnStatus(),
      sessionInfo: this.sessionInfo ? { ...this.sessionInfo } : null,
    };
  }

  usesSessionFileReplyStream() {
    if (typeof this.session?.usesSessionFileReplyStream === "function") {
      return Boolean(this.session.usesSessionFileReplyStream());
    }
    return Boolean(this.useSessionFileReplyStreamValue);
  }

  getSessionInfo() {
    if (typeof this.session?.getSessionInfo === "function") {
      return this.session.getSessionInfo();
    }
    return this.sessionInfo ? { ...this.sessionInfo } : null;
  }

  getCurrentTurnStatus() {
    if (typeof this.session?.getCurrentTurnStatus === "function") {
      return this.session.getCurrentTurnStatus();
    }
    return this.currentTurnStatus ? { ...this.currentTurnStatus } : null;
  }

  setSessionMessageHandler(handler) {
    this.sessionMessageHandler = typeof handler === "function" ? handler : null;
    if (typeof this.session?.setSessionMessageHandler === "function") {
      this.session.setSessionMessageHandler(this.sessionMessageHandler);
    }
  }

  setWorkingStatusHandler(handler) {
    this.workingStatusHandler = typeof handler === "function" ? handler : null;
    if (typeof this.session?.setWorkingStatusHandler === "function") {
      this.session.setWorkingStatusHandler(this.workingStatusHandler);
    }
  }

  setSessionReplyTarget(replyTarget) {
    this.replyTarget = replyTarget;
    if (typeof this.session?.setSessionReplyTarget === "function") {
      this.session.setSessionReplyTarget(replyTarget);
    }
  }

  async ensureSessionInfo() {
    const session = await this.readyPromise;
    const sessionInfo = await session.ensureSessionInfo();
    this.sessionInfo = sessionInfo && typeof sessionInfo === "object" ? { ...sessionInfo } : sessionInfo;
    if (sessionInfo?.sessionId) {
      this.threadIdValue = String(sessionInfo.sessionId);
    }
    return sessionInfo;
  }

  async getSessionUsageSummary() {
    const session = await this.readyPromise;
    return await session.getSessionUsageSummary();
  }

  async interruptCurrentTurn() {
    const session = await this.readyPromise;
    if (typeof session.interruptCurrentTurn === "function") {
      return await session.interruptCurrentTurn();
    }
    return false;
  }

  async runTurn(promptText, options = {}) {
    const session = await this.readyPromise;
    return await session.runTurn(promptText, options);
  }

  async runGoal(goal, options = {}) {
    const session = await this.readyPromise;
    // Capability check: declarative `capabilities.goal === false` wins over
    // method presence. This matters because a proxy may unconditionally
    // forward runGoal and the per-method check would mis-report support.
    const capabilities = resolveSessionCapabilities(session);
    if (capabilities.goal === false) {
      throw createUnsupportedGoalError(session?.constructor?.name);
    }
    if (typeof session.runGoal !== "function") {
      throw createUnsupportedGoalError(session?.constructor?.name);
    }
    return await session.runGoal(goal, options);
  }

  async getGoal() {
    const session = await this.readyPromise;
    const capabilities = resolveSessionCapabilities(session);
    if (capabilities.goal === false) {
      return null;
    }
    if (typeof session.getGoal !== "function") {
      return null;
    }
    return await session.getGoal();
  }

  async clearGoal() {
    const session = await this.readyPromise;
    const capabilities = resolveSessionCapabilities(session);
    if (capabilities.goal === false) {
      return false;
    }
    if (typeof session.clearGoal !== "function") {
      return false;
    }
    return await session.clearGoal();
  }

  async close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      const session = await this.readyPromise;
      await session.close?.();
    } catch {
      // best effort
    }
  }
}

export function createAiSession(backend, options = {}) {
  if (process.env.CONDUCTOR_AI_SDK_DISABLE_WORKER === "1") {
    return new LocalAiSessionProxy(backend, options);
  }
  return new RemoteAiSession(backend, options);
}
