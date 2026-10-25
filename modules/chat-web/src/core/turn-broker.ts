import fs from "node:fs";
import net from "node:net";
import readline from "node:readline";

import type { LaunchedBrowser } from "./browser.js";
import { BROKER_PROTOCOL, wireError } from "./broker-protocol.js";
import { ChatWebError, ResponseTimeoutError } from "./errors.js";
import type { ChatProvider } from "./provider.js";
import { TurnQueue } from "./turn-queue.js";
import { ChatSession, type SendOptions } from "../session.js";

interface Client {
  socket: net.Socket;
  session?: ChatSession;
  opening: boolean;
  closing: boolean;
  disposal?: Promise<void>;
  jobs: Map<number, AbortController>;
}

// Some adapters wait on a network collector that does not observe AbortSignal.
// The broker must still release a disconnected task after its page is closed.
async function withTurnDeadline<T>(run: () => Promise<T>, controller: AbortController, timeoutMs: number, provider: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      abort = () => reject(new DOMException("Aborted", "AbortError"));
      if (controller.signal.aborted) { abort(); return; }
      controller.signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => {
        reject(new ResponseTimeoutError(provider, timeoutMs));
        controller.abort();
      }, timeoutMs);
      void Promise.resolve().then(run).then(resolve, reject);
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) controller.signal.removeEventListener("abort", abort);
  }
}

/** One profile, one browser, one FIFO; each connection owns a separate tab. */
export async function startTurnBroker(options: {
  socketPath: string;
  provider: ChatProvider;
  launch: () => Promise<LaunchedBrowser>;
  idleMs?: number;
}): Promise<{ close(): Promise<void>; closed: Promise<void> }> {
  const { provider } = options;
  const queue = new TurnQueue();
  const clients = new Set<Client>();
  let browser: Promise<LaunchedBrowser> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let stopping = false;
  let closePromise: Promise<void> | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });

  const send = (client: Client, message: unknown) => {
    if (!client.socket.destroyed && !client.socket.writableEnded) client.socket.write(`${JSON.stringify(message)}\n`);
  };
  const dispose = (client: Client): Promise<void> => {
    client.closing = true;
    for (const controller of client.jobs.values()) controller.abort();
    if (!client.disposal && client.session) {
      client.disposal = (async () => {
        // A timeout/abort must not leave this tab generating while B starts.
        try { await provider.stopGeneration?.(client.session!.page); } catch { /* Close the page regardless. */ }
        await client.session!.close();
      })();
    }
    return client.disposal ?? Promise.resolve();
  };
  const assertSession = (client: Client): ChatSession => {
    if (client.closing || !client.session || client.session.isClosed) {
      throw new ChatWebError("BROKER_SESSION_CLOSED", "The shared chat-web session is closed; create a new session.", { provider: provider.name });
    }
    return client.session;
  };
  const perform = async (client: Client, request: { id: number; method: string; args?: Record<string, unknown> }) => {
    const { id, method } = request;
    const args = request.args ?? {};
    if (method === "close") {
      await dispose(client);
      send(client, { id, result: null });
      return;
    }
    if (client.closing) assertSession(client);
    if (method === "open") {
      if (args.protocol !== BROKER_PROTOCOL) throw new Error("Incompatible chat-web broker protocol; close existing chat-web sessions and retry.");
      if (client.opening || client.session) throw new Error("This broker connection already owns a session.");
      client.opening = true;
    }
    const controller = new AbortController();
    client.jobs.set(id, controller);
    try {
      let result: unknown;
      if (method === "open") {
        result = await queue.run(async () => {
          browser ??= options.launch().then((launched) => {
            // Do not keep a live broker advertising a browser that has died.
            launched.context.once?.("close", () => { void close(); });
            return launched;
          });
          const launched = await browser;
          if (client.closing) throw new DOMException("Aborted", "AbortError");
          const page = await launched.context.newPage();
          client.session = ChatSession.fromBrowser({
            provider, page, context: launched.context, userDataDir: launched.userDataDir, closeContext: false,
          });
          if (client.closing) { await dispose(client); throw new DOMException("Aborted", "AbortError"); }
          try {
            if (args.autoOpen !== false) await provider.open(page);
            return { userDataDir: launched.userDataDir };
          } catch (error) { await dispose(client); throw error; }
        }, { signal: controller.signal });
      } else if (method === "send" || method === "newChat") {
        result = await queue.run(async () => {
          const session = assertSession(client);
          try {
            const timeoutMs = typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs) && args.timeoutMs > 0
              ? args.timeoutMs : 180_000;
            return await withTurnDeadline(async () => {
              await session.page.bringToFront();
              if (method === "newChat") { await session.newChat(); return null; }
              const sendOptions: SendOptions = {
                timeoutMs,
                stableMs: typeof args.stableMs === "number" ? args.stableMs : undefined,
                newChat: args.newChat === true,
                signal: controller.signal,
                onProgress: (text) => send(client, { id, type: "progress", text }),
              };
              return await session.send(String(args.message ?? ""), sendOptions);
            }, controller, timeoutMs, provider.name);
          } catch (error) { await dispose(client); throw error; }
        }, {
          signal: controller.signal,
          onPosition: (position) => send(client, { id, type: "queue", position }),
        });
      } else if (method === "isLoggedIn") {
        result = await assertSession(client).isLoggedIn();
      } else if (method === "diagnose") {
        result = await assertSession(client).diagnose();
      } else if (method === "snapshot") {
        result = await assertSession(client).snapshot();
      } else {
        throw new Error(`Unknown chat-web broker method: ${method}`);
      }
      send(client, { id, result });
    } finally { client.jobs.delete(id); }
  };
  const server = net.createServer((socket) => {
    if (stopping) { socket.destroy(); return; }
    if (idleTimer) clearTimeout(idleTimer);
    const client: Client = { socket, opening: false, closing: false, jobs: new Map() };
    clients.add(client);
    socket.on("error", () => { socket.destroy(); });
    const lines = readline.createInterface({ input: socket });
    lines.on("error", () => socket.destroy());
    lines.on("line", (line) => {
      let request: { id: number; method: string; type?: string; args?: Record<string, unknown> };
      try { request = JSON.parse(line); } catch { socket.destroy(); return; }
      if (!Number.isSafeInteger(request.id)) { socket.destroy(); return; }
      if (request.type === "cancel") { client.jobs.get(request.id)?.abort(); return; }
      void perform(client, request).catch((error) => send(client, { id: request.id, error: wireError(error) }));
    });
    socket.once("close", () => {
      lines.close();
      void dispose(client).finally(() => {
        clients.delete(client);
        scheduleIdle();
      });
    });
  });
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      stopping = true;
      if (idleTimer) clearTimeout(idleTimer);
      for (const client of clients) client.socket.destroy();
      await Promise.all([...clients].map(dispose));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (browser) {
        try { await (await browser).context.close(); } catch { /* A crashed browser is already closed. */ }
      }
      resolveClosed();
    })();
    return closePromise;
  };
  function scheduleIdle(): void {
    if (stopping || clients.size) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { void close(); }, options.idleMs ?? 5_000);
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => { server.removeListener("error", reject); resolve(); });
  });
  if (process.platform !== "win32") fs.chmodSync(options.socketPath, 0o600);
  scheduleIdle();
  return { close, closed };
}
