import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import net from "node:net";
import readline from "node:readline";

import {
  emitLog,
  normalizeLogger,
  parseCommandParts,
  sanitizeForLog,
  serializeError,
} from "../shared.js";

const DEFAULT_OPENCODE_COMMAND = "opencode";
const DEFAULT_HOSTNAME = "127.0.0.1";
const DEFAULT_BOOT_TIMEOUT_MS = 5000;

function createBootError(message, extras = {}) {
  const error = new Error(message);
  for (const [key, value] of Object.entries(extras)) {
    error[key] = value;
  }
  return error;
}

function parseServerUrlFromOutput(line) {
  const normalized = String(line || "").trim();
  if (!normalized.startsWith("opencode server listening")) {
    return "";
  }
  const match = normalized.match(/on\s+(https?:\/\/[^\s]+)/i);
  return match?.[1] ? String(match[1]).trim() : "";
}

function readExplicitServerOptionValue(args, index) {
  const next = args[index + 1];
  if (next === undefined) {
    return { value: "", nextIndex: index };
  }
  const normalized = String(next).trim();
  if (!normalized || normalized.startsWith("--")) {
    return { value: "", nextIndex: index };
  }
  return {
    value: normalized,
    nextIndex: index + 1,
  };
}

function parseExplicitServerOptions(args) {
  let hasExplicitHostname = false;
  let explicitHostname = "";
  let hasExplicitPort = false;
  let explicitPortRaw = "";

  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index] || "").trim();
    if (!arg) {
      continue;
    }

    if (arg.startsWith("--hostname=")) {
      hasExplicitHostname = true;
      explicitHostname = arg.slice("--hostname=".length).trim();
      continue;
    }

    if (arg === "--hostname") {
      const parsed = readExplicitServerOptionValue(args, index);
      hasExplicitHostname = true;
      explicitHostname = parsed.value;
      index = parsed.nextIndex;
      continue;
    }

    if (arg.startsWith("--port=")) {
      hasExplicitPort = true;
      explicitPortRaw = arg.slice("--port=".length).trim();
      continue;
    }

    if (arg === "--port") {
      const parsed = readExplicitServerOptionValue(args, index);
      hasExplicitPort = true;
      explicitPortRaw = parsed.value;
      index = parsed.nextIndex;
    }
  }

  const explicitPort =
    /^\d+$/.test(explicitPortRaw) && Number.parseInt(explicitPortRaw, 10) > 0
      ? Number.parseInt(explicitPortRaw, 10)
      : 0;

  return {
    hasExplicitHostname,
    explicitHostname,
    hasExplicitPort,
    explicitPort,
    explicitPortRaw,
  };
}

async function allocatePort(hostname) {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, hostname, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        if (!port) {
          reject(new Error("Failed to allocate opencode server port"));
          return;
        }
        resolve(port);
      });
    });
  });
}

export class OpencodeServerTransport extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.logger = normalizeLogger(options.logger);
    this.cwd =
      typeof options.cwd === "string" && options.cwd.trim()
        ? options.cwd.trim()
        : process.cwd();
    const commandLine =
      process.env.CONDUCTOR_OPENCODE_COMMAND ||
      options.commandLine ||
      process.env.CONDUCTOR_CLI_COMMAND ||
      DEFAULT_OPENCODE_COMMAND;
    const { command, args } = parseCommandParts(commandLine);
    if (!command) {
      throw new Error("Invalid opencode command");
    }
    this.command = command;
    this.baseArgs = args;
    const explicitServerOptions = parseExplicitServerOptions(args);
    this.hasExplicitHostnameArg = explicitServerOptions.hasExplicitHostname;
    this.hasExplicitPortArg = explicitServerOptions.hasExplicitPort;
    this.explicitPortRaw = explicitServerOptions.explicitPortRaw;
    this.explicitPort = explicitServerOptions.explicitPort;
    this.hostname =
      explicitServerOptions.explicitHostname ||
      (typeof options.hostname === "string" && options.hostname.trim() ? options.hostname.trim() : DEFAULT_HOSTNAME);
    this.port =
      explicitServerOptions.explicitPort ||
      (Number.isFinite(Number(options.port)) && Number(options.port) > 0 ? Number(options.port) : 0);
    this.bootTimeoutMs = Number.isFinite(Number(options.timeout)) && Number(options.timeout) > 0
      ? Number(options.timeout)
      : DEFAULT_BOOT_TIMEOUT_MS;
    this.env = options.env && typeof options.env === "object" ? { ...options.env } : {};
    this.config = options.config && typeof options.config === "object" ? { ...options.config } : {};
    this.child = null;
    this.childContext = null;
    this.stdoutReader = null;
    this.stderrReader = null;
    this.bootPromise = null;
    this.booted = false;
    this.closeRequested = false;
    this.closed = false;
    this.url = "";
    this.stderrTail = [];
    this.stderrTailMax = 20;
    this.resolveReady = null;
    this.rejectReady = null;
    this.readyTimer = null;
    this.fixedPortWarningLogged = false;
  }

  log(message) {
    emitLog(this.logger, message);
  }

  async boot() {
    if (this.booted) {
      return { url: this.url };
    }
    if (this.bootPromise) {
      return this.bootPromise;
    }
    this.bootPromise = this.bootInternal();
    try {
      const result = await this.bootPromise;
      this.booted = true;
      return result;
    } finally {
      this.bootPromise = null;
    }
  }

  async bootInternal() {
    if (!this.hasExplicitPortArg && !this.port) {
      this.port = await allocatePort(this.hostname);
    }
    await this.spawnChild();
    if (!this.url) {
      throw createBootError("Opencode server did not expose a URL", {
        reason: "missing_server_url",
      });
    }
    return { url: this.url };
  }

  buildArgs() {
    const args = [...this.baseArgs];
    if (!args.includes("serve")) {
      args.push("serve");
    }
    if (!this.hasExplicitHostnameArg) {
      args.push(`--hostname=${this.hostname}`);
    }
    if (!this.hasExplicitPortArg) {
      args.push(`--port=${this.port}`);
    } else if (!this.fixedPortWarningLogged) {
      const configuredPort = this.explicitPort || this.explicitPortRaw || "<unknown>";
      this.log(
        `[opencode-server] using configured --port ${configuredPort}; concurrent opencode tasks on the same machine may fail to start`,
      );
      this.fixedPortWarningLogged = true;
    }
    return args;
  }

  async spawnChild() {
    if (this.childContext) {
      if (this.url) {
        return;
      }
      await this.terminateChild(this.childContext, { suppressExit: true });
    }

    const args = this.buildArgs();
    this.log(`[opencode-server] spawn ${[this.command, ...args].join(" ")} (cwd: ${this.cwd})`);
    const child = spawn(this.command, args, {
      cwd: this.cwd,
      env: {
        ...process.env,
        ...this.env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(this.config || {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const context = {
      child,
      stdoutReader: null,
      stderrReader: null,
      suppressExit: false,
      onError: null,
      onExit: null,
    };
    this.childContext = context;
    this.child = child;
    this.stdoutReader = null;
    this.stderrReader = null;

    const readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
      this.readyTimer = setTimeout(() => {
        reject(
          createBootError(`Timed out waiting for opencode server after ${this.bootTimeoutMs}ms`, {
            reason: "boot_timeout",
            stderr: this.stderrTail.slice(),
          }),
        );
      }, this.bootTimeoutMs);
      if (typeof this.readyTimer.unref === "function") {
        this.readyTimer.unref();
      }
    });

    context.stdoutReader = readline.createInterface({ input: child.stdout });
    this.stdoutReader = context.stdoutReader;
    context.stdoutReader.on("line", (line) => {
      this.handleStdoutLine(line, context);
    });

    context.stderrReader = readline.createInterface({ input: child.stderr });
    this.stderrReader = context.stderrReader;
    context.stderrReader.on("line", (line) => {
      this.handleStderrLine(line, context);
    });

    context.onError = (error) => {
      if (this.childContext !== context || context.suppressExit) {
        return;
      }
      this.failReady(error);
      this.emit("process_error", serializeError(error));
    };
    child.on("error", context.onError);

    context.onExit = (code, signal) => {
      const info = {
        code,
        signal,
        stderr: this.stderrTail.slice(),
      };
      const isActiveContext = this.childContext === context;
      this.clearChildContext(context);
      if (!isActiveContext || context.suppressExit) {
        return;
      }
      const error = createBootError(
        this.closeRequested
          ? "Opencode server closed"
          : `Opencode server exited (code=${code ?? "null"} signal=${signal ?? "null"})`,
        {
          reason: this.closeRequested ? "session_closed" : "transport_exited",
          code,
          signal,
          stderr: info.stderr,
        },
      );
      this.failReady(error);
      this.closed = true;
      this.emit("process_exit", info);
    };
    child.on("exit", context.onExit);

    try {
      await readyPromise;
    } catch (error) {
      this.failReady(error);
      await this.terminateChild(context, { suppressExit: true });
      throw error;
    }
  }

  handleStdoutLine(line, context = null) {
    if (context && (this.childContext !== context || context.suppressExit)) {
      return;
    }
    const normalized = String(line || "").trim();
    if (!normalized) {
      return;
    }
    const url = parseServerUrlFromOutput(normalized);
    if (url) {
      this.url = url;
      this.log(`[opencode-server] ready ${url}`);
      this.finishReady();
      return;
    }
    this.log(`[opencode-server] stdout ${sanitizeForLog(normalized, 300)}`);
  }

  handleStderrLine(line, context = null) {
    if (context && (this.childContext !== context || context.suppressExit)) {
      return;
    }
    const normalized = String(line || "");
    if (!normalized.trim()) {
      return;
    }
    this.stderrTail.push(normalized);
    if (this.stderrTail.length > this.stderrTailMax) {
      this.stderrTail.shift();
    }
    this.log(`[opencode-server] stderr ${sanitizeForLog(normalized, 300)}`);
    this.emit("stderr", { line: normalized });
  }

  finishReady() {
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    this.resolveReady?.({ url: this.url });
    this.resolveReady = null;
    this.rejectReady = null;
  }

  failReady(error) {
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    this.rejectReady?.(error);
    this.resolveReady = null;
    this.rejectReady = null;
    this.booted = false;
    this.url = "";
  }

  clearChildContext(context) {
    if (!context) {
      return;
    }
    if (context.stdoutReader) {
      context.stdoutReader.removeAllListeners();
      context.stdoutReader.close();
    }
    if (context.stderrReader) {
      context.stderrReader.removeAllListeners();
      context.stderrReader.close();
    }
    if (context.child && typeof context.onError === "function") {
      context.child.off("error", context.onError);
    }
    if (context.child && typeof context.onExit === "function") {
      context.child.off("exit", context.onExit);
    }
    if (this.childContext === context) {
      this.childContext = null;
      this.child = null;
      this.stdoutReader = null;
      this.stderrReader = null;
    }
  }

  async terminateChild(context, { suppressExit = false } = {}) {
    if (!context?.child) {
      this.clearChildContext(context);
      return;
    }
    context.suppressExit = context.suppressExit || suppressExit;
    const child = context.child;
    if (child.exitCode !== null || child.signalCode !== null) {
      this.clearChildContext(context);
      return;
    }
    await new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const finalize = () => {
        if (settled) {
          return;
        }
        settled = true;
        child.off("exit", finalize);
        if (timer) {
          clearTimeout(timer);
        }
        resolve();
      };
      child.once("exit", finalize);
      try {
        child.kill("SIGTERM");
      } catch {
        finalize();
        return;
      }
      timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, 1500);
      if (typeof timer.unref === "function") {
        timer.unref();
      }
    });
    this.clearChildContext(context);
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
    if (!this.childContext) {
      this.closed = true;
      return;
    }
    await this.terminateChild(this.childContext);
    this.closed = true;
  }
}
