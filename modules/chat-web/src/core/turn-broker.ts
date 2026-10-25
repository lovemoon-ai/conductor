import fs from "node:fs";
import net from "node:net";
import readline from "node:readline";

import type { LaunchedBrowser } from "./browser.js";
import { BROKER_PROTOCOL, wireError } from "./broker-protocol.js";
import { ChatWebError, NotLoggedInError, ResponseTimeoutError } from "./errors.js";
import type { ChatProvider } from "./provider.js";
import { TurnQueue } from "./turn-queue.js";
import { ChatSession, type SendOptions, type SendResult } from "../session.js";

interface Client {
  socket: net.Socket;
  session?: ChatSession;
  opening: boolean;
  opened: boolean;
  closing: boolean;
  needsRecovery: boolean;
  recoveryId?: string;
  turnCounter: number;
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
  // Retire a failed page while keeping the logical conversation/connection.
  // No failed prompt is replayed: only a later user operation restores the URL.
  const retirePage = (client: Client, preserveConversation: boolean): Promise<void> => {
    if (client.disposal) return client.disposal;
    const session = client.session;
    if (!session) return Promise.resolve();
    const previousId = client.recoveryId;
    const recovering = client.needsRecovery;
    client.session = undefined;
    client.needsRecovery = true;
    client.recoveryId = undefined;
    if (preserveConversation) {
      try { client.recoveryId = recovering ? previousId : provider.getConversationId?.(session.page) ?? previousId; } catch { /* Require explicit clear if the ID is unknown. */ }
    }
    client.disposal = (async () => {
      try { await provider.stopGeneration?.(session.page); } catch { /* Close the page regardless. */ }
      await session.close();
    })();
    return client.disposal;
  };
  const dispose = (client: Client): Promise<void> => {
    client.closing = true;
    for (const controller of client.jobs.values()) controller.abort();
    return retirePage(client, false);
  };
  const assertConnected = (client: Client): void => {
    if (client.closing || !client.opened) {
      throw new ChatWebError("BROKER_SESSION_CLOSED", "The shared chat-web session is closed; create a new session.", { provider: provider.name });
    }
  };
  const recoveryRequired = () => new ChatWebError(
    "BROKER_RECOVERY_REQUIRED",
    "Could not restore the previous conversation safely. No message was sent. Use /clear to explicitly start a new conversation.",
    { provider: provider.name, hint: "Use newChat() or /clear; the failed message will not be retried." },
  );
  const createSession = async (client: Client, signal?: AbortSignal): Promise<ChatSession> => {
    if (client.disposal) await client.disposal;
    browser ??= options.launch().then((launched) => {
      launched.context.once?.("close", () => { void close(); });
      return launched;
    });
    const launched = await browser;
    if (client.closing || signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const page = await launched.context.newPage();
    if (client.closing || signal?.aborted) { await page.close(); throw new DOMException("Aborted", "AbortError"); }
    client.disposal = undefined;
    client.session = ChatSession.fromBrowser({
      provider, page, context: launched.context, userDataDir: launched.userDataDir, closeContext: false,
    });
    if (client.closing) { await dispose(client); throw new DOMException("Aborted", "AbortError"); }
    return client.session;
  };
  const ensureSession = async (client: Client, discardConversation = false, signal?: AbortSignal): Promise<ChatSession> => {
    assertConnected(client);
    if (client.session && !client.session.isClosed) return client.session;
    const targetId = client.recoveryId;
    if (!discardConversation && (!targetId || !provider.resumeConversation)) throw recoveryRequired();
    const session = await createSession(client, signal);
    try {
      if (discardConversation) await provider.open(session.page);
      else {
        await provider.resumeConversation!(session.page, targetId!);
        if (!await session.isLoggedIn()) throw new NotLoggedInError(provider.name);
        if (provider.getConversationId?.(session.page) !== targetId) throw recoveryRequired();
      }
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      client.needsRecovery = false;
      return session;
    } catch (error) {
      // A timed-out restore may finish after the next turn has started.
      // It must never retire that newer page or overwrite its recovery state.
      if (client.session === session) {
        await retirePage(client, false);
        client.recoveryId = discardConversation ? undefined : targetId;
      }
      throw error;
    }
  };
  const perform = async (client: Client, request: { id: number; method: string; args?: Record<string, unknown> }) => {
    const { id, method } = request;
    const args = request.args ?? {};
    if (method === "close") {
      await dispose(client);
      send(client, { id, result: null });
      return;
    }
    if (client.closing) assertConnected(client);
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
          const session = await createSession(client);
          try {
            if (args.autoOpen !== false) await provider.open(session.page);
            client.opened = true;
            return { userDataDir: session.userDataDir };
          } catch (error) { await dispose(client); throw error; }
        }, { signal: controller.signal });
      } else if (method === "send" || method === "newChat") {
        result = await queue.run(async () => {
          try {
            const timeoutMs = typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs) && args.timeoutMs > 0
              ? args.timeoutMs : 180_000;
            const result = await withTurnDeadline(async () => {
              const session = await ensureSession(client, method === "newChat" || args.newChat === true, controller.signal);
              if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
              await session.page.bringToFront();
              if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
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
            // Update logical state only after success, never from a late result
            // of an operation that already timed out or was cancelled.
            if (method === "newChat") {
              client.turnCounter = 0;
              client.recoveryId = undefined;
            } else {
              const turn = result as SendResult;
              if (args.newChat === true) client.turnCounter = 0;
              turn.turnIndex = client.turnCounter++;
              client.recoveryId = turn.conversationId;
            }
            return result;
          } catch (error) {
            await retirePage(client, method === "send" && args.newChat !== true);
            throw error;
          }
        }, {
          signal: controller.signal,
          onPosition: (position) => send(client, { id, type: "queue", position }),
        });
      } else if (method === "isLoggedIn") {
        result = client.session && !client.needsRecovery
          ? await client.session.isLoggedIn()
          : await queue.run(async () => (await ensureSession(client)).isLoggedIn(), { signal: controller.signal });
      } else if (method === "diagnose") {
        result = client.session && !client.needsRecovery
          ? await client.session.diagnose()
          : await queue.run(async () => (await ensureSession(client)).diagnose(), { signal: controller.signal });
      } else if (method === "snapshot") {
        result = client.session && !client.needsRecovery
          ? await client.session.snapshot()
          : await queue.run(async () => (await ensureSession(client)).snapshot(), { signal: controller.signal });
      } else {
        throw new Error(`Unknown chat-web broker method: ${method}`);
      }
      send(client, { id, result });
    } finally { client.jobs.delete(id); }
  };
  const server = net.createServer((socket) => {
    if (stopping) { socket.destroy(); return; }
    if (idleTimer) clearTimeout(idleTimer);
    const client: Client = { socket, opening: false, opened: false, closing: false, needsRecovery: false, turnCounter: 0, jobs: new Map() };
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
