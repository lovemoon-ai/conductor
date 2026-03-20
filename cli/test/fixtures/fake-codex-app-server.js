#!/usr/bin/env node

import readline from "node:readline";

let nextThreadId = 1;
let nextTurnId = 1;

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function response(id, result) {
  send({
    jsonrpc: "2.0",
    id,
    result,
  });
}

function notification(method, params) {
  send({
    jsonrpc: "2.0",
    method,
    params,
  });
}

function extractPromptText(params = {}) {
  const input = Array.isArray(params.input) ? params.input : [];
  return input
    .map((entry) => (entry && typeof entry === "object" && typeof entry.text === "string" ? entry.text : ""))
    .join("\n")
    .trim();
}

function startThread(id, params = {}) {
  const threadId = params.threadId || `thread-fake-${nextThreadId++}`;
  const threadPath = `/tmp/${threadId}.jsonl`;
  response(id, {
    thread: {
      id: threadId,
      path: threadPath,
      cwd: params.cwd || process.cwd(),
      processCwd: process.cwd(),
      pwdEnv: process.env.PWD || "",
      source: "fake-codex-app-server",
    },
  });
  notification("thread/started", {
    thread: {
      id: threadId,
      path: threadPath,
      cwd: params.cwd || process.cwd(),
      processCwd: process.cwd(),
      pwdEnv: process.env.PWD || "",
      source: "fake-codex-app-server",
    },
  });
  notification("sessionConfigured", {
    session_id: `${threadId}-native`,
    rollout_path: threadPath,
  });
}

function startTurn(id, params = {}) {
  const turnId = `turn-fake-${nextTurnId++}`;
  const promptText = extractPromptText(params);
  const useMultiMessageScenario = promptText.includes("[multi-message]");
  const primaryMessageId = `msg-${turnId}-1`;
  const secondaryMessageId = `msg-${turnId}-2`;
  response(id, {
    turn: {
      id: turnId,
      status: "started",
    },
  });
  setTimeout(() => {
    notification("turn/started", {
      threadId: params.threadId,
      turn: {
        id: turnId,
        status: "inProgress",
      },
    });
  }, 5);
  setTimeout(() => {
    notification("item/started", {
      threadId: params.threadId,
      turnId,
      item: {
        reasoning: {
          type: "summary",
        },
      },
    });
  }, 10);
  setTimeout(() => {
    notification("item/started", {
      threadId: params.threadId,
      turnId,
      item: {
        type: "function_call",
        name: "update_plan",
      },
    });
  }, 12);
  setTimeout(() => {
    notification("item/started", {
      threadId: params.threadId,
      turnId,
      item: {
        type: "mystery_item",
      },
    });
  }, 13);
  setTimeout(() => {
    notification("item/started", {
      threadId: params.threadId,
      turnId,
      item: {
        type: "message",
        role: "assistant",
        id: primaryMessageId,
      },
    });
  }, 14);
  setTimeout(() => {
    notification("item/agentMessage/delta", {
      threadId: params.threadId,
      turnId,
      itemId: primaryMessageId,
      delta: useMultiMessageScenario ? "开始计时 2 分钟。" : "OK ",
    });
  }, 15);
  setTimeout(() => {
    notification("item/commandExecution/outputDelta", {
      threadId: params.threadId,
      turnId,
      itemId: `cmd-${turnId}`,
      delta: "ls\n",
    });
  }, 20);
  setTimeout(() => {
    if (!useMultiMessageScenario) {
      notification("item/agentMessage/delta", {
        threadId: params.threadId,
        turnId,
        itemId: primaryMessageId,
        delta: "from ",
      });
    }
  }, 25);
  setTimeout(() => {
    if (!useMultiMessageScenario) {
      notification("item/agentMessage/delta", {
        threadId: params.threadId,
        turnId,
        itemId: primaryMessageId,
        delta: "fake codex",
      });
    }
  }, 30);
  setTimeout(() => {
    if (!useMultiMessageScenario) {
      notification("item/agentMessage/delta", {
        threadId: params.threadId,
        turnId,
        itemId: primaryMessageId,
        delta: "\n",
      });
    }
  }, 35);
  setTimeout(() => {
    notification("item/completed", {
      threadId: params.threadId,
      turnId,
      item: {
        type: "message",
        role: "assistant",
        id: primaryMessageId,
      },
    });
  }, 36);
  setTimeout(() => {
    if (!useMultiMessageScenario) {
      return;
    }
    notification("item/started", {
      threadId: params.threadId,
      turnId,
      item: {
        type: "message",
        role: "assistant",
        id: secondaryMessageId,
      },
    });
  }, 38);
  setTimeout(() => {
    if (!useMultiMessageScenario) {
      return;
    }
    notification("item/agentMessage/delta", {
      threadId: params.threadId,
      turnId,
      itemId: secondaryMessageId,
      delta: "完成",
    });
  }, 40);
  setTimeout(() => {
    if (!useMultiMessageScenario) {
      return;
    }
    notification("item/completed", {
      threadId: params.threadId,
      turnId,
      item: {
        type: "message",
        role: "assistant",
        id: secondaryMessageId,
      },
    });
  }, 42);
  setTimeout(() => {
    notification("thread/tokenUsage/updated", {
      threadId: params.threadId,
      turnId,
      tokenUsage: {
        last: {
          cachedInputTokens: 5,
          inputTokens: 20,
          outputTokens: 30,
          reasoningOutputTokens: 10,
          totalTokens: 60,
        },
        total: {
          cachedInputTokens: 5,
          inputTokens: 30,
          outputTokens: 40,
          reasoningOutputTokens: 20,
          totalTokens: 90,
        },
        modelContextWindow: 180,
      },
    });
  }, 40);
  setTimeout(() => {
    notification("account/rateLimits/updated", {
      rateLimits: {
        primary: {
          usedPercent: 23,
        },
      },
    });
  }, 45);
  setTimeout(() => {
    notification("turn/completed", {
      threadId: params.threadId,
      turn: {
        id: turnId,
        status: "completed",
        error: null,
      },
    });
  }, 55);
}

const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const normalized = String(line || "").trim();
  if (!normalized) {
    return;
  }
  const message = JSON.parse(normalized);
  if (message.method === "initialize") {
    response(message.id, {
      userAgent: "fake-codex-app-server/1.0.0",
    });
    return;
  }
  if (message.method === "initialized") {
    return;
  }
  if (message.method === "thread/start") {
    startThread(message.id, message.params);
    return;
  }
  if (message.method === "thread/resume") {
    startThread(message.id, message.params);
    return;
  }
  if (message.method === "turn/start") {
    startTurn(message.id, message.params);
    return;
  }
  if (message.method === "turn/interrupt") {
    response(message.id, {
      ok: true,
    });
    return;
  }
  response(message.id, {
    ok: true,
  });
});
