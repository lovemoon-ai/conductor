import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { ChatRuntimeClient } from "../src/runtime/client.js";
import { startRuntimeServer } from "../src/runtime/server.js";
import { runRuntimeCli } from "../src/runtime/cli.js";
import { RuntimeError, type ChatWorker, type SiteDefinition, type WorkerConfig, type WorkerNotice, type WorkerResult } from "../src/runtime/types.js";

const sites: SiteDefinition[] = ["chatgpt", "deepseek", "kimi", "claude"].map((name) => ({
  name, homeUrl: "https://fixture.local/", input: "textarea", send: "button",
  assistant: "article", stop: ".stop", conversationPath: "/chat/(.+)", streamPath: "/stream", format: "text",
}));
const servers: Awaited<ReturnType<typeof startRuntimeServer>>[] = [];
const directories: string[] = [];
async function until(test: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 150; i++) { if (await test()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error("Condition did not become true");
}
function monitor() {
  const calls: { id: string; input: string; profile: string; provider: string }[] = [];
  const pending = new Map<string, { resolve: (value: WorkerResult) => void; reject: (error: Error) => void; notify: (notice: WorkerNotice) => void; config: WorkerConfig }>();
  const closed: string[] = [];
  return {
    calls, pending, closed,
    factory: (config: WorkerConfig): ChatWorker => ({
      async open() { return { ready: true, url: "https://fixture.local/chat/" + config.conversation.id }; },
      async send(input: string, _timeout: number, notify: (notice: WorkerNotice) => void) {
        calls.push({ id: config.conversation.id, input, profile: config.profileDir, provider: config.site.name });
        notify({ type: "submitting" });
        notify({ type: "progress", text: "first:" + input });
        return new Promise<WorkerResult>((resolve, reject) => pending.set(input, { resolve, reject, notify, config }));
      },
      cancel() {
        for (const [input, call] of pending) if (call.config.conversation.id === config.conversation.id) {
          pending.delete(input);
          call.reject(Object.assign(new RuntimeError("CANCELLED", "Stopped"), { stopConfirmed: true }));
        }
      },
      async close() {
        closed.push(config.conversation.id);
        for (const [input, call] of pending) if (call.config.conversation.id === config.conversation.id) {
          pending.delete(input); call.reject(new RuntimeError("WORKER_EXITED", "Worker exited"));
        }
      },
    }),
    release(input: string, text = "answer:" + input) {
      const call = pending.get(input);
      if (!call) throw new Error("No pending call " + input);
      pending.delete(input);
      call.notify({ type: "progress", text });
      call.resolve({ text, url: "https://fixture.local/chat/" + call.config.conversation.id, providerConversationId: call.config.conversation.id });
    },
  };
}
async function start(m = monitor(), directory?: string, maxWorkers = 4) {
  directory ??= await fs.mkdtemp(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "cw-runtime-"));
  if (!directories.includes(directory)) directories.push(directory);
  const server = await startRuntimeServer({ directory, sites, maxWorkers, perAccountConcurrency: 2, workerFactory: m.factory });
  servers.push(server);
  return { server, client: new ChatRuntimeClient(server.socketPath), m, directory };
}
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

describe("isolated runtime RPC and SDK", () => {
  it("runs same-provider and cross-provider conversations concurrently with distinct profiles", async () => {
    const { client, m } = await start();
    const chats = await Promise.all(["chatgpt", "chatgpt", "deepseek"].map((provider) => client.create({ provider })));
    const turns = await Promise.all(chats.map((chat, i) => client.submit({ conversationId: chat.id, requestId: "r" + i, input: "p" + i })));
    await until(() => m.calls.length === 3);
    expect(new Set(m.calls.map((call) => call.profile)).size).toBe(3);
    for (let i = 0; i < 3; i++) m.release("p" + i);
    const results = await Promise.all(turns.map((turn) => client.wait(turn.id)));
    expect(results.map((turn) => turn.text)).toEqual(["answer:p0", "answer:p1", "answer:p2"]);
    expect(results.every((turn) => turn.status === "completed")).toBe(true);
  });

  it("serializes one conversation, deduplicates concurrent requestIds and rejects conflicts", async () => {
    const { client, m } = await start();
    const chat = await client.create({ provider: "chatgpt" });
    const [first, duplicate] = await Promise.all([1, 2].map(() => client.submit({ conversationId: chat.id, requestId: "same", input: "one" })));
    expect(first.id).toBe(duplicate.id);
    await expect(client.submit({ conversationId: chat.id, requestId: "same", input: "different" })).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
    const second = await client.submit({ conversationId: chat.id, requestId: "second", input: "two" });
    await until(() => m.calls.length === 1);
    expect(m.calls[0]!.input).toBe("one");
    m.release("one");
    await until(() => m.calls.length === 2);
    m.release("two");
    expect((await client.wait(second.id)).text).toBe("answer:two");
  });

  it("cancels queued and active turns without stopping an unrelated conversation", async () => {
    const { client, m } = await start();
    const a = await client.create({ provider: "chatgpt" });
    const b = await client.create({ provider: "deepseek" });
    const one = await client.submit({ conversationId: a.id, input: "cancel-me", requestId: "one" });
    const queued = await client.submit({ conversationId: a.id, input: "never-send", requestId: "two" });
    const other = await client.submit({ conversationId: b.id, input: "keep-running", requestId: "one" });
    await until(() => m.calls.length === 2);
    expect((await client.cancel(queued.id)).status).toBe("cancelled");
    await client.cancel(one.id);
    expect((await client.wait(one.id)).status).toBe("cancelled");
    expect(m.pending.has("keep-running")).toBe(true);
    m.release("keep-running");
    expect((await client.wait(other.id)).status).toBe("completed");
    expect(m.calls.some((call) => call.input === "never-send")).toBe(false);
  });

  it("replays events after a cursor and leaves generation running when the subscriber disconnects", async () => {
    const { client, m } = await start();
    const chat = await client.create({ provider: "claude" });
    const turn = await client.submit({ conversationId: chat.id, input: "stream", requestId: "one" });
    let last = 0;
    for await (const event of client.events(turn.id)) {
      last = event.seq;
      if (event.type === "message_delta") break;
    }
    expect(m.pending.has("stream")).toBe(true);
    m.release("stream");
    const replay = [];
    for await (const event of client.events(turn.id, last)) replay.push(event);
    expect(replay.every((event) => event.seq > last)).toBe(true);
    expect(replay.at(-1)!.type).toBe("completed");
  });

  it("recovers interrupted turns as uncertain and never resubmits them automatically", async () => {
    const first = await start();
    const chat = await first.client.create({ provider: "kimi" });
    const turn = await first.client.submit({ conversationId: chat.id, input: "interrupted", requestId: "one" });
    await until(async () => (await first.client.getTurn(turn.id)).status === "streaming");
    await first.server.close();
    const next = await start(monitor(), first.directory);
    expect((await next.client.getTurn(turn.id)).status).toBe("uncertain");
    expect(next.m.calls).toHaveLength(0);
    expect((await next.client.submit({ conversationId: chat.id, input: "interrupted", requestId: "one" })).id).toBe(turn.id);
    await expect(next.client.submit({ conversationId: chat.id, input: "new", requestId: "two" })).rejects.toMatchObject({ code: "REVIEW_REQUIRED" });
    await next.client.resume(chat.id, { acknowledgeUncertain: true });
    const fresh = await next.client.submit({ conversationId: chat.id, input: "new", requestId: "two" });
    await until(() => next.m.pending.has("new"));
    next.m.release("new");
    expect((await next.client.wait(fresh.id)).status).toBe("completed");
  });

  it("does not let one account's queue block a different provider", async () => {
    const { client, m } = await start(monitor(), undefined, 3);
    const chats = await Promise.all(["chatgpt", "chatgpt", "chatgpt", "deepseek"].map((provider) => client.create({ provider })));
    const turns = await Promise.all(chats.map((chat, i) => client.submit({ conversationId: chat.id, input: "p" + i, requestId: "r" + i })));
    await until(() => m.calls.length === 3);
    expect(m.calls.map((call) => call.input)).toEqual(["p0", "p1", "p3"]);
    m.release("p0");
    await until(() => m.pending.has("p2"));
    for (const input of ["p1", "p2", "p3"]) m.release(input);
    expect((await Promise.all(turns.map((turn) => client.wait(turn.id)))).every((turn) => turn.status === "completed")).toBe(true);
  });

  it("exposes lifecycle and JSONL commands through the CLI client", async () => {
    const { server, client, m } = await start();
    const output: string[] = [];
    const run = (args: string[]) => runRuntimeCli([...args, "--socket", server.socketPath], (line) => output.push(line));
    await run(["chat", "create", "deepseek", "--account", "personal"]);
    const chat = JSON.parse(output.pop()!);
    await run(["chat", "send", chat.id, "hello", "--request-id", "cli-1", "--detach"]);
    const turn = JSON.parse(output.pop()!);
    await until(() => m.pending.has("hello"));
    m.release("hello");
    await client.wait(turn.id);
    await run(["turn", "events", turn.id, "--after", "1"]);
    const events = output.splice(0).map((line) => JSON.parse(line));
    expect(events.at(-1).type).toBe("completed");
    expect(events.every((event) => event.seq > 1)).toBe(true);
    await run(["chat", "close", chat.id]);
    expect(JSON.parse(output.pop()!).closed).toBe(true);
    await expect(run(["chat", "create", "unknown"])).rejects.toMatchObject({ code: "UNSUPPORTED_PROVIDER" });
  });

  it("rejects invalid RPC identifiers and protects an active state directory", async () => {
    const { directory, client } = await start();
    await expect(startRuntimeServer({ directory, sites })).rejects.toMatchObject({ code: "RUNTIME_LOCKED" });
    await expect(client.get("__proto__")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(client.call("unknown.method")).rejects.toMatchObject({ code: "METHOD_NOT_FOUND" });
    const chat = await client.create({ provider: "chatgpt" });
    await expect(client.submit({ conversationId: chat.id, input: "", requestId: "r" })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    if (process.platform !== "win32") expect((await fs.stat(path.join(directory, "runtime.sock"))).mode & 0o777).toBe(0o600);
  });
  it("streams large final events without losing the result to HTTP backpressure", async () => {
    const { client, m } = await start();
    const chat = await client.create({ provider: "chatgpt" });
    const turn = await client.submit({ conversationId: chat.id, input: "large", requestId: "one" });
    await until(() => m.pending.has("large"));
    const text = "你好".repeat(80_000);
    m.release("large", text);
    expect((await client.wait(turn.id)).text).toBe(text);
    const replay = [];
    for await (const event of client.events(turn.id)) replay.push(event);
    expect(replay.at(-1)!.text).toBe(text);
  });

  it("a failed worker leaves only its own chat uncertain", async () => {
    const { client, m } = await start();
    const chats = await Promise.all(["chatgpt", "deepseek"].map((provider) => client.create({ provider })));
    const turns = await Promise.all(chats.map((chat, i) => client.submit({ conversationId: chat.id, input: "p" + i, requestId: "one" })));
    await until(() => m.pending.size === 2);
    m.pending.get("p0")!.reject(new RuntimeError("WORKER_EXITED", "Simulated process failure"));
    m.pending.delete("p0");
    expect((await client.wait(turns[0]!.id)).status).toBe("uncertain");
    expect((await client.get(chats[1]!.id)).needsReview).toBe(false);
    m.release("p1");
    expect((await client.wait(turns[1]!.id)).status).toBe("completed");
  });

  it("startup reconciles an unclean checkpoint without replaying the submitted message", async () => {
    const first = await start();
    const chat = await first.client.create({ provider: "chatgpt" });
    const turn = await first.client.submit({ conversationId: chat.id, input: "durable", requestId: "one" });
    await until(async () => (await first.client.getTurn(turn.id)).status === "streaming");
    const directory = await fs.mkdtemp(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "cw-checkpoint-"));
    directories.push(directory);
    await fs.copyFile(path.join(first.directory, "state.json"), path.join(directory, "state.json"));
    const recovered = await start(monitor(), directory);
    expect((await recovered.client.getTurn(turn.id)).status).toBe("uncertain");
    expect((await recovered.client.get(chat.id)).needsReview).toBe(true);
    expect(recovered.m.calls).toHaveLength(0);
  });

  it("can cancel browser startup without waiting for the navigation timeout", async () => {
    const m = monitor();
    const factory = m.factory;
    let opening = false;
    let rejectOpen: ((error: Error) => void) | undefined;
    m.factory = (config) => {
      const worker = factory(config);
      if (config.site.name !== "chatgpt") return worker;
      return { ...worker,
        open: () => new Promise<WorkerResult>((_resolve, reject) => { opening = true; rejectOpen = reject; }),
        async close() { rejectOpen?.(new RuntimeError("WORKER_EXITED", "Startup stopped")); await worker.close(); },
      };
    };
    const { client } = await start(m, undefined, 1);
    const a = await client.create({ provider: "chatgpt" });
    const b = await client.create({ provider: "deepseek" });
    const first = await client.submit({ conversationId: a.id, input: "never", requestId: "one" });
    const second = await client.submit({ conversationId: b.id, input: "next", requestId: "one" });
    await until(() => opening);
    await client.cancel(first.id);
    expect((await client.wait(first.id)).status).toBe("cancelled");
    await until(() => m.pending.has("next"));
    m.release("next");
    expect((await client.wait(second.id)).status).toBe("completed");
    expect(m.calls.some((call) => call.input === "never")).toBe(false);
  });

  it("detaches an SDK waiter without cancelling the remote turn", async () => {
    const { client, m } = await start();
    const { RuntimeChatSession } = await import("../src/runtime/client.js");
    const chat = await client.create({ provider: "chatgpt" });
    const session = await RuntimeChatSession.open("chatgpt", { socketPath: client.socketPath, conversationId: chat.id });
    const sending = session.send("detach", { requestId: "one" });
    const rejected = expect(sending).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
    await until(() => m.pending.has("detach"));
    await session.close();
    await rejected;
    expect(m.pending.has("detach")).toBe(true);
    m.release("detach");
    const turn = await client.submit({ conversationId: chat.id, input: "detach", requestId: "one" });
    expect((await client.wait(turn.id)).status).toBe("completed");
  });

  it("does not evict a manual login window to run another chat", async () => {
    const { client, m } = await start(monitor(), undefined, 1);
    const a = await client.create({ provider: "chatgpt" });
    const b = await client.create({ provider: "deepseek" });
    await client.resume(a.id, { headed: true });
    const queued = await client.submit({ conversationId: b.id, input: "after-login", requestId: "one" });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(m.calls).toHaveLength(0);
    expect(m.closed).not.toContain(a.id);
    expect((await client.getTurn(queued.id)).status).toBe("queued");
    await client.closeConversation(a.id);
    await until(() => m.pending.has("after-login"));
    m.release("after-login");
    expect((await client.wait(queued.id)).status).toBe("completed");
  });

});
