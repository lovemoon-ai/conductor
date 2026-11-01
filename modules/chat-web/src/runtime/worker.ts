import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { readRuntimeAccount, applyRuntimeAccount } from "./accounts.js";
import type { BrowserContext, Locator, Page } from "playwright";
import { launchProviderBrowser } from "../core/browser.js";
import { clearProfileOwner } from "../core/profile-lock.js";
import { createLogger } from "../core/logger.js";
import { ChatStreamDecoder } from "./stream-decoder.js";
import { RuntimeError, type WorkerConfig, type WorkerNotice, type WorkerResult } from "./types.js";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Installed in the page's main world, with a private per-worker binding. */
// Keep injected source independent of Node/TypeScript loader helpers.
const observeStreams = String.raw`(options) => {
  const scope = window;
  if (scope[options.key]) return;
  const state = { active: "" };
  const original = window.fetch;
  const pattern = new RegExp(options.path);
  window.fetch = async function (...args) {
    const request = args[0];
    const url = new URL(typeof request === "string" ? request : request instanceof URL ? request.href : request.url, location.href);
    const method = args[1]?.method ?? (request instanceof Request ? request.method : "GET");
    const token = state.active;
    const matched = token && url.origin === options.origin && method.toUpperCase() === "POST" && pattern.test(url.pathname + url.search);
    const response = await original.apply(this, args);
    if (matched) {
      const send = (payload) => Promise.resolve(scope[options.binding]({ token, ...payload })).catch(() => undefined);
      if (!response.ok) void send({ error: "Provider HTTP " + response.status });
      else if (response.headers.get("content-type")?.includes("event-stream") ||
               response.headers.get("content-type")?.includes("application/connect+json")) {
        const connect = response.headers.get("content-type").includes("application/connect+json");
        const reader = response.clone().body?.getReader();
        if (reader) void (async () => {
          const decoder = new TextDecoder();
          let bytes = 0;
          const pending = new Set();
          const emit = (payload) => {
            const task = send(payload).finally(() => pending.delete(task));
            pending.add(task);
          };
          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              bytes += value.byteLength;
              if (bytes > 8_000_000) { await send({ error: "Response exceeds capture limit" }); void reader.cancel().catch(() => undefined); break; }
              if (connect) {
                // Pass raw bytes across IPC: decoding binary envelope headers as UTF-8 corrupts lengths.
                let binary = "";
                for (let i = 0; i < value.length; i += 32768) binary += String.fromCharCode(...value.subarray(i, i + 32768));
                emit({ connectChunk: btoa(binary) });
                // Drain the tee promptly: the site's reader may abort as soon as it sees done.
                if (pending.size >= 64) await Promise.all(pending);
              } else await send({ chunk: decoder.decode(value, { stream: true }) });
            }
            if (connect) { await Promise.all(pending); await send({ connectEnd: true }); }
            const tail = decoder.decode();
            if (tail) await send({ chunk: tail });
          } catch (error) {
            await Promise.all(pending);
            await send({ interrupted: error?.name || "Error" });
          }
          finally { reader.releaseLock(); }
        })();
      }
    }
    return response;
  };
  // DeepSeek streams SSE through XMLHttpRequest, so fetch alone misses the entire protocol.
  const opened = new WeakMap();
  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    opened.set(this, { method: String(method).toUpperCase(), url: new URL(String(url), location.href) });
    return xhrOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    const request = opened.get(this);
    const token = state.active;
    if (token && request?.method === "POST" && request.url.origin === options.origin &&
        pattern.test(request.url.pathname + request.url.search)) {
      let offset = 0;
      let limited = false;
      const send = (payload) => Promise.resolve(scope[options.binding]({ token, ...payload })).catch(() => undefined);
      const flush = () => {
        if (limited || (this.responseType && this.responseType !== "text") ||
            !this.getResponseHeader("content-type")?.includes("event-stream")) return;
        const text = this.responseText;
        if (text.length > 8_000_000) { limited = true; void send({ error: "Response exceeds capture limit" }); return; }
        const chunk = text.slice(offset); offset = text.length;
        if (chunk) void send({ chunk });
      };
      this.addEventListener("progress", flush);
      this.addEventListener("load", () => {
        if (this.status < 200 || this.status >= 300) void send({ error: "Provider HTTP " + this.status });
        else flush();
      });
      this.addEventListener("abort", () => { void send({ interrupted: "AbortError" }); });
      this.addEventListener("error", () => { void send({ interrupted: "NetworkError" }); });
      this.addEventListener("timeout", () => { void send({ interrupted: "TimeoutError" }); });
    }
    return xhrSend.apply(this, args);
  };
  scope[options.key] = state;
}`;

class Session {
  private context?: BrowserContext;
  private page?: Page;
  private opening?: Promise<WorkerResult>;
  private controller?: AbortController;
  private decoder?: ChatStreamDecoder;
  private token = "";
  private captureError?: string;
  private key = "__chat_runtime_" + randomUUID().replaceAll("-", "");
  private binding = "__chat_runtime_event_" + randomUUID().replaceAll("-", "");

  constructor(private config: WorkerConfig) {}

  open(): Promise<WorkerResult> {
    if (this.page && !this.page.isClosed()) return this.location();
    this.opening ??= this.openInternal().catch(async (error) => {
      await this.close();
      throw error;
    }).finally(() => { this.opening = undefined; });
    return this.opening;
  }

  private async openInternal(): Promise<WorkerResult> {
    if (this.context) await this.close();
    const directory = this.config.profileDir;
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const launched = await launchProviderBrowser(this.config.site.name, {
      headless: this.config.conversation.headless,
      executablePath: this.config.executablePath,
      channel: this.config.channel,
      logger: createLogger("silent"),
      profileManager: {
        getProfileDir: () => directory,
        ensureProfile: async () => directory,
        clearProfile: async () => { throw new Error("Runtime profiles are retained"); },
        listProfiles: async () => [this.config.conversation.id],
      },
    });
    this.context = launched.context;
    this.page = launched.page;
    const page = this.page;
    const auth = await readRuntimeAccount(this.config.site.name, this.config.conversation.accountId, this.config.authDirectory);
    const marker = path.join(directory, ".account-auth.json");
    let importedAt = 0;
    try { importedAt = JSON.parse(await fs.readFile(marker, "utf8")).updatedAt ?? 0; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (auth && auth.updatedAt > importedAt) {
      await applyRuntimeAccount(this.context, auth.state);
      await fs.writeFile(marker, JSON.stringify({ updatedAt: auth.updatedAt }), { mode: 0o600 });
    }
    page.setDefaultTimeout(10_000);
    page.setDefaultNavigationTimeout(30_000);
    await page.exposeBinding(this.binding, ({ page: source, frame }, payload: any) => {
      if (source !== page || frame !== page.mainFrame() || payload?.token !== this.token || !this.token) return;
      if (typeof payload.error === "string") this.captureError = payload.error.slice(0, 256);
      if (typeof payload.interrupted === "string" &&
          !(payload.interrupted === "AbortError" && this.decoder?.complete)) {
        this.captureError = "Response stream interrupted (" + payload.interrupted.slice(0, 32) + ")";
      }
      if (typeof payload.connectChunk === "string") {
        if (payload.connectChunk.length > 1_400_000) { this.captureError = "Capture chunk exceeds limit"; return; }
        try { this.decoder?.pushConnect(Buffer.from(payload.connectChunk, "base64")); }
        catch (error) { this.captureError = String(error); }
      }
      if (payload.connectEnd === true) {
        try { this.decoder?.finishConnect(); } catch (error) { this.captureError = String(error); }
      }
      if (typeof payload.chunk === "string") {
        if (payload.chunk.length > 1_000_000) { this.captureError = "Capture chunk exceeds limit"; return; }
        try { this.decoder?.push(payload.chunk); } catch (error) { this.captureError = String(error); }
      }
    });
    const observer = { key: this.key, binding: this.binding, path: this.config.site.streamPath, origin: new URL(this.config.site.homeUrl).origin };
    const source = "(" + observeStreams + ")(" + JSON.stringify(observer) + ")";
    await page.addInitScript({ content: source });
    await page.goto(this.config.conversation.url ?? this.config.site.homeUrl, { waitUntil: "domcontentloaded" });
    await page.evaluate(source);
    await this.waitForInput();
    return this.location();
  }

  private async visible(selector: string): Promise<Locator | undefined> {
    const locator = this.page!.locator(selector);
    const count = Math.min(await locator.count(), 12);
    for (let index = 0; index < count; index++) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
    return undefined;
  }

  private async waitForInput(): Promise<Locator | undefined> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const input = await this.visible(this.config.site.input);
      if (input && (!this.config.site.authenticated || await this.visible(this.config.site.authenticated))) return input;
      if (/\/(?:login|auth|signin|sign_in|sign-in)(?:\/|$)/i.test(new URL(this.page!.url()).pathname)) return undefined;
      await pause(100);
    }
    return undefined;
  }

  private async location(): Promise<WorkerResult> {
    const page = this.page!;
    const url = new URL(page.url());
    const origin = new URL(this.config.site.homeUrl).origin;
    const match = url.origin === origin ? new RegExp(this.config.site.conversationPath).exec(url.pathname) : null;
    return {
      ready: !!(await this.visible(this.config.site.input)) && (!this.config.site.authenticated || !!(await this.visible(this.config.site.authenticated))),
      ...(match ? { url: url.href, providerConversationId: match[1] } : {}),
    };
  }

  private async setDeepThink(enabled: boolean | undefined): Promise<void> {
    if (enabled === undefined) return;
    const selector = this.config.site.deepThink;
    if (this.config.site.name !== "deepseek" || !selector) throw new RuntimeError("DEEPTHINK_UNAVAILABLE", "DeepThink control is unavailable");
    let toggle = await this.visible(selector);
    for (let i = 0; !toggle && i < 60; i++) {
      if (this.controller?.signal.aborted) throw new RuntimeError("CANCELLED", "Cancelled before submission");
      await pause(50);
      toggle = await this.visible(selector);
    }
    if (!toggle) throw new RuntimeError("DEEPTHINK_UNAVAILABLE", "DeepThink control is unavailable");
    const state = async () => (await toggle.getAttribute("aria-pressed")) ?? (await toggle.getAttribute("aria-checked"));
    const current = await state();
    if (current !== "true" && current !== "false") throw new RuntimeError("DEEPTHINK_UNAVAILABLE", "Cannot determine DeepThink state");
    if ((current === "true") === enabled) return;
    await toggle.click();
    for (let i = 0; i < 60; i++) {
      if (await state() === String(enabled)) return;
      if (this.controller?.signal.aborted) throw new RuntimeError("CANCELLED", "Cancelled before submission");
      await pause(50);
    }
    throw new RuntimeError("DEEPTHINK_UNAVAILABLE", "DeepThink did not switch to the requested state");
  }

  async send(input: string, timeoutMs: number, notify: (notice: WorkerNotice) => void, options: { deepThink?: boolean } = {}): Promise<WorkerResult> {
    await this.open();
    const page = this.page!;
    const composer = await this.waitForInput();
    if (!composer) throw new RuntimeError("AUTH_REQUIRED", "Chat input is unavailable; open this chat's login window");
    if (await this.visible(this.config.site.stop)) throw new RuntimeError("PROVIDER_BUSY", "Provider is still generating; wait or stop it before sending again");
    const baseline = await page.locator(this.config.site.assistant).allTextContents();
    this.controller = new AbortController();
    this.decoder = new ChatStreamDecoder(this.config.site.format);
    this.captureError = undefined;
    this.token = randomUUID();
    await page.evaluate(({ key, token }) => { (window as any)[key].active = token; }, { key: this.key, token: this.token });
    let previous = "";
    let stableSince = Date.now();
    let observedStop = false;
    const deadline = Date.now() + timeoutMs;
    try {
      await this.setDeepThink(options.deepThink);
      await composer.fill(input);
      if (this.controller.signal.aborted) throw new RuntimeError("CANCELLED", "Cancelled before submission");
      // Parent records this phase before considering any subsequent failure safe to retry.
      notify({ type: "submitting" });
      const send = await this.visible(this.config.site.send);
      if (send && await send.isEnabled()) await send.click();
      else await composer.press("Enter");
      while (Date.now() < deadline) {
        if (this.controller.signal.aborted) {
          const stop = await this.visible(this.config.site.stop);
          if (stop) {
            await stop.click().catch(() => undefined);
            for (let i = 0; i < 20; i++) {
              if (!(await this.visible(this.config.site.stop))) {
                const error = new RuntimeError("CANCELLED", "Generation stop observed");
                Object.assign(error, { stopConfirmed: true });
                throw error;
              }
              await pause(100);
            }
          }
          throw new RuntimeError("UNCERTAIN", "Client cancelled; provider stop was not confirmed");
        }
        if (this.captureError || this.decoder.error) throw new RuntimeError("UNCERTAIN", this.captureError ?? this.decoder.error!);
        const texts = await page.locator(this.config.site.assistant).allTextContents();
        const newMessage = texts.length > baseline.length;
        const domText = newMessage ? texts.at(-1)?.trim() ?? "" : "";
        // Once a protocol is captured, an empty answer can mean reasoning, not missing DOM.
        const text = this.decoder.captured ? this.decoder.text : domText;
        if (text.length > 1_000_000) throw new RuntimeError("UNCERTAIN", "Response exceeds limit");
        if (text !== previous) {
          previous = text;
          stableSince = Date.now();
          if (text) notify({ type: "progress", text, ...(await this.location()) });
        }
        const stopping = !!(await this.visible(this.config.site.stop));
        // The protocol can finish before the UI releases its composer; keep FIFO handoff safe.
        if (this.decoder.complete && this.decoder.text && !stopping) return { text: this.decoder.text, source: this.decoder.source, ...(await this.location()) };
        observedStop ||= stopping;
        // DOM completion requires an observed generation control transition and a NEW answer.
        if (this.decoder.source !== "connect" && newMessage && text && observedStop && !stopping && Date.now() - stableSince > 700) {
          return { text, source: "dom", ...(await this.location()) };
        }
        await pause(100);
      }
      throw new RuntimeError("UNCERTAIN", "Response deadline exceeded; provider completion was not confirmed");
    } finally {
      // A stop can precede the first text delta. Retain its provider URL so a
      // task restart resumes that conversation instead of silently opening home.
      try { notify({ type: "progress", text: previous, ...(await this.location()) }); } catch {}
      this.token = "";
      this.controller = undefined;
    }
  }

  cancel(): void { this.controller?.abort(); }
  async close(): Promise<void> {
    this.cancel();
    const owned = !!this.context;
    await this.context?.close().catch(() => undefined);
    if (owned) clearProfileOwner(this.config.profileDir);
    this.context = undefined;
    this.page = undefined;
  }
}

let config: WorkerConfig | undefined;
let session: Session | undefined;
let busy = false;
process.on("message", async (message: any) => {
  if (message.config) { config = message.config; session = new Session(config!); return; }
  if (message.command === "cancel") { session?.cancel(); return; }
  if (!session || busy) {
    process.send?.({ id: message.id, error: { code: "WORKER_BUSY", message: "Chat worker is busy" } });
    return;
  }
  busy = true;
  try {
    let result: WorkerResult = {};
    if (message.command === "open") result = await session.open();
    else if (message.command === "send") result = await session.send(message.input, message.timeoutMs,
      (notice) => process.send?.({ id: message.id, notice }), { deepThink: message.deepThink });
    else if (message.command === "close") await session.close();
    else throw new RuntimeError("INVALID_REQUEST", "Unknown worker command");
    process.send?.({ id: message.id, result });
    if (message.command === "close") process.disconnect();
  } catch (error: any) {
    process.send?.({ id: message.id, error: { code: error.code ?? "WORKER_ERROR", message: String(error.message ?? error), stopConfirmed: error.stopConfirmed } });
  } finally { busy = false; }
});
process.on("disconnect", () => { void session?.close().finally(() => process.exit(0)); });
process.on("SIGTERM", () => { void session?.close().finally(() => process.exit(0)); });
