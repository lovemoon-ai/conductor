import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { chromium } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import { startRuntimeServer } from "../src/runtime/server.js";
import { ChatRuntimeClient } from "../src/runtime/client.js";
import { saveRuntimeAccount, applyRuntimeAccount } from "../src/runtime/accounts.js";
import { runtimeSites } from "../src/runtime/sites.js";

const executable = process.env.CHAT_WEB_TEST_BROWSER ?? chromium.executablePath();
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function fixtureHtml(provider: string): string {
  const input = provider === "deepseek" ? "<textarea></textarea>" :
    '<div id="prompt-textarea" class="chat-input-editor ProseMirror" role="textbox" contenteditable="true"></div>';
  const assistant = provider === "chatgpt" ? '<div data-message-author-role="assistant"></div>' :
    provider === "deepseek" ? '<div class="ds-markdown"></div>' :
    provider === "kimi" ? '<div class="segment-assistant"><div class="toolcall-container"><div class="markdown">private thought</div></div><div class="markdown"></div></div>' :
    '<div class="font-claude-message"></div>';
  const route = provider === "chatgpt" ? "/c/" : provider === "deepseek" ? "/a/chat/s/" : "/chat/";
  const endpoint = provider === "chatgpt" ? "/backend-api/conversation" : provider === "deepseek" ? "/api/v0/chat/completion" :
    provider === "kimi" ? "/apiv2/kimi.gateway.chat.v1.ChatService/Chat" : "/api/organizations/org/chat_conversations/thread/completion";
  const controls = provider === "kimi"
    ? '<div id="composer-submit-button" class="send-button-container">Send</div><div id="stop-control" class="send-button-container stop" hidden>Stop</div>'
    : provider === "deepseek"
    ? '<div id="composer-submit-button" role="button">Send</div><div id="stop-control" role="button" class="ds-button--circle" hidden><svg><path d="M2 4.88 fixture"/></svg></div>'
    : '<button id="composer-submit-button" data-testid="send-button" aria-label="Send message">Send</button><button id="stop-control" class="stop-button" data-testid="stop-button" aria-label="Stop generating" hidden>Stop</button>';
  const thinkingControl = provider === "deepseek" ? '<div id="deepthink" class="ds-toggle-button" aria-pressed="false">DeepThink</div><div class="ds-toggle-button" aria-pressed="true">Search</div>' : "";
  return `<!doctype html><html><body>${input}
    ${controls}${thinkingControl}
    <div data-testid="sidebar-user-menu-trigger" class="user-profile-trigger">fixture account</div><main></main><script>
    let controller, xhr;
    const composer = document.querySelector('textarea, [contenteditable]');
    const stop = document.querySelector('#stop-control');
    const deepthink = document.querySelector('#deepthink');
    if (deepthink) {
      deepthink.setAttribute('aria-pressed', localStorage.getItem('thinking') || 'false');
      deepthink.onclick = () => {
        const value = deepthink.getAttribute('aria-pressed') !== 'true';
        deepthink.setAttribute('aria-pressed', String(value)); localStorage.setItem('thinking', String(value));
      };
    }
    if (${JSON.stringify(provider)} === "claude") { composer.hidden = true; setTimeout(() => { composer.hidden = false; }, 350); }
    stop.onclick = () => { controller?.abort(); xhr?.abort(); stop.hidden = true; };
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
        if (${JSON.stringify(provider)} === "deepseek") {
          await new Promise((resolve, reject) => {
            xhr = new XMLHttpRequest();
            xhr.open('POST', ${JSON.stringify(endpoint)});
            xhr.onload = resolve; xhr.onerror = reject; xhr.onabort = reject;
            xhr.onprogress = () => { document.querySelector('main .ds-markdown:last-child').textContent = 'private thought'; };
            xhr.send(JSON.stringify({message, id, turn, auth: localStorage.getItem('access_token'), thinking_enabled: deepthink.getAttribute('aria-pressed') === 'true', provider: ${JSON.stringify(provider)}}));
          });
        } else {
          const response = await fetch(${JSON.stringify(endpoint)}, { method: 'POST', body: JSON.stringify({message, id, turn, auth: localStorage.getItem('access_token'), provider: ${JSON.stringify(provider)}}), signal: controller.signal });
          const reader = response.body.getReader();
          for (;;) {
            const {value, done} = await reader.read(); if (done) break;
            if (${JSON.stringify(provider)} === "kimi" && new TextDecoder().decode(value).includes('"done":')) {
              controller.abort(); break;
            }
          }
        }
      } catch {} finally {
        if (${JSON.stringify(provider)} === "kimi") await new Promise(resolve => setTimeout(resolve, 650));
        stop.hidden = true;
      }
    };
    composer.onkeydown = event => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault(); document.querySelector('#composer-submit-button').click();
      }
    };
    </script></body></html>`;
}

function connectFrame(value: unknown, flags = 0): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(5); header[0] = flags; header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}

async function startFixture(fixtureOptions: { deepThinkSelector?: string } = {}) {
  const requests: { provider: string; message: string; id: string; turn: number; thinking_enabled?: boolean; auth?: string }[] = [];
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
    response.writeHead(200, { "content-type": data.provider === "kimi" ? "application/connect+json" : "text/event-stream; charset=utf-8" });
    response.flushHeaders();
    const answer = "你好:" + data.message + ":" + data.id + ":" + data.turn;
    if (data.provider === "deepseek") response.write("data: " + JSON.stringify({
      v: { response: { fragments: [{ id: 41, type: "THINK", content: "private thought" }] } },
    }) + "\n\n");
    let index = 0;
    const timer = setInterval(() => {
      const text = index === 0 ? answer.slice(0, 3) : answer.slice(3);
      let frame: unknown;
      if (data.provider === "chatgpt") frame = { message: { id: "m1", author: { role: "assistant" }, content: { parts: [index === 0 ? text : answer] }, status: "in_progress" } };
      else if (data.provider === "deepseek") frame = index === 0 ? { p: "response/fragments", o: "APPEND", v: [{ id: 42, type: "RESPONSE", content: text }] } : { p: "response/fragments/-1/content", o: "APPEND", v: text };
      else if (data.provider === "kimi") frame = { op: index === 0 ? "set" : "append", mask: "block.text.content", block: { id: "answer", text: { content: text } } };
      else frame = { type: "content_block_delta", delta: { type: "text_delta", text } };
      if (data.provider === "kimi") response.write(connectFrame(frame));
      else response.write("data: " + JSON.stringify(frame) + "\n\n");
      if (++index === 2 && data.message !== "hang") {
        if (data.provider === "kimi") {
          if (data.message === "truncated") response.end();
          else {
            response.write(connectFrame({ done: {} }));
            setTimeout(() => response.end(connectFrame({}, 2)), 300).unref();
          }
        }
        else response.end("data: " + (data.provider === "claude" ? JSON.stringify({ type: "message_stop" }) :
          data.provider === "deepseek" ? JSON.stringify({ p: "response", o: "BATCH", v: [{ p: "status", o: "SET", v: "FINISHED" }] }) : "[DONE]") + "\n\n");
        clearInterval(timer);
      }
    }, data.message === "early-stop" ? 5000 : 250);
    response.on("close", () => clearInterval(timer));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const origin = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  const directory = await fs.mkdtemp(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "cw-browser-"));
  cleanup.push(() => fs.rm(directory, { recursive: true, force: true }));
  const options = { directory, maxWorkers: 2, perAccountConcurrency: 2, executablePath: executable,
    sites: runtimeSites.map((site) => ({ ...site, homeUrl: origin + "/" + site.name + "/",
      ...(site.name === "deepseek" && fixtureOptions.deepThinkSelector !== undefined ? { deepThink: fixtureOptions.deepThinkSelector } : {}),
    })) };
  let runtime = await startRuntimeServer(options);
  cleanup.push(async () => runtime.close());
  const client = new ChatRuntimeClient(runtime.socketPath);
  return { client, requests, directory, origin, restart: async () => { await runtime.close(); runtime = await startRuntimeServer(options); } };
}

describe.skipIf(!existsSync(executable))("runtime with real isolated Chromium workers", () => {
  it("restores credentials with older Playwright without resetting refreshed tokens on reload", async () => {
    const { origin, directory } = await startFixture();
    const context = await chromium.launchPersistentContext(path.join(directory, "fallback"), { headless: true, executablePath: executable });
    cleanup.push(() => context.close());
    (context as any).setStorageState = undefined;
    await applyRuntimeAccount(context, { cookies: [], origins: [{ origin, localStorage: [{ name: "access_token", value: "original" }] }] });
    const page = context.pages()[0]!;
    await page.goto(origin + "/kimi/");
    expect(await page.evaluate(() => localStorage.getItem("access_token"))).toBe("original");
    await page.evaluate(() => localStorage.setItem("access_token", "refreshed"));
    await page.reload();
    expect(await page.evaluate(() => localStorage.getItem("access_token"))).toBe("refreshed");
  }, 20_000);

  it("closes a task stopped before its first token and restores that provider conversation", async () => {
    const { client, requests, restart } = await startFixture();
    const chat = await client.create({ provider: "kimi" });
    const turn = await client.submit({ conversationId: chat.id, requestId: "early", input: "early-stop" });
    for (let n = 0; n < 300 && !requests.length; n++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(requests.length).toBe(1);
    const closed = await client.closeConversation(chat.id);
    const stopped = await client.getTurn(turn.id);
    expect(stopped.status).toBe("cancelled");
    expect(stopped.stopConfirmed).toBe(true);
    expect(stopped.text).toBe("");
    expect(closed.url).toContain(requests[0]!.id);
    expect(closed.providerConversationId).toBe(requests[0]!.id);
    await restart();
    await client.resume(chat.id);
    const next = await client.submit({ conversationId: chat.id, requestId: "next", input: "continue" });
    expect((await client.wait(next.id)).status).toBe("completed");
    expect(requests[1]!.id).toBe(requests[0]!.id);
    expect(requests[1]!.turn).toBe(2);
  }, 30_000);

  it("seeds two isolated chats from one account without copying its active conversation", async () => {
    const { client, requests, directory, origin } = await startFixture();
    await saveRuntimeAccount("kimi", { cookies: [], origins: [{ origin, localStorage: [
      { name: "access_token", value: "fixture-account" }, { name: "chatId", value: "must-not-copy" },
    ] }] }, "default", path.join(directory, "accounts"));
    const chats = await Promise.all([client.create({ provider: "kimi" }), client.create({ provider: "kimi" })]);
    const turns = await Promise.all(chats.map((chat, i) => client.submit({ conversationId: chat.id, requestId: "auth-" + i, input: "authenticated" })));
    const replies = await Promise.all(turns.map(turn => client.wait(turn.id)));
    expect(replies.every(reply => reply.status === "completed")).toBe(true);
    expect(requests.map(request => request.auth)).toEqual(["fixture-account", "fixture-account"]);
    expect(new Set(requests.map(request => request.id)).size).toBe(2);
    expect(requests.every(request => request.id !== "must-not-copy")).toBe(true);
  }, 30_000);

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
      expect(streams.flat().join("")).not.toContain("private thought");
      results.forEach((result, i) => expect(result.source).toBe(chats[pair * 2 + i]!.provider === "kimi" ? "connect" : "sse"));
      for (let i = 0; i < results.length; i++) expect(results[i]!.text).toContain(chats[pair * 2 + i]!.provider);
    }
    expect(new Set(requests.map((request) => request.id)).size).toBe(4);
    const continuation = await client.submit({ conversationId: chats[2]!.id, input: "immediate-followup", requestId: "two", timeoutMs: 15_000 });
    expect((await client.wait(continuation.id)).status).toBe("completed");
    const original = await client.get(chats[0]!.id);
    expect(original.providerConversationId).toBe(requests.find((request) => request.provider === "chatgpt")!.id);
    await restart();
    const turn = await client.submit({ conversationId: original.id, input: "resumed", requestId: "two", timeoutMs: 15_000 });
    const result = await client.wait(turn.id);
    expect(result.status).toBe("completed");
    expect(result.text).toContain(original.providerConversationId);
    expect(result.text).toMatch(/:2$/);
  }, 60_000);

  it("sets DeepThink idempotently, applies turn overrides and preserves separate chat defaults", async () => {
    const { client, requests, restart } = await startFixture();
    const a = await client.create({ provider: "deepseek", deepThink: true });
    const b = await client.create({ provider: "deepseek", deepThink: false });
    const send = async (chatId: string, input: string, deepThink?: boolean) => {
      const turn = await client.submit({ conversationId: chatId, input, requestId: input, deepThink, timeoutMs: 15_000 });
      const result = await client.wait(turn.id);
      expect(result.status, result.error).toBe("completed");
    };
    await Promise.all([send(a.id, "a-on"), send(b.id, "b-off")]);
    await send(a.id, "still-on");
    await send(a.id, "override-off", false);
    await send(a.id, "default-on");
    expect(requests.filter(r => r.message !== "b-off").map(r => r.thinking_enabled)).toEqual([true, true, false, true]);
    expect(requests.find(r => r.message === "b-off")?.thinking_enabled).toBe(false);
    await restart();
    await send(a.id, "restored-default");
    expect(requests.at(-1)?.thinking_enabled).toBe(true);
  }, 45_000);

  it("fails without sending when the DeepThink control is unavailable", async () => {
    const { client, requests } = await startFixture({ deepThinkSelector: "#missing" });
    const chat = await client.create({ provider: "deepseek" });
    const turn = await client.submit({ conversationId: chat.id, input: "must-not-send", requestId: "one", deepThink: true, timeoutMs: 10_000 });
    const result = await client.wait(turn.id);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/DeepThink control is unavailable/);
    expect(requests).toHaveLength(0);
    expect((await client.get(chat.id)).needsReview).toBe(false);
  }, 20_000);

  it("keeps truncated Connect replies uncertain even after the UI stops", async () => {
    const { client } = await startFixture();
    const chat = await client.create({ provider: "kimi" });
    const turn = await client.submit({ conversationId: chat.id, input: "truncated", requestId: "one", timeoutMs: 10_000 });
    const result = await client.wait(turn.id);
    expect(result.status).toBe("uncertain");
    expect(result.error).toMatch(/trailer/);
    expect((await client.get(chat.id)).needsReview).toBe(true);
  }, 20_000);

  it.each(["chatgpt", "kimi", "deepseek"])("confirms %s stop without cancelling the other browser", async (provider) => {
    const { client } = await startFixture();
    const a = await client.create({ provider });
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
