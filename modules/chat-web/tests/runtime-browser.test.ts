import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { chromium } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import { startRuntimeServer } from "../src/runtime/server.js";
import { ChatRuntimeClient } from "../src/runtime/client.js";
import { runtimeSites } from "../src/runtime/sites.js";

const executable = process.env.CHAT_WEB_TEST_BROWSER ?? chromium.executablePath();
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function fixtureHtml(provider: string): string {
  const input = provider === "deepseek" ? "<textarea></textarea>" :
    '<div id="prompt-textarea" class="chat-input-editor ProseMirror" role="textbox" contenteditable="true"></div>';
  const assistant = provider === "chatgpt" ? '<div data-message-author-role="assistant"></div>' :
    provider === "deepseek" ? '<div class="ds-markdown"></div>' :
    provider === "kimi" ? '<div class="segment-assistant"><div class="markdown"></div></div>' :
    '<div class="font-claude-message"></div>';
  const route = provider === "chatgpt" ? "/c/" : provider === "deepseek" ? "/a/chat/s/" : "/chat/";
  const endpoint = provider === "chatgpt" ? "/backend-api/conversation" : provider === "deepseek" ? "/api/v0/chat/completion" :
    provider === "kimi" ? "/api/chat/thread/completion/stream" : "/api/organizations/org/chat_conversations/thread/completion";
  return `<!doctype html><html><body>${input}
    <button id="composer-submit-button" data-testid="send-button" aria-label="Send message">Send</button>
    <button class="stop-button" data-testid="stop-button" aria-label="Stop generating" hidden>Stop</button>
    <main></main><script>
    let controller;
    const composer = document.querySelector('textarea, [contenteditable]');
    const stop = document.querySelector('.stop-button');
    if (${JSON.stringify(provider)} === "claude") { composer.hidden = true; setTimeout(() => { composer.hidden = false; }, 350); }
    stop.onclick = () => { controller?.abort(); stop.hidden = true; };
    document.querySelector('#composer-submit-button').onclick = async () => {
      const message = composer.value ?? composer.innerText;
      const id = localStorage.getItem('chatId') || crypto.randomUUID();
      localStorage.setItem('chatId', id);
      const turn = Number(localStorage.getItem('turn') || 0) + 1;
      localStorage.setItem('turn', String(turn));
      document.cookie = 'chatId=' + id + '; path=/; max-age=3600';
      history.replaceState({}, '', ${JSON.stringify(route)} + id + '?provider=' + ${JSON.stringify(provider)});
      document.querySelector('main').insertAdjacentHTML('beforeend', ${JSON.stringify(assistant)});
      controller = new AbortController(); stop.hidden = false;
      try {
        const response = await fetch(${JSON.stringify(endpoint)}, { method: 'POST', body: JSON.stringify({message, id, turn, provider: ${JSON.stringify(provider)}}), signal: controller.signal });
        const reader = response.body.getReader(); while (!(await reader.read()).done) {}
      } catch {} finally { stop.hidden = true; }
    };
    </script></body></html>`;
}

async function startFixture() {
  const requests: { provider: string; message: string; id: string; turn: number }[] = [];
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url!, "http://localhost");
    if (request.method !== "POST") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(fixtureHtml(url.searchParams.get("provider") ?? url.pathname.split("/")[1] ?? "chatgpt"));
      return;
    }
    request.setEncoding("utf8");
    let body = "";
    for await (const chunk of request) body += chunk;
    const data = JSON.parse(body);
    requests.push(data);
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    response.flushHeaders();
    const answer = "你好:" + data.message + ":" + data.id + ":" + data.turn;
    let index = 0;
    const timer = setInterval(() => {
      const text = index === 0 ? answer.slice(0, 3) : answer.slice(3);
      let frame: unknown;
      if (data.provider === "chatgpt") frame = { message: { id: "m1", author: { role: "assistant" }, content: { parts: [index === 0 ? text : answer] }, status: "in_progress" } };
      else if (data.provider === "deepseek") frame = index === 0 ? { response: { fragments: [{ id: 0, type: "RESPONSE", content: text }] } } : { p: "response/fragments/0/content", o: "APPEND", v: text };
      else if (data.provider === "kimi") frame = { event: "cmpl", text };
      else frame = { type: "content_block_delta", delta: { type: "text_delta", text } };
      response.write("data: " + JSON.stringify(frame) + "\n\n");
      if (++index === 2 && data.message !== "hang") {
        const end = data.provider === "kimi" ? JSON.stringify({ event: "all_done" }) :
          data.provider === "claude" ? JSON.stringify({ type: "message_stop" }) : "[DONE]";
        response.end("data: " + end + "\n\n"); clearInterval(timer);
      }
    }, 250);
    response.on("close", () => clearInterval(timer));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const origin = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  const directory = await fs.mkdtemp(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "cw-browser-"));
  cleanup.push(() => fs.rm(directory, { recursive: true, force: true }));
  const options = { directory, maxWorkers: 2, perAccountConcurrency: 2, executablePath: executable,
    sites: runtimeSites.map((site) => ({ ...site, homeUrl: origin + "/" + site.name + "/" })) };
  let runtime = await startRuntimeServer(options);
  cleanup.push(async () => runtime.close());
  const client = new ChatRuntimeClient(runtime.socketPath);
  return { client, requests, restart: async () => { await runtime.close(); runtime = await startRuntimeServer(options); } };
}

describe.skipIf(!existsSync(executable))("runtime with real isolated Chromium workers", () => {
  it("streams all four adapter formats, isolates same-origin profiles, and restores a chat after restart", async () => {
    const { client, requests, restart } = await startFixture();
    const chats = await Promise.all(["chatgpt", "deepseek", "kimi", "claude"].map((provider) => client.create({ provider })));
    for (let pair = 0; pair < 2; pair++) {
      const turns = await Promise.all(chats.slice(pair * 2, pair * 2 + 2).map((chat) =>
        client.submit({ conversationId: chat.id, input: chat.provider, requestId: "one", timeoutMs: 15_000 })));
      const streams: string[][] = [[], []];
      const results = await Promise.all(turns.map((turn, i) => client.wait(turn.id, (event) => {
        if (event.type === "message_delta") streams[i]!.push(event.text!);
      })));
      expect(results.map((result) => result.status), JSON.stringify(results)).toEqual(["completed", "completed"]);
      expect(streams.every((parts) => parts.length >= 2)).toBe(true);
      for (let i = 0; i < results.length; i++) expect(results[i]!.text).toContain(chats[pair * 2 + i]!.provider);
    }
    expect(new Set(requests.map((request) => request.id)).size).toBe(4);
    const original = await client.get(chats[0]!.id);
    expect(original.providerConversationId).toBe(requests.find((request) => request.provider === "chatgpt")!.id);
    await restart();
    const turn = await client.submit({ conversationId: original.id, input: "resumed", requestId: "two", timeoutMs: 15_000 });
    const result = await client.wait(turn.id);
    expect(result.status).toBe("completed");
    expect(result.text).toContain(original.providerConversationId);
    expect(result.text).toMatch(/:2$/);
  }, 60_000);

  it("confirms stop in one browser without cancelling the other browser", async () => {
    const { client } = await startFixture();
    const a = await client.create({ provider: "chatgpt" });
    const b = await client.create({ provider: "chatgpt" });
    const first = await client.submit({ conversationId: a.id, input: "hang", requestId: "one", timeoutMs: 15_000 });
    const second = await client.submit({ conversationId: b.id, input: "keep", requestId: "one", timeoutMs: 15_000 });
    for await (const event of client.events(first.id)) if (event.type === "message_delta") break;
    await client.cancel(first.id);
    const [cancelled, completed] = await Promise.all([client.wait(first.id), client.wait(second.id)]);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.stopConfirmed).toBe(true);
    expect(completed.status).toBe("completed");
  }, 45_000);
});
