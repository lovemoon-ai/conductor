#!/usr/bin/env node
// Fake DeepSeek Harness SDK runtime for tests.
//
// Speaks the newline-delimited JSON-RPC stdio protocol the real
// `dsh-jsonrpc-agent` runtime speaks (`@deepseek-ai/dsh-sdk-protocol`):
//   requests:      initialize, session/prompt, shutdown
//   notifications: session.event, session.status
//
// Behavior is selected per prompt via markers in the prompt text:
//   (default)        reply "echo:<prompt>"
//   [echo-session]   reply with the wire sessionId (proves session reuse)
//   [tool]           emit tool/call + todo/write before the reply
//   [hang]           emit the inbox receipt + running status, then never finish
//   [fail-turn]      end the turn with reason kind "error" and no reply

import readline from "node:readline";

let messageCounter = 0;
let seq = 0;

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

function sessionEvent(sessionId, event) {
  notify("session.event", {
    sessionId,
    event: { seq: (seq += 1), time: 1_755_000_000_000 + seq, ...event },
  });
}

function promptText(contentBlocks) {
  if (!Array.isArray(contentBlocks)) {
    return "";
  }
  return contentBlocks
    .map((block) => (block?.type === "text" && typeof block.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("");
}

function handlePrompt(id, params) {
  const sessionId = String(params?.sessionId || "");
  const text = promptText(params?.contentBlocks);
  const messageId = `msg-${(messageCounter += 1)}`;
  respond(id, { messageId });

  sessionEvent(sessionId, {
    type: "agent/inbox/spliced",
    data: { inserted: [{ id: messageId }] },
  });
  notify("session.status", { sessionId, status: "running" });
  sessionEvent(sessionId, { type: "turn/start", data: { turn: 1 } });

  // Marker precedence: [echo-session] wins over [hang] so a rotated turn
  // whose history seed still contains an earlier "[hang]" prompt can settle.
  if (text.includes("[hang]") && !text.includes("[echo-session]")) {
    return;
  }

  if (text.includes("[fail-turn]")) {
    sessionEvent(sessionId, {
      type: "turn/end",
      data: { turn: 1, reason: { kind: "error", error: { message: "fake api key rejected", code: "AUTH" } } },
    });
    notify("session.status", { sessionId, status: "idle" });
    return;
  }

  if (text.includes("[tool]")) {
    sessionEvent(sessionId, {
      type: "tool/call",
      data: { turn: 1, step: 1, callId: "call-1", name: "bash", arguments: '{"command":"ls"}' },
    });
    sessionEvent(sessionId, {
      type: "tool/result",
      data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "ok" }] } },
    });
    sessionEvent(sessionId, {
      type: "todo/write",
      data: { todos: [{ content: "list files", status: "completed" }] },
    });
  }

  const replyText = text.includes("[echo-session]") ? sessionId : `echo:${text}`;
  // Token-level chunk, as the real runtime streams before the assembled
  // message; the session must NOT surface these in result.items.
  sessionEvent(sessionId, {
    type: "assistant/chunk",
    data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: replyText } },
  });
  sessionEvent(sessionId, {
    type: "assistant/message",
    data: {
      turn: 1,
      step: 1,
      message: { content: [{ type: "text", text: replyText }] },
      usage: { inputTokens: 3, outputTokens: 5 },
    },
  });
  sessionEvent(sessionId, { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
  notify("session.status", { sessionId, status: "idle" });
}

const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const trimmed = String(line || "").trim();
  if (!trimmed) {
    return;
  }
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  const { id, method, params } = message;
  if (method === "initialize") {
    respond(id, {
      serverInfo: { name: "deepseek-harness-sdk-runtime", version: "0.0.0-fake" },
    });
    return;
  }
  if (method === "session/prompt") {
    handlePrompt(id, params);
    return;
  }
  if (method === "shutdown") {
    respond(id, {});
    return;
  }
  if (id !== undefined) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } });
  }
});

process.stdin.on("end", () => {
  process.exit(0);
});
