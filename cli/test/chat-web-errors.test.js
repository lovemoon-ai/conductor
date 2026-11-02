import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAiSession } from "@love-moon/ai-sdk";
import { startRuntimeServer } from "../../modules/chat-web/dist/runtime/server.js";
import { ChatStreamDecoder } from "../../modules/chat-web/dist/runtime/stream-decoder.js";
import { RuntimeError } from "../../modules/chat-web/dist/runtime/types.js";
import { BridgeRunner } from "../bin/conductor-fire.js";

const fixtures = JSON.parse(await fs.readFile(new URL("../../modules/chat-web/tests/fixtures/provider-errors.json", import.meta.url), "utf8"));
describe("browser chat provider errors reach Conductor", () => {
  for (const provider of ["kimi", "deepseek"]) it("reports " + provider + " concurrency rejection through RPC, the AI worker and message bridge", async () => {
    const directory = await fs.mkdtemp(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "cw-errors-"));
    const originalConfig = process.env.CONDUCTOR_CONFIG;
    const config = path.join(directory, "config.yaml");
    await fs.writeFile(config, "allow_cli_list: {}\n");
    process.env.CONDUCTOR_CONFIG = config;
    let sent = 0;
    const server = await startRuntimeServer({ directory, workerFactory: () => ({
      async open() { return { ready: true }; },
      async send(_input, _timeout, notify) {
        sent++; notify({ type: "submitting" });
        const decoder = new ChatStreamDecoder(provider);
        if (provider === "kimi") {
          const body = Buffer.from(JSON.stringify(fixtures.kimi));
          const header = Buffer.alloc(5); header[0] = 2; header.writeUInt32BE(body.length, 1);
          decoder.pushConnect(Buffer.concat([header, body]));
        } else decoder.push("data: " + JSON.stringify(fixtures.deepseek) + "\n\n");
        throw new RuntimeError(decoder.errorCode, decoder.error);
      },
      cancel() {}, async close() {},
    }) });
    const session = createAiSession("chat-web", { model: provider, chatWebRuntimeSocket: server.socketPath, resumePersistedSession: false, cwd: directory });
    const messages = [], statuses = [];
    const runner = new BridgeRunner({
      backendSession: session, conductor: {
        receiveMessages: async () => ({ messages: [] }), ackMessages: async () => ({}),
        sendRuntimeStatus: async (_taskId, payload) => { statuses.push(payload); return {}; },
        sendMessage: async (_taskId, content, metadata) => { messages.push({ content, metadata }); return { id: "error-one", message_id: "error-one" }; },
      }, taskId: "chat-error-task", backendName: "web-" + provider, pollIntervalMs: 500, initialPrompt: "", includeInitialImages: false, cliArgs: [],
    });
    try {
      await runner.announceBackendSession();
      await runner.respondToMessage({ message_id: "user-one", role: "user", content: "hello" });
      const errors = messages.filter(message => message.metadata?.severity === "error");
      assert.equal(errors.length, 1);
      assert.match(errors[0].content, /账号同时生成的对话过多，请等待其他对话结束后重试/);
      assert.match(errors[0].content, new RegExp("^web-" + provider + " 处理失败: "));
      assert.equal(errors[0].metadata.severity, "error");
      assert.equal(errors[0].metadata.reply_to, "user-one");
      assert.ok(statuses.some(s => s.status_done_line?.includes("账号同时生成的对话过多")));
      assert.equal(runner.quotaWait, null);
      assert.equal(sent, 1);
      const state = JSON.parse(await fs.readFile(path.join(directory, "state.json"), "utf8"));
      assert.equal(Object.values(state.turns)[0].errorCode, "PROVIDER_CONCURRENCY_LIMIT");
      assert.equal(Object.values(state.turns)[0].status, "uncertain");
    } finally {
      runner.stopped = true; clearInterval(runner.runtimeHeartbeatTimer);
      await session.close(); await server.close();
      if (originalConfig === undefined) delete process.env.CONDUCTOR_CONFIG; else process.env.CONDUCTOR_CONFIG = originalConfig;
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
