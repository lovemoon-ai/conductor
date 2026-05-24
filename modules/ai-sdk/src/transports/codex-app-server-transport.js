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

const DEFAULT_CODEX_APP_SERVER_COMMAND = "codex app-server --listen stdio://";

/**
 * Add `--enable goals` to the codex app-server spawn args when goal mode is
 * requested. Dynamic enablement via `experimentalFeature/enablement/set` is
 * NOT supported by codex, so the feature must be enabled at boot. Idempotent:
 * does not double-add when the user already passed any of the supported
 * spellings (`--enable goals`, `--enable=goals`, `--enable=goals,foo`) in the
 * command line.
 *
 * @param {string[]} args
 * @param {boolean} enableGoals
 * @returns {string[]}
 */
function injectEnableGoalsArgs(args, enableGoals) {
  const normalized = Array.isArray(args) ? [...args] : [];
  if (!enableGoals) {
    return normalized;
  }
  for (let index = 0; index < normalized.length; index += 1) {
    const token = normalized[index];
    if (typeof token !== "string") {
      continue;
    }
    // Two-token form: ["--enable", "goals"]
    if (token === "--enable" && normalized[index + 1] === "goals") {
      return normalized;
    }
    // Equals form: "--enable=goals" or comma list "--enable=goals,foo"
    if (token.startsWith("--enable=")) {
      const value = token.slice("--enable=".length);
      const features = value
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean);
      if (features.includes("goals")) {
        return normalized;
      }
    }
  }
  const listenIndex = normalized.indexOf("--listen");
  const insertAt = listenIndex >= 0 ? listenIndex : normalized.length;
  normalized.splice(insertAt, 0, "--enable", "goals");
  return normalized;
}

function createRpcError(payload) {
  const message = String(payload?.message || payload?.error?.message || "Codex app-server request failed");
  const error = new Error(message);
  const source = payload?.error && typeof payload.error === "object" ? payload.error : payload;
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

export class CodexAppServerTransport extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.logger = normalizeLogger(options.logger);
    this.cwd =
      typeof options.cwd === "string" && options.cwd.trim()
        ? options.cwd.trim()
        : process.cwd();
    const commandLine =
      process.env.CONDUCTOR_CODEX_APP_SERVER_COMMAND ||
      options.commandLine ||
      DEFAULT_CODEX_APP_SERVER_COMMAND;
    const { command, args } = parseCommandParts(commandLine);
    if (!command) {
      throw new Error("Invalid codex app-server command");
    }
    this.command = command;
    this.enableGoals = options.enableGoals === true;
    this.args = injectEnableGoalsArgs(args, this.enableGoals);
    this.env = options.env && typeof options.env === "object" ? { ...options.env } : {};
    this.ignoreCodexApiKey = options.ignoreCodexApiKey === true;
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
    this.protocolTrace = process.env.CONDUCTOR_CODEX_APP_SERVER_TRACE === "1";
  }

  log(message) {
    emitLog(this.logger, message);
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
    } finally {
      this.bootPromise = null;
    }
  }

  async bootInternal() {
    this.spawnChild();
    const initializeResult = await this.requestRaw("initialize", {
      clientInfo: {
        name: "conductor-ai-sdk",
        version: "0.0.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    this.log(
      `[codex-app-server] initialized ua="${sanitizeForLog(initializeResult?.userAgent || "", 160)}" cwd=${this.cwd}`,
    );
    this.sendNotification("initialized", {});
  }

  spawnChild() {
    if (this.child) {
      return;
    }
    this.log(`[codex-app-server] spawn ${[this.command, ...this.args].join(" ")} (cwd: ${this.cwd})`);
    const env = {
      ...process.env,
      PWD: this.cwd,
      ...this.env,
    };
    if (this.ignoreCodexApiKey) {
      delete env.CODEX_API_KEY;
    }
    const child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env,
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
      const reason = this.closeRequested
        ? new Error("Codex app-server closed")
        : new Error(`Codex app-server exited (code=${code ?? "null"} signal=${signal ?? "null"})`);
      reason.reason = this.closeRequested ? "session_closed" : "transport_exited";
      reason.exitCode = code;
      reason.signal = signal;
      reason.stderr = info.stderr;
      this.failPendingRequests(reason);
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
      this.log(`[codex-app-server] stdout ${sanitizeForLog(normalized, 400)}`);
    }
    let payload;
    try {
      payload = JSON.parse(normalized);
    } catch {
      this.log(`[codex-app-server] invalid stdout line: ${sanitizeForLog(normalized, 240)}`);
      return;
    }

    if (payload && Object.prototype.hasOwnProperty.call(payload, "id")) {
      const pending = this.pending.get(payload.id);
      if (!pending) {
        return;
      }
      this.pending.delete(payload.id);
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
    this.log(`[codex-app-server] stderr ${sanitizeForLog(normalized, 300)}`);
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
      const error = new Error("Codex app-server transport is not running");
      error.reason = "transport_not_running";
      return Promise.reject(error);
    }
    const id = this.nextRequestId++;
    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };
    if (this.protocolTrace) {
      this.log(`[codex-app-server] -> ${sanitizeForLog(JSON.stringify(payload), 400)}`);
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

  sendNotification(method, params = {}) {
    if (!this.child || this.closed) {
      return;
    }
    const payload = {
      jsonrpc: "2.0",
      method,
      params,
    };
    if (this.protocolTrace) {
      this.log(`[codex-app-server] -> ${sanitizeForLog(JSON.stringify(payload), 400)}`);
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
