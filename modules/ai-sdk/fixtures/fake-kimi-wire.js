#!/usr/bin/env node

import readline from "node:readline";

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function respond(id, result) {
  send({
    jsonrpc: "2.0",
    id,
    result,
  });
}

function respondError(id, message, code = -32603, data = undefined) {
  send({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data !== undefined ? { data } : {}),
    },
  });
}

function emitEvent(type, payload = {}) {
  send({
    jsonrpc: "2.0",
    method: "event",
    params: {
      type,
      payload,
    },
  });
}

function emitRequest(id, type, payload = {}) {
  send({
    jsonrpc: "2.0",
    method: "request",
    id,
    params: {
      type,
      payload,
    },
  });
}

function readCliFlag(argv, name, fallback = "") {
  const longEquals = `${name}=`;
  for (let index = 0; index < argv.length; index += 1) {
    const value = String(argv[index] || "");
    if (value.startsWith(longEquals)) {
      return value.slice(longEquals.length) || fallback;
    }
    if (value === name) {
      const next = String(argv[index + 1] || "");
      if (next && !next.startsWith("-")) {
        return next;
      }
    }
  }
  return fallback;
}

function extractPromptText(userInput) {
  if (typeof userInput === "string") {
    return userInput.trim();
  }
  if (Array.isArray(userInput)) {
    return userInput
      .map((entry) => (entry?.type === "text" && typeof entry.text === "string" ? entry.text : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  return "";
}

const argv = process.argv.slice(2);
const sessionId = readCliFlag(argv, "--session", "session-fake-kimi-default");
const workDir = readCliFlag(argv, "--work-dir", process.cwd());
const model = readCliFlag(argv, "--model", "kimi-k2.5");

let turnCounter = 0;
let pendingQuestion = null;

function emitStandardTurn(promptText) {
  turnCounter += 1;
  const responseText = promptText.includes("[multi-turn]")
    ? `turn ${turnCounter} from fake kimi\n`
    : "OK from fake kimi\n";

  emitEvent("TurnBegin", {
    user_input: promptText,
  });
  emitEvent("StepBegin", {
    n: turnCounter,
  });
  emitEvent("StatusUpdate", {
    context_usage: 0.57,
    context_tokens: 570,
    max_context_tokens: 1000,
    token_usage: {
      input_other: 20,
      output: 12,
      input_cache_read: 4,
      input_cache_creation: 1,
    },
  });
  emitEvent("ContentPart", {
    type: "think",
    think: "Thinking through the task",
  });
  emitEvent("ToolCall", {
    type: "function",
    id: `tool-${turnCounter}`,
    function: {
      name: "Shell",
      arguments: "{\"command\":\"echo hi\"}",
    },
  });
  emitEvent("ToolResult", {
    tool_call_id: `tool-${turnCounter}`,
    return_value: {
      is_error: false,
      output: "hi",
      message: "command finished",
      display: [],
    },
  });
  const midpoint = Math.max(1, Math.floor(responseText.length / 2));
  emitEvent("ContentPart", {
    type: "text",
    text: responseText.slice(0, midpoint),
  });
  emitEvent("ContentPart", {
    type: "text",
    text: responseText.slice(midpoint),
  });
  emitEvent("TurnEnd", {});
}

const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const normalized = String(line || "").trim();
  if (!normalized) {
    return;
  }

  let message;
  try {
    message = JSON.parse(normalized);
  } catch {
    return;
  }

  if (message?.method === "initialize") {
    respond(message.id, {
      protocol_version: "1.5",
      server: {
        name: "Fake Kimi Wire",
        version: "1.0.0",
      },
      capabilities: {
        supports_question: true,
      },
      session: {
        id: sessionId,
        work_dir: workDir,
        model,
      },
    });
    return;
  }

  if (message?.method === "prompt") {
    const promptText = extractPromptText(message?.params?.user_input);
    if (promptText.includes("[auth-error]")) {
      respondError(message.id, "LLM is not set");
      return;
    }
    if (promptText.includes("[question]")) {
      pendingQuestion = {
        promptRequestId: message.id,
      };
      emitRequest(`question-${turnCounter + 1}`, "QuestionRequest", {
        id: `question-${turnCounter + 1}`,
        tool_call_id: `tool-question-${turnCounter + 1}`,
        questions: [
          {
            question: "Pick a language",
            header: "Lang",
            options: [
              { label: "TypeScript", description: "Use TS" },
              { label: "Python", description: "Use Python" },
            ],
          },
        ],
      });
      return;
    }
    emitStandardTurn(promptText);
    respond(message.id, {
      status: "finished",
    });
    return;
  }

  if (message?.method === "cancel") {
    respond(message.id, {});
    if (pendingQuestion) {
      respond(pendingQuestion.promptRequestId, {
        status: "cancelled",
      });
      pendingQuestion = null;
    }
    return;
  }

  if (pendingQuestion && message?.id === `question-${turnCounter + 1}`) {
    respond(pendingQuestion.promptRequestId, {
      status: "finished",
    });
    pendingQuestion = null;
    return;
  }
});
