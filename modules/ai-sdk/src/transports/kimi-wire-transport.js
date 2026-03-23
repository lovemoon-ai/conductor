import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import readline from "node:readline";

import {
  emitLog,
  normalizeLogger,
  parseCommandParts,
  sanitizeForLog,
  serializeError,
} from "../shared.js";

const DEFAULT_KIMI_COMMAND = "kimi";
const DEFAULT_PROTOCOL_VERSION = "1.5";

function createRpcError(payload) {
  const source = payload?.error && typeof payload.error === "object" ? payload.error : payload;
  const message = String(source?.message || "Kimi wire request failed");
  const error = new Error(message);
  if (source && typeof source === "object") {
    if (source.code !== undefined) {
      error.code = source.code;
    }
    if (source.data !== undefined) {
      error.data = source.data;
    }
  }
  return error;
}

function normalizeRequestId(value) {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return "";
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

export class KimiWireTransport extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.logger = normalizeLogger(options.logger);
    this.cwd =
      typeof options.cwd === "string" && options.cwd.trim()
        ? options.cwd.trim()
        : process.cwd();
    const commandLine =
      process.env.CONDUCTOR_KIMI_COMMAND ||
      options.commandLine ||
      process.env.CONDUCTOR_CLI_COMMAND ||
      DEFAULT_KIMI_COMMAND;
    const { command, args } = parseCommandParts(commandLine);
    if (!command) {
      throw new Error("Invalid kimi command");
    }
    this.command = command;
    this.baseArgs = args;
    this.env = options.env && typeof options.env === "object" ? { ...options.env } : {};
    this.sessionId =
      typeof options.sessionId === "string" && options.sessionId.trim()
        ? options.sessionId.trim()
        : "";
    this.model =
      typeof options.model === "string" && options.model.trim()
        ? options.model.trim()
        : "";
    this.child = null;
    this.stdoutReader = null;
    this.stderrReader = null;
    this.pending = new Map();
    this.nextRequestId = 1;
    this.bootPromise = null;
    this.booted = false;
    this.closeRequested = false;
    this.closed = false;
    this.stderrTail = [];
    this.stderrTailMax = 20;
    this.protocolTrace = process.env.CONDUCTOR_KIMI_WIRE_TRACE === "1";
  }

  log(message) {
    emitLog(this.logger, message);
  }

  buildArgs() {
    const args = [...this.baseArgs];
    args.push("--wire");
    args.push("--yolo");
    args.push(`--work-dir=${this.cwd}`);
    if (this.sessionId) {
      args.push(`--session=${this.sessionId}`);
    }
    if (this.model) {
      args.push(`--model=${this.model}`);
    }
    return args;
  }

  buildResumeCommandLine() {
    const parts = [...this.baseArgs, "--work-dir", this.cwd];
    if (this.sessionId) {
      parts.push("--session", this.sessionId);
    }
    if (this.model) {
      parts.push("--model", this.model);
    }
    return [this.command, ...parts].map(quoteShellArg).join(" ");
  }

  async boot() {
    if (this.booted) {
      return;
    }
    if (this.bootPromise) {
      return this.bootPromise;
    }
    this.bootPromise = this.bootInternal();
    try {
      await this.bootPromise;
      this.booted = true;
    } catch (error) {
      try {
        await this.close();
      } catch {
        // best effort
      }
      throw error;
    } finally {
      this.bootPromise = null;
    }
  }

  async bootInternal() {
    this.spawnChild();
    let initializeResult = null;
    try {
      initializeResult = await this.requestRaw("initialize", {
        protocol_version: DEFAULT_PROTOCOL_VERSION,
        client: {
          name: "conductor-ai-sdk",
          version: "0.0.0",
        },
        capabilities: {
          supports_question: false,
          supports_plan_mode: false,
        },
      });
    } catch (error) {
      if (error?.code !== -32601) {
        throw error;
      }
      this.log("[kimi-wire] initialize not supported, continuing without handshake");
      return;
    }

    const protocolVersion =
      typeof initializeResult?.protocol_version === "string"
        ? initializeResult.protocol_version.trim()
        : "";
    const serverName =
      typeof initializeResult?.server?.name === "string"
        ? initializeResult.server.name.trim()
        : "";
    const serverVersion =
      typeof initializeResult?.server?.version === "string"
        ? initializeResult.server.version.trim()
        : "";
    this.log(
      `[kimi-wire] initialized protocol=${protocolVersion || "<unknown>"} server=${serverName || "<unknown>"} version=${serverVersion || "<unknown>"}`,
    );
  }

  spawnChild() {
    if (this.child) {
      return;
    }
    const args = this.buildArgs();
    this.log(`[kimi-wire] spawn ${[this.command, ...args].join(" ")} (cwd: ${this.cwd})`);
    const child = spawn(this.command, args, {
      cwd: this.cwd,
      env: {
        ...process.env,
        PWD: this.cwd,
        ...this.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    this.stdoutReader = readline.createInterface({ input: child.stdout });
    this.stdoutReader.on("line", (line) => {
      this.handleStdoutLine(line);
    });

    this.stderrReader = readline.createInterface({ input: child.stderr });
    this.stderrReader.on("line", (line) => {
      this.handleStderrLine(line);
    });

    child.on("error", (error) => {
      this.failPendingRequests(error);
      this.emit("process_error", serializeError(error));
    });

    child.on("exit", (code, signal) => {
      const info = {
        code,
        signal,
        stderr: this.stderrTail.slice(),
      };
      const error = this.closeRequested
        ? new Error("Kimi wire transport closed")
        : new Error(`Kimi wire transport exited (code=${code ?? "null"} signal=${signal ?? "null"})`);
      error.reason = this.closeRequested ? "session_closed" : "transport_exited";
      error.exitCode = code;
      error.signal = signal;
      error.stderr = info.stderr;
      this.failPendingRequests(error);
      this.closed = true;
      this.emit("process_exit", info);
    });
  }

  handleStdoutLine(line) {
    const normalized = String(line || "").trim();
    if (!normalized) {
      return;
    }
    if (this.protocolTrace) {
      this.log(`[kimi-wire] stdout ${sanitizeForLog(normalized, 400)}`);
    }
    let payload;
    try {
      payload = JSON.parse(normalized);
    } catch {
      this.log(`[kimi-wire] invalid stdout line: ${sanitizeForLog(normalized, 240)}`);
      return;
    }

    const hasId = Object.prototype.hasOwnProperty.call(payload, "id");
    if (payload?.method === "event") {
      this.emit("event", {
        type: payload?.params?.type,
        payload: payload?.params?.payload ?? {},
      });
      return;
    }

    if (payload?.method === "request" && hasId) {
      this.emit("request", {
        id: payload.id,
        type: payload?.params?.type,
        payload: payload?.params?.payload ?? {},
      });
      return;
    }

    if (hasId) {
      const requestId = normalizeRequestId(payload.id);
      const pending = this.pending.get(requestId);
      if (!pending) {
        return;
      }
      this.pending.delete(requestId);
      if (payload.error) {
        pending.reject(createRpcError(payload));
        return;
      }
      pending.resolve(payload.result);
      return;
    }

    if (payload?.method) {
      this.emit("notification", {
        method: payload.method,
        params: payload.params ?? {},
      });
    }
  }

  handleStderrLine(line) {
    const normalized = String(line || "");
    if (!normalized.trim()) {
      return;
    }
    this.stderrTail.push(normalized);
    if (this.stderrTail.length > this.stderrTailMax) {
      this.stderrTail.shift();
    }
    this.log(`[kimi-wire] stderr ${sanitizeForLog(normalized, 300)}`);
    this.emit("stderr", { line: normalized });
  }

  failPendingRequests(error) {
    if (this.pending.size === 0) {
      return;
    }
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  async request(method, params = {}) {
    await this.boot();
    return this.requestRaw(method, params);
  }

  requestRaw(method, params = {}) {
    if (!this.child || this.closed) {
      const error = new Error("Kimi wire transport is not running");
      error.reason = "transport_not_running";
      return Promise.reject(error);
    }
    const id = String(this.nextRequestId++);
    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };
    if (this.protocolTrace) {
      this.log(`[kimi-wire] -> ${sanitizeForLog(JSON.stringify(payload), 400)}`);
    }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.child.stdin.write(`${JSON.stringify(payload)}\n`);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  sendResponse(id, result = {}) {
    if (!this.child || this.closed) {
      return;
    }
    const requestId = normalizeRequestId(id);
    if (!requestId) {
      return;
    }
    const payload = {
      jsonrpc: "2.0",
      id: requestId,
      result,
    };
    if (this.protocolTrace) {
      this.log(`[kimi-wire] -> ${sanitizeForLog(JSON.stringify(payload), 400)}`);
    }
    try {
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    } catch {
      // best effort
    }
  }

  sendError(id, error = {}) {
    if (!this.child || this.closed) {
      return;
    }
    const requestId = normalizeRequestId(id);
    if (!requestId) {
      return;
    }
    const payload = {
      jsonrpc: "2.0",
      id: requestId,
      error: {
        code: Number.isFinite(Number(error?.code)) ? Number(error.code) : -32603,
        message: String(error?.message || "Internal error"),
        ...(error?.data !== undefined ? { data: error.data } : {}),
      },
    };
    if (this.protocolTrace) {
      this.log(`[kimi-wire] -> ${sanitizeForLog(JSON.stringify(payload), 400)}`);
    }
    try {
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    } catch {
      // best effort
    }
  }

  get pid() {
    return this.child?.pid || null;
  }

  getRecentStderr() {
    return this.stderrTail.slice();
  }

  async close() {
    if (this.closed) {
      return;
    }
    this.closeRequested = true;
    if (!this.child) {
      this.closed = true;
      return;
    }
    const child = this.child;
    await new Promise((resolve) => {
      let settled = false;
      const finalize = () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      };
      child.once("exit", finalize);
      try {
        child.kill("SIGTERM");
      } catch {
        finalize();
        return;
      }
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
        finalize();
      }, 1500);
      if (typeof timer.unref === "function") {
        timer.unref();
      }
    });
    this.closed = true;
  }
}
