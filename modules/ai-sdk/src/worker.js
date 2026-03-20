#!/usr/bin/env node

import readline from "node:readline";

import { createLocalAiSession } from "./session-factory.js";
import { serializeError } from "./shared.js";

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
  session = createLocalAiSession(message.backend, {
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
    snapshot: typeof session.getSnapshot === "function" ? session.getSnapshot() : null,
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
  if (method === "runTurn") {
    const prompt = args[0];
    const options = args[1] && typeof args[1] === "object" ? { ...args[1] } : {};
    options.onProgress = (payload) => {
      send({
        type: "progress",
        requestId: message.id,
        payload,
      });
    };
    args[0] = prompt;
    args[1] = options;
  }
  const result = await session[method](...args);
  send({
    type: "response",
    id: message.id,
    result,
  });
  if (method === "close") {
    process.exit(0);
  }
}

async function closeSession() {
  if (!session || typeof session.close !== "function") {
    return;
  }
  try {
    await session.close();
  } catch {
    // best effort
  }
}

process.on("uncaughtException", async (error) => {
  send({
    type: "event",
    name: "worker_error",
    payload: serializeError(error),
  });
  await closeSession();
  process.exit(1);
});

process.on("unhandledRejection", async (reason) => {
  send({
    type: "event",
    name: "worker_error",
    payload: serializeError(reason),
  });
  await closeSession();
  process.exit(1);
});

process.stdin.on("end", async () => {
  await closeSession();
  process.exit(0);
});

const input = readline.createInterface({ input: process.stdin });
let workQueue = Promise.resolve();
input.on("line", (line) => {
  workQueue = workQueue
    .catch(() => {
      // keep queue alive after previous failure
    })
    .then(async () => {
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

    try {
      if (message?.type === "create") {
        await handleCreate(message);
        return;
      }
      if (message?.type === "request") {
        await handleRequest(message);
      }
    } catch (error) {
      send({
        type: message?.type === "create" ? "create_error" : "response",
        id: message?.id,
        error: serializeError(error),
      });
    }
    });
});
