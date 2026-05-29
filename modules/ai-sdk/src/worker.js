#!/usr/bin/env node

import readline from "node:readline";

import { createLocalAiSession } from "./session-factory.js";
import {
  DEFAULT_SESSION_CAPABILITIES,
  resolveSessionCapabilities,
  serializeError,
} from "./shared.js";

function buildReadySnapshot(aiSession) {
  const snapshot = typeof aiSession?.getSnapshot === "function" ? aiSession.getSnapshot() : null;
  const base = snapshot && typeof snapshot === "object" ? { ...snapshot } : {};
  // Always include a capabilities field so the parent process can do the
  // declarative `capabilities.goal === false` short-circuit without needing
  // to inspect method names through the IPC boundary.
  if (!base.capabilities || typeof base.capabilities !== "object") {
    base.capabilities = resolveSessionCapabilities(aiSession);
  } else {
    base.capabilities = { ...DEFAULT_SESSION_CAPABILITIES, ...base.capabilities };
  }
  return base;
}

let session = null;
let sessionCreated = false;

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function attachSessionEvents(aiSession) {
  const forwardedEvents = [
    "session",
    "assistant_message",
    "working_status",
    "auth_required",
    "process.exited",
  ];
  for (const eventName of forwardedEvents) {
    if (typeof aiSession.on !== "function") {
      continue;
    }
    aiSession.on(eventName, (payload) => {
      send({
        type: "event",
        name: eventName,
        payload,
      });
    });
  }
}

async function handleCreate(message) {
  if (sessionCreated) {
    throw new Error("AI worker session already created");
  }
  sessionCreated = true;
  session = await createLocalAiSession(message.backend, {
    ...(message.options && typeof message.options === "object" ? message.options : {}),
    logger: {
      log: (line) => {
        send({
          type: "event",
          name: "log",
          payload: { message: line },
        });
      },
    },
  });
  attachSessionEvents(session);
  send({
    type: "ready",
    snapshot: buildReadySnapshot(session),
    workerPid: process.pid,
    workerProcessPid: process.pid,
  });
}

async function handleRequest(message) {
  if (!session) {
    throw new Error("AI worker session has not been created");
  }
  const method = String(message.method || "").trim();
  if (!method || typeof session[method] !== "function") {
    throw new Error(`Unsupported worker method: ${method}`);
  }
  const args = Array.isArray(message.args) ? [...message.args] : [];
  if (method === "runTurn" || method === "runGoal") {
    const firstArg = args[0];
    const options = args[1] && typeof args[1] === "object" ? { ...args[1] } : {};
    options.onProgress = (payload) => {
      send({
        type: "progress",
        requestId: message.id,
        payload,
      });
    };
    args[0] = firstArg;
    args[1] = options;
  }
  const result = await session[method](...args);
  send({
    type: "response",
    id: message.id,
    result,
  });
  if (method === "close") {
    // session.close() already ran via the dispatch above; route through the
    // guarded shutdown so a racing signal can't double-handle the exit.
    void gracefulShutdown(0);
  }
}

async function dispatchMessage(message) {
  try {
    if (message?.type === "create") {
      await handleCreate(message);
      return;
    }
    if (message?.type === "request" || message?.type === "control") {
      await handleRequest(message);
    }
  } catch (error) {
    send({
      type: message?.type === "create" ? "create_error" : "response",
      id: message?.id,
      error: serializeError(error),
    });
  }
}

// Upper bound on how long we wait for a graceful session close before
// giving up and exiting. A browser-backed session (chat-web) can hang in
// context.close(); without this cap the worker could fail to exit, which
// only makes orphaned browsers more likely. If close times out, the browser
// is reclaimed on the next launch via chat-web's profile-lock logic.
const CLOSE_TIMEOUT_MS = 10_000;

async function closeSession() {
  if (!session || typeof session.close !== "function") {
    return;
  }
  try {
    await Promise.race([
      Promise.resolve().then(() => session.close()),
      new Promise((resolve) => {
        const timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
        if (typeof timer.unref === "function") {
          timer.unref();
        }
      }),
    ]);
  } catch {
    // best effort
  }
}

// Graceful shutdown on termination signals. Without these handlers a worker
// killed via SIGTERM (e.g. when the parent fire is stopped) would exit
// without closing its session, leaking the Chromium browser it spawned.
let shuttingDown = false;
async function gracefulShutdown(exitCode) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  await closeSession();
  process.exit(exitCode);
}
process.on("SIGTERM", () => {
  void gracefulShutdown(143);
});
process.on("SIGINT", () => {
  void gracefulShutdown(130);
});

process.on("uncaughtException", (error) => {
  send({
    type: "event",
    name: "worker_error",
    payload: serializeError(error),
  });
  void gracefulShutdown(1);
});

process.on("unhandledRejection", (reason) => {
  send({
    type: "event",
    name: "worker_error",
    payload: serializeError(reason),
  });
  void gracefulShutdown(1);
});

process.stdin.on("end", () => {
  void gracefulShutdown(0);
});

const input = readline.createInterface({ input: process.stdin });
let workQueue = Promise.resolve();
input.on("line", (line) => {
  const normalized = String(line || "").trim();
  if (!normalized) {
    return;
  }
  let message;
  try {
    message = JSON.parse(normalized);
  } catch (error) {
    send({
      type: "event",
      name: "worker_error",
      payload: serializeError(error),
    });
    return;
  }

  if (message?.type === "control") {
    void dispatchMessage(message);
    return;
  }

  workQueue = workQueue
    .catch(() => {
      // keep queue alive after previous failure
    })
    .then(async () => {
      await dispatchMessage(message);
    });
});
