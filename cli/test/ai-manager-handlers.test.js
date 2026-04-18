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
