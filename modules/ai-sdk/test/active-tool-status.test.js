import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createAiSession } from "../src/index.js";
import { resetExternalProviderRegistryForTests } from "../src/external-provider-registry.js";
import { CodexAppServerSession } from "../src/providers/codex-app-server-session.js";
import { CopilotSdkSession } from "../src/providers/copilot-sdk-session.js";
import { DshSdkSession } from "../src/providers/dsh-sdk-session.js";
import { KimiCliSession } from "../src/providers/kimi-cli-session.js";
import { OpencodeSdkSession } from "../src/providers/opencode-sdk-session.js";
import { ClaudeAgentSdkSession } from "../src/session-factory.js";
import { describeCodexToolItem, noteToolFinished, noteToolStarted, withActiveTool } from "../src/shared.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FAKE_EXTERNAL_PROVIDER = path.resolve(__dirname, "..", "fixtures", "fake-external-provider.js");
const logger = { log: () => {} };

function activeTool(session) {
  return session.getCurrentTurnStatus()?.active_tool;
}

afterEach(() => {
  delete process.env.AISDK_PROVIDER_PATH;
  resetExternalProviderRegistryForTests();
});

describe("active tool tracking", () => {
  it("reports the latest unfinished tool with a one-line input summary", () => {
    const turn = {};
    noteToolStarted(turn, "a", "Read", { file_path: "/tmp/a.txt" });
    noteToolStarted(turn, "b", "Bash", '{"command":"pnpm   test\\n--run","timeout":600}');
    const status = withActiveTool({ reply_in_progress: true }, turn);
    assert.equal(status.active_tool.name, "Bash");
    assert.equal(status.active_tool.summary, "pnpm test --run");
    assert.ok(Date.parse(status.active_tool.started_at));

    noteToolFinished(turn, "b");
    assert.equal(withActiveTool({}, turn).active_tool.name, "Read");
    noteToolFinished(turn, "a");
    assert.equal(withActiveTool({}, turn).active_tool, undefined);
    assert.equal(withActiveTool(null, turn), null);
  });

  it("describes codex app-server and exec tool items", () => {
    assert.deepEqual(describeCodexToolItem({ type: "commandExecution", command: "cargo build" }), {
      name: "command",
      input: "cargo build",
    });
    assert.deepEqual(describeCodexToolItem({ type: "mcp_tool_call", server: "gh", tool: "search", arguments: { query: "x" } }), {
      name: "gh.search",
      input: { query: "x" },
    });
    assert.equal(describeCodexToolItem({ type: "agentMessage", text: "hi" }), null);
  });

  it("claude: tracks tool_use until its tool_result arrives", async () => {
    const seen = [];
    const session = new ClaudeAgentSdkSession("claude", {
      cwd: process.cwd(),
      logger,
      sdkModule: {
        query: () => ({
          async *[Symbol.asyncIterator]() {
            yield {
              type: "assistant",
              session_id: "s1",
              message: { content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "sleep 600" } }] },
            };
            // Shape observed from the real SDK for a long Bash call.
            yield {
              type: "tool_progress",
              tool_use_id: "tu1-heartbeat-0",
              tool_name: "Bash",
              parent_tool_use_id: "tu1",
              elapsed_time_seconds: 30,
              heartbeat: true,
            };
            seen.push(activeTool(session));
            seen.push(session.currentTurn.activeTools.size);
            yield { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] } };
            seen.push(activeTool(session));
            yield { type: "result", subtype: "success", session_id: "s1", result: "done" };
          },
          close: () => {},
        }),
      },
    });

    await session.runTurn("hello");

    assert.equal(seen[0]?.name, "Bash");
    assert.equal(seen[0]?.summary, "sleep 600");
    assert.equal(seen[1], 1, "heartbeats must not register extra tools");
    assert.equal(seen[2], undefined);
    await session.close();
  });

  it("codex app-server: tracks item/started until item/completed", async () => {
    const session = new CodexAppServerSession("codex", { cwd: process.cwd(), logger });
    session.currentTurn = { turnId: "", fullText: "", activeAssistantMessageId: "", resolve: () => {}, reject: () => {} };

    await session.handleNotification("item/started", { item: { type: "commandExecution", id: "i1", command: "pnpm test" } });
    assert.deepEqual(
      { name: activeTool(session)?.name, summary: activeTool(session)?.summary },
      { name: "command", summary: "pnpm test" },
    );

    await session.handleNotification("item/completed", { item: { type: "commandExecution", id: "i1", command: "pnpm test" } });
    assert.equal(activeTool(session), undefined);
  });

  it("copilot: tracks tool.execution_start until tool.execution_complete", async () => {
    const session = new CopilotSdkSession("copilot", { cwd: process.cwd(), logger });
    session.currentTurn = { items: [], events: [], onProgress: null };

    await session.handleCopilotEvent({
      type: "tool.execution_start",
      data: { toolCallId: "c1", toolName: "bash", arguments: { command: "make build" } },
    });
    assert.equal(activeTool(session)?.summary, "make build");

    await session.handleCopilotEvent({ type: "tool.execution_complete", data: { toolCallId: "c1", result: {} } });
    assert.equal(activeTool(session), undefined);
  });

  it("opencode: tracks running tool parts until completed", async () => {
    const session = new OpencodeSdkSession("opencode", { cwd: process.cwd(), logger });
    const currentTurn = { assistantMessages: new Map(), assistantMessageOrder: [], activeAssistantMessageId: "" };
    session.currentTurn = currentTurn;
    const part = { id: "p1", callID: "call-1", messageID: "m1", type: "tool", tool: "bash" };

    await session.processAssistantPartUpdated(currentTurn, { ...part, state: { status: "running", input: { command: "npm ci" } } });
    assert.equal(activeTool(session)?.summary, "npm ci");

    await session.processAssistantPartUpdated(currentTurn, { ...part, state: { status: "completed", output: "ok" } });
    assert.equal(activeTool(session), undefined);
  });

  it("kimi wire: tracks ToolCall until ToolResult", async () => {
    const session = new KimiCliSession("kimi", { cwd: process.cwd(), logger });
    session.currentTurn = { items: [], toolCalls: new Map(), onProgress: null };

    await session.handleWireEvent("ToolCall", { id: "k1", function: { name: "Shell", arguments: '{"command":"ls -la"}' } });
    assert.equal(activeTool(session)?.summary, "ls -la");

    await session.handleWireEvent("ToolResult", { tool_call_id: "k1", return_value: { output: "ok" } });
    assert.equal(activeTool(session), undefined);
  });

  it("dsh: tracks tool/call until tool/result", async () => {
    const session = new DshSdkSession("dsh", { cwd: process.cwd(), logger });
    const currentTurn = { items: [] };
    session.currentTurn = currentTurn;
    const notify = (event) =>
      session.handleNotification(
        { method: "session.event", params: { sessionId: session.sessionId, event } },
        currentTurn,
        { onProgress: null },
      );

    await notify({ type: "tool/call", data: { callId: "d1", name: "bash", arguments: '{"command":"du -sh ."}' } });
    assert.equal(activeTool(session)?.summary, "du -sh .");

    await notify({ type: "tool/result", data: { message: { content: [{ type: "tool-result", toolCallId: "d1" }] } } });
    assert.equal(activeTool(session), undefined);
  });

  it("worker sessions answer turn status and usage queries while runTurn is in flight", async () => {
    process.env.AISDK_PROVIDER_PATH = FAKE_EXTERNAL_PROVIDER;
    resetExternalProviderRegistryForTests();
    const session = createAiSession("test-external", { cwd: process.cwd(), logger });
    await session.readyPromise;
    const turn = session.runTurn("[wait-for-interrupt] long tool").catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 100));

    const withinOneSecond = (promise) =>
      Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("blocked behind runTurn")), 1000))]);
    const status = await withinOneSecond(session.fetchCurrentTurnStatus());
    assert.equal(status.active_tool.name, "Bash");
    assert.equal(session.getCurrentTurnStatus().active_tool.summary, "sleep 600");
    assert.ok(await withinOneSecond(session.getSessionUsageSummary()));

    await session.interruptCurrentTurn();
    await turn;
    await session.close();
  });
});
