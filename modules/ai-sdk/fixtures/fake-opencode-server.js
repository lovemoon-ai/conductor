#!/usr/bin/env node

import http from "node:http";
import process from "node:process";

function parseCliArgs(argv) {
  let hostname = "127.0.0.1";
  let port = 0;
  for (const arg of argv) {
    if (arg.startsWith("--hostname=")) {
      hostname = arg.slice("--hostname=".length) || hostname;
    }
    if (arg.startsWith("--port=")) {
      const parsed = Number.parseInt(arg.slice("--port=".length), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        port = parsed;
      }
    }
  }
  return { hostname, port };
}

function sendJson(res, statusCode, payload) {
  const body = payload === undefined ? "" : JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return null;
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function buildSession(sessionId, directory) {
  const now = Date.now();
  return {
    id: sessionId,
    slug: sessionId,
    projectID: "project-fake-opencode",
    directory,
    title: `Fake ${sessionId}`,
    version: "1.0.0",
    time: {
      created: now,
      updated: now,
    },
  };
}

function buildAssistantMessage(sessionId, messageId) {
  const now = Date.now();
  return {
    id: messageId,
    sessionID: sessionId,
    role: "assistant",
    time: {
      created: now,
    },
    agent: "build",
    model: {
      providerID: "openai",
      modelID: "gpt-4.1",
    },
    cost: 0.12,
    tokens: {
      total: 120,
      input: 80,
      output: 30,
      reasoning: 10,
      cache: {
        read: 5,
        write: 2,
      },
    },
    variant: "default",
    finish: "stop",
  };
}

const sseClients = new Set();
const sessions = new Map();
let sessionCounter = 1;
let messageCounter = 1;
let reasoningCounter = 1;
let toolCounter = 1;
let textCounter = 1;

function writeEvent(event) {
  const chunk = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(chunk);
    } catch {
      // ignore dead clients
    }
  }
}

function emitStandardTurn(sessionId, promptText) {
  const messageId = `msg-opencode-${messageCounter++}`;
  const reasoningPartId = `part-reasoning-${reasoningCounter++}`;
  const toolPartId = `part-tool-${toolCounter++}`;
  const textPartId = `part-text-${textCounter++}`;
  const responseText = promptText.includes("[multi-message]") ? "开始计时 2 分钟。完成" : "OK from fake opencode\n";

  writeEvent({
    type: "session.status",
    properties: {
      sessionID: sessionId,
      status: { type: "busy" },
    },
  });

  writeEvent({
    type: "message.updated",
    properties: {
      info: buildAssistantMessage(sessionId, messageId),
    },
  });

  writeEvent({
    type: "message.part.updated",
    properties: {
      part: {
        id: reasoningPartId,
        sessionID: sessionId,
        messageID: messageId,
        type: "reasoning",
        text: "Thinking through the task",
        time: { start: Date.now() },
      },
    },
  });

  writeEvent({
    type: "todo.updated",
    properties: {
      sessionID: sessionId,
      todos: [
        {
          content: "Check workspace",
          status: "in_progress",
          priority: "medium",
        },
      ],
    },
  });

  writeEvent({
    type: "message.part.updated",
    properties: {
      part: {
        id: toolPartId,
        sessionID: sessionId,
        messageID: messageId,
        type: "tool",
        callID: `call-${toolPartId}`,
        tool: "bash",
        state: {
          status: "running",
          input: { command: "echo hi" },
          title: "Running bash",
          time: { start: Date.now() },
        },
      },
    },
  });

  writeEvent({
    type: "message.part.updated",
    properties: {
      part: {
        id: toolPartId,
        sessionID: sessionId,
        messageID: messageId,
        type: "tool",
        callID: `call-${toolPartId}`,
        tool: "bash",
        state: {
          status: "completed",
          input: { command: "echo hi" },
          output: "hi",
          title: "bash finished",
          metadata: {},
          time: { start: Date.now() - 10, end: Date.now() },
        },
      },
    },
  });

  if (promptText.includes("[multi-message]")) {
    const firstTextPartId = `part-text-${textCounter++}`;
    writeEvent({
      type: "message.part.updated",
      properties: {
        part: {
          id: firstTextPartId,
          sessionID: sessionId,
          messageID: messageId,
          type: "text",
          text: "开始计时 2 分钟。",
        },
      },
    });

    const secondMessageId = `msg-opencode-${messageCounter++}`;
    writeEvent({
      type: "message.updated",
      properties: {
        info: buildAssistantMessage(sessionId, secondMessageId),
      },
    });

    writeEvent({
      type: "message.part.updated",
      properties: {
        part: {
          id: textPartId,
          sessionID: sessionId,
          messageID: secondMessageId,
          type: "text",
          text: "完成",
        },
      },
    });
  } else {
    writeEvent({
      type: "message.part.updated",
      properties: {
        part: {
          id: textPartId,
          sessionID: sessionId,
          messageID: messageId,
          type: "text",
          text: "",
        },
      },
    });

    writeEvent({
      type: "message.part.delta",
      properties: {
        sessionID: sessionId,
        messageID: messageId,
        partID: textPartId,
        field: "text",
        delta: responseText,
      },
    });
  }

  writeEvent({
    type: "session.idle",
    properties: {
      sessionID: sessionId,
    },
  });
}

function emitAuthFailure(sessionId) {
  writeEvent({
    type: "session.status",
    properties: {
      sessionID: sessionId,
      status: { type: "busy" },
    },
  });
  writeEvent({
    type: "session.error",
    properties: {
      sessionID: sessionId,
      error: {
        name: "ProviderAuthError",
        data: {
          providerID: "openai",
          message: "Login required for provider",
        },
      },
    },
  });
}

const { hostname, port } = parseCliArgs(process.argv.slice(2));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || `${hostname}:${port}`}`);
  const pathname = url.pathname;
  const directoryHeader = req.headers["x-opencode-directory"];
  const directory =
    typeof directoryHeader === "string" && directoryHeader.trim()
      ? decodeURIComponent(directoryHeader)
      : process.cwd();

  if (req.method === "GET" && pathname === "/event") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");
    sseClients.add(res);
    req.on("close", () => {
      sseClients.delete(res);
    });
    return;
  }

  if (req.method === "POST" && pathname === "/session") {
    const sessionId = `session-fake-opencode-${sessionCounter++}`;
    const session = buildSession(sessionId, directory);
    sessions.set(sessionId, session);
    sendJson(res, 200, session);
    return;
  }

  const sessionMatch = pathname.match(/^\/session\/([^/]+)$/);
  if (req.method === "GET" && sessionMatch) {
    const sessionId = decodeURIComponent(sessionMatch[1]);
    const session = sessions.get(sessionId) || buildSession(sessionId, directory);
    sessions.set(sessionId, session);
    sendJson(res, 200, session);
    return;
  }

  const promptAsyncMatch = pathname.match(/^\/session\/([^/]+)\/prompt_async$/);
  if (req.method === "POST" && promptAsyncMatch) {
    const sessionId = decodeURIComponent(promptAsyncMatch[1]);
    const body = (await readJsonBody(req)) || {};
    const promptText = Array.isArray(body.parts)
      ? body.parts
          .filter((part) => part && part.type === "text")
          .map((part) => String(part.text || ""))
          .join("\n")
      : "";

    setTimeout(() => {
      if (promptText.includes("[auth-error]")) {
        emitAuthFailure(sessionId);
        return;
      }
      emitStandardTurn(sessionId, promptText);
    }, 15);

    res.statusCode = 204;
    res.end();
    return;
  }

  const abortMatch = pathname.match(/^\/session\/([^/]+)\/abort$/);
  if (req.method === "POST" && abortMatch) {
    const sessionId = decodeURIComponent(abortMatch[1]);
    writeEvent({
      type: "session.error",
      properties: {
        sessionID: sessionId,
        error: {
          name: "MessageAbortedError",
          data: {
            message: "Message aborted",
          },
        },
      },
    });
    sendJson(res, 200, {});
    return;
  }

  sendJson(res, 404, {
    name: "NotFoundError",
    data: {
      message: `Unhandled route ${req.method} ${pathname}`,
    },
  });
});

server.listen(port, hostname, () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  process.stdout.write(`opencode server listening on http://${hostname}:${actualPort}\n`);
});

process.on("SIGTERM", () => {
  server.close(() => {
    process.exit(0);
  });
});
