import test from "node:test";
import assert from "node:assert/strict";
import { handleAiManagerRequest } from "../src/ai-manager-handlers.js";

function makeFakeClient() {
  const sent = [];
  return {
    sent,
    sendJson(payload) {
      sent.push(payload);
      return Promise.resolve();
    },
  };
}

function makeStubHandlers(impl) {
  return {
    dispatch: (payload) => Promise.resolve(impl(payload)),
  };
}

test("handleAiManagerRequest returns response with request_id and result", async () => {
  const client = makeFakeClient();
  const handlers = makeStubHandlers((p) => {
    assert.equal(p.action, "status");
    return { result: { ok: true } };
  });
  const out = await handleAiManagerRequest(client, handlers, {
    request_id: "req-1",
    action: "status",
    args: {},
  });
  assert.deepEqual(out, { result: { ok: true } });
  assert.equal(client.sent.length, 1);
  assert.equal(client.sent[0].type, "ai_manager_response");
  assert.equal(client.sent[0].payload.request_id, "req-1");
  assert.equal(client.sent[0].payload.action, "status");
  assert.deepEqual(client.sent[0].payload.result, { ok: true });
  assert.equal(client.sent[0].payload.error, undefined);
});

test("handleAiManagerRequest forwards error string from dispatch", async () => {
  const client = makeFakeClient();
  const handlers = makeStubHandlers(() => ({ error: "boom" }));
  await handleAiManagerRequest(client, handlers, {
    request_id: "req-2",
    action: "quota",
  });
  assert.equal(client.sent[0].payload.error, "boom");
  assert.equal(client.sent[0].payload.result, undefined);
});

test("handleAiManagerRequest drops request when request_id missing", async () => {
  const client = makeFakeClient();
  const handlers = makeStubHandlers(() => ({ result: {} }));
  const out = await handleAiManagerRequest(client, handlers, {
    action: "status",
  });
  assert.equal(client.sent.length, 0);
  assert.equal(out.error, "missing request_id");
});

test("handleAiManagerRequest catches unknown action upstream of dispatch", async () => {
  // Use the real createAiManagerHandlers to ensure validation happens there.
  const client = makeFakeClient();
  const { createAiManagerHandlers } = await import("../src/ai-manager-handlers.js");
  const handlers = createAiManagerHandlers({ configPath: "/nonexistent/config.yaml" });
  await handleAiManagerRequest(client, handlers, {
    request_id: "req-3",
    action: "no_such_action",
  });
  assert.equal(client.sent.length, 1);
  assert.match(client.sent[0].payload.error, /unknown action/);
});

test("dispatch list_accounts returns empty list when config is missing", async () => {
  const client = makeFakeClient();
  const { createAiManagerHandlers } = await import("../src/ai-manager-handlers.js");
  const handlers = createAiManagerHandlers({ configPath: "/nonexistent/config.yaml" });
  await handleAiManagerRequest(client, handlers, {
    request_id: "req-list",
    action: "list_accounts",
  });
  assert.equal(client.sent.length, 1);
  assert.equal(client.sent[0].payload.error, undefined);
  assert.deepEqual(client.sent[0].payload.result, { accounts: [] });
});

test("dispatch switch_account surfaces error when name not in config", async () => {
  const client = makeFakeClient();
  const { createAiManagerHandlers } = await import("../src/ai-manager-handlers.js");
  const handlers = createAiManagerHandlers({ configPath: "/nonexistent/config.yaml" });
  await handleAiManagerRequest(client, handlers, {
    request_id: "req-switch",
    action: "switch_account",
    args: { name: "ghost-account" },
  });
  assert.equal(client.sent.length, 1);
  assert.match(client.sent[0].payload.error, /not found/);
  assert.equal(client.sent[0].payload.result, undefined);
});

test("dispatch switch_account rejects missing name argument", async () => {
  const client = makeFakeClient();
  const { createAiManagerHandlers } = await import("../src/ai-manager-handlers.js");
  const handlers = createAiManagerHandlers({ configPath: "/nonexistent/config.yaml" });
  await handleAiManagerRequest(client, handlers, {
    request_id: "req-switch-empty",
    action: "switch_account",
    args: {},
  });
  assert.equal(client.sent.length, 1);
  assert.match(client.sent[0].payload.error, /requires a `name`/);
});

test("dispatch quota includes copilot but not external providers by default", async () => {
  const { createAiManagerHandlers } = await import("../src/ai-manager-handlers.js");
  const handlers = createAiManagerHandlers({ configPath: "/nonexistent/config.yaml" });
  handlers.manager.getCodexQuota = async () => ({ tool: "codex", source: "fresh" });
  handlers.manager.getClaudeQuota = async () => ({ tool: "claude", source: "fresh" });
  handlers.manager.getKimiQuota = async () => ({ tool: "kimi", source: "fresh" });
  handlers.manager.getCopilotQuota = async () => ({ tool: "copilot", source: "fresh" });
  handlers.manager.getExternalQuotaList = async () => {
    throw new Error("external provider should not be called by default");
  };

  const out = await handlers.dispatch({ action: "quota", args: {} });
  assert.deepEqual(Object.keys(out.result).sort(), ["claude", "codex", "copilot", "kimi"]);
  assert.equal(out.result.copilot.tool, "copilot");
});

test("dispatch quota probes selected providers concurrently", async () => {
  const { createAiManagerHandlers } = await import("../src/ai-manager-handlers.js");
  const handlers = createAiManagerHandlers({ configPath: "/nonexistent/config.yaml" });
  let active = 0;
  let maxActive = 0;
  const probe = (tool) => async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await Promise.resolve();
    active -= 1;
    return { tool, source: "fresh" };
  };
  handlers.manager.getCodexQuota = probe("codex");
  handlers.manager.getClaudeQuota = probe("claude");
  handlers.manager.getKimiQuota = probe("kimi");
  handlers.manager.getCopilotQuota = probe("copilot");

  const out = await handlers.dispatch({ action: "quota", args: {} });

  assert.deepEqual(Object.keys(out.result).sort(), ["claude", "codex", "copilot", "kimi"]);
  assert.ok(maxActive > 1, "quota probes should overlap instead of running serially");
});

test("dispatch quota includes external providers when requested", async () => {
  const { createAiManagerHandlers } = await import("../src/ai-manager-handlers.js");
  const handlers = createAiManagerHandlers({ configPath: "/nonexistent/config.yaml" });
  handlers.manager.getCodexQuota = async () => ({ tool: "codex", source: "fresh" });
  handlers.manager.getClaudeQuota = async () => ({ tool: "claude", source: "fresh" });
  handlers.manager.getKimiQuota = async () => ({ tool: "kimi", source: "fresh" });
  handlers.manager.getCopilotQuota = async () => ({ tool: "copilot", source: "fresh" });
  handlers.manager.getExternalQuotaList = async ({ backend }) => ({
    backend,
    source: "fresh",
    count: 1,
    quotas: [],
  });

  const out = await handlers.dispatch({
    action: "quota",
    args: { externalQuotaBackends: ["private-ext"] },
  });

  assert.deepEqual(Object.keys(out.result).sort(), ["claude", "codex", "copilot", "external", "kimi"]);
  assert.equal(out.result.external["private-ext"].backend, "private-ext");
});

test("dispatch quota can filter to an external provider only", async () => {
  const { createAiManagerHandlers } = await import("../src/ai-manager-handlers.js");
  const handlers = createAiManagerHandlers({ configPath: "/nonexistent/config.yaml" });
  let externalCalls = 0;
  handlers.manager.getCodexQuota = async () => {
    throw new Error("codex should not be called");
  };
  handlers.manager.getClaudeQuota = async () => {
    throw new Error("claude should not be called");
  };
  handlers.manager.getKimiQuota = async () => {
    throw new Error("kimi should not be called");
  };
  handlers.manager.getCopilotQuota = async () => {
    throw new Error("copilot should not be called");
  };
  handlers.manager.getExternalQuotaList = async ({ backend }) => {
    externalCalls += 1;
    return { backend, source: "fresh", count: 0, quotas: [] };
  };

  const out = await handlers.dispatch({ action: "quota", args: { tool: "private-ext" } });
  assert.deepEqual(out.result, {
    external: {
      "private-ext": { backend: "private-ext", source: "fresh", count: 0, quotas: [] },
    },
  });
  assert.equal(externalCalls, 1);
});

test("dispatch quota can filter to copilot only", async () => {
  const { createAiManagerHandlers } = await import("../src/ai-manager-handlers.js");
  const handlers = createAiManagerHandlers({ configPath: "/nonexistent/config.yaml" });
  let copilotCalls = 0;
  handlers.manager.getCodexQuota = async () => {
    throw new Error("codex should not be called");
  };
  handlers.manager.getClaudeQuota = async () => {
    throw new Error("claude should not be called");
  };
  handlers.manager.getKimiQuota = async () => {
    throw new Error("kimi should not be called");
  };
  handlers.manager.getCopilotQuota = async () => {
    copilotCalls += 1;
    return { tool: "copilot", source: "fresh" };
  };

  const out = await handlers.dispatch({ action: "quota", args: { tool: "copilot" } });
  assert.deepEqual(out.result, { copilot: { tool: "copilot", source: "fresh" } });
  assert.equal(copilotCalls, 1);
});
