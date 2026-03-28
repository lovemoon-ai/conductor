import { ConductorConfig } from '../config/index.js';

export type WebSocketHandler = (payload: Record<string, any>) => Promise<void> | void;

export interface WebSocketCloseInfo {
  code?: number | null;
  reason?: string | null;
}

export interface WebSocketLike {
  send(data: string): Promise<void> | void;
  ping(): Promise<void> | void;
  close(): Promise<void> | void;
  terminate?(): Promise<void> | void;
  onPong?(handler: () => void): void;
  onCloseInfo?(handler: (info: WebSocketCloseInfo) => void): void;
  onErrorInfo?(handler: (error: unknown) => void): void;
  closed?: boolean;
  [Symbol.asyncIterator](): AsyncIterableIterator<string>;
}

export interface ConnectOptions {
  headers: Record<string, string>;
}

export type ConnectImpl = (url: string, options: ConnectOptions) => Promise<WebSocketLike>;

export interface WebSocketConnectedEvent {
  isReconnect: boolean;
  connectedAt: number;
}

export interface WebSocketPongEvent {
  at: number;
  latencyMs: number | null;
}

export interface WebSocketDisconnectEvent {
  reason: string;
  disconnectedAt: number;
  connectedAt: number | null;
  closeCode: number | null;
  closeReason: string | null;
  socketError: string | null;
  missedPongs: number;
  lastPingAt: number | null;
  lastPongAt: number | null;
  lastMessageAt: number | null;
}

export interface WebSocketClientOptions {
  reconnectDelay?: number;
  heartbeatInterval?: number;
  extraHeaders?: Record<string, string>;
  connectImpl?: ConnectImpl;
  hostName?: string;
  onConnected?: (event: WebSocketConnectedEvent) => void;
  onDisconnected?: (event: WebSocketDisconnectEvent) => void;
  onPong?: (event: WebSocketPongEvent) => void;
  onReconnected?: () => void;
}

type ConnectionRuntime = {
  conn: WebSocketLike;
  connectedAt: number;
  supportsPongTracking: boolean;
  lastMessageAt: number | null;
  lastPingAt: number | null;
  lastPongAt: number | null;
  waitingForPong: boolean;
  missedPongs: number;
  disconnectReason: string | null;
  closeCode: number | null;
  closeReason: string | null;
  socketError: string | null;
};

class AsyncLock {
  private tail = Promise.resolve();

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run
      .then(() => undefined)
      .catch(() => undefined);
    return run;
  }
}

export class ConductorWebSocketClient {
  private readonly url: string;
  private readonly token: string;
  private readonly reconnectDelay: number;
  private readonly heartbeatInterval: number;
  private readonly connectImpl: ConnectImpl;
  private readonly onConnected?: (event: WebSocketConnectedEvent) => void;
  private readonly onDisconnected?: (event: WebSocketDisconnectEvent) => void;
  private readonly onPong?: (event: WebSocketPongEvent) => void;
  private readonly onReconnected?: () => void;
  private readonly handlers: WebSocketHandler[] = [];
  private extraHeaders: Record<string, string>;
  private conn: WebSocketLike | null = null;
  private runtime: ConnectionRuntime | null = null;
  private stop = false;
  private listenTask: Promise<void> | null = null;
  private heartbeatTask: Promise<void> | null = null;
  private readonly lock = new AsyncLock();
  private waitController: AbortController = new AbortController();
  private hasConnectedAtLeastOnce = false;

  constructor(
    config: ConductorConfig,
    options: WebSocketClientOptions = {},
  ) {
    this.url = config.resolvedWebsocketUrl;
    this.token = config.agentToken;
    this.reconnectDelay = options.reconnectDelay ?? 10_000;
    this.heartbeatInterval = options.heartbeatInterval ?? 20_000;
    this.extraHeaders = {
      'x-conductor-host': options.hostName ?? defaultHostName(),
      ...(options.extraHeaders ?? {}),
    };
    this.connectImpl = options.connectImpl ?? defaultConnectImpl;
    this.onConnected = options.onConnected;
    this.onDisconnected = options.onDisconnected;
    this.onPong = options.onPong;
    this.onReconnected = options.onReconnected;
  }

  registerHandler(handler: WebSocketHandler): void {
    this.handlers.push(handler);
  }

  setExtraHeaders(extraHeaders: Record<string, string> = {}): void {
    this.extraHeaders = {
      'x-conductor-host': this.extraHeaders['x-conductor-host'] || defaultHostName(),
      ...extraHeaders,
    };
  }

  async connect(): Promise<void> {
    this.stop = false;
    if (this.waitController.signal.aborted) {
      this.waitController = new AbortController();
    }
    await this.openConnection(true);
  }

  async disconnect(): Promise<void> {
    this.stop = true;
    this.waitController.abort();
    if (this.listenTask) {
      this.listenTask = null;
    }
    if (this.heartbeatTask) {
      this.heartbeatTask = null;
    }
    if (this.conn && !this.isConnectionClosed(this.conn)) {
      this.markDisconnectReason(this.conn, 'manual_disconnect');
      await this.closeConnection(this.conn);
    }
    this.conn = null;
    this.runtime = null;
  }

  async forceReconnect(reason = 'manual_reconnect'): Promise<void> {
    const conn = this.conn;
    if (!conn || this.isConnectionClosed(conn)) {
      await this.openConnection(true);
      return;
    }
    this.markDisconnectReason(conn, reason);
    await this.terminateConnection(conn);
  }

  async sendJson(payload: Record<string, any>): Promise<void> {
    await this.ensureConnection();
    await this.sendWithReconnect(JSON.stringify(payload));
  }

  private async ensureConnection(): Promise<void> {
    if (this.conn && !this.isConnectionClosed(this.conn)) {
      return;
    }
    await this.openConnection(true);
  }

  private async openConnection(force = false): Promise<void> {
    await this.lock.runExclusive(async () => {
      if (this.conn && !this.isConnectionClosed(this.conn) && !force) {
        return;
      }
      await this.cancelTasks();
      while (!this.stop) {
        try {
          const headers = { Authorization: `Bearer ${this.token}`, ...this.extraHeaders };
          const conn = await this.connectImpl(this.url, { headers });
          const runtime = this.createRuntime(conn);
          this.attachConnectionObservers(runtime);
          this.conn = conn;
          this.runtime = runtime;
          const isReconnect = this.hasConnectedAtLeastOnce;
          this.hasConnectedAtLeastOnce = true;
          this.notifyConnected({ isReconnect, connectedAt: runtime.connectedAt });
          if (isReconnect) {
            this.notifyReconnected();
          }
          this.listenTask = this.listenLoop(conn);
          this.heartbeatTask = this.heartbeatLoop(conn);
          return;
        } catch (error) {
          if (force) {
            console.warn(`[${formatBeijingTimestamp()}] [WebSocket] Connection failed, retrying in ${this.reconnectDelay}ms... (${error instanceof Error ? error.message : String(error)})`);
          }
          await wait(this.reconnectDelay, this.waitController.signal);
        }
      }
    });
  }

  private async cancelTasks(): Promise<void> {
    this.listenTask = null;
    this.heartbeatTask = null;
  }

  private async listenLoop(conn: WebSocketLike): Promise<void> {
    try {
      for await (const message of conn) {
        await this.dispatch(message);
      }
    } catch {
      // Ignore errors; reconnection logic handles it.
    } finally {
      await this.handleConnectionLoss(conn);
    }
  }

  private async heartbeatLoop(conn: WebSocketLike): Promise<void> {
    try {
      while (!this.stop && !this.isConnectionClosed(conn)) {
        await wait(this.heartbeatInterval, this.waitController.signal);
        if (this.stop || conn !== this.conn) {
          return;
        }
        const runtime = this.getRuntime(conn);
        if (!runtime) {
          return;
        }
        if (runtime.supportsPongTracking && runtime.waitingForPong) {
          runtime.missedPongs += 1;
          runtime.disconnectReason = 'pong_timeout';
          await this.terminateConnection(conn);
          break;
        }
        runtime.lastPingAt = Date.now();
        runtime.waitingForPong = runtime.supportsPongTracking;
        try {
          await conn.ping();
        } catch {
          this.markDisconnectReason(conn, 'ping_failed');
          break;
        }
      }
    } finally {
      await this.handleConnectionLoss(conn);
    }
  }

  private async handleConnectionLoss(conn: WebSocketLike): Promise<void> {
    if (this.stop || conn !== this.conn) {
      return;
    }
    const runtime = this.getRuntime(conn);
    this.conn = null;
    this.runtime = null;
    this.notifyDisconnected(this.buildDisconnectEvent(runtime));
    await this.openConnection(true);
  }

  private async dispatch(message: string): Promise<void> {
    const now = Date.now();
    if (this.runtime) {
      this.runtime.lastMessageAt = now;
    }
    let payload: Record<string, any>;
    try {
      payload = JSON.parse(message);
    } catch {
      return;
    }
    for (const handler of this.handlers) {
      const result = handler(payload);
      if (result && typeof (result as Promise<void>).then === 'function') {
        await result;
      }
    }
  }

  private notifyConnected(event: WebSocketConnectedEvent): void {
    if (!this.onConnected) {
      return;
    }
    try {
      this.onConnected(event);
    } catch {
      // Swallow callback errors to avoid impacting reconnect behavior.
    }
  }

  private notifyReconnected(): void {
    if (!this.onReconnected) {
      return;
    }
    try {
      this.onReconnected();
    } catch {
      // Swallow callback errors to avoid impacting reconnect behavior.
    }
  }

  private notifyDisconnected(event: WebSocketDisconnectEvent): void {
    if (!this.onDisconnected) {
      return;
    }
    try {
      this.onDisconnected(event);
    } catch {
      // Swallow callback errors to avoid impacting reconnect behavior.
    }
  }

  private isConnectionClosed(conn: WebSocketLike | null): boolean {
    if (!conn) {
      return true;
    }
    if (typeof conn.closed === 'boolean') {
      return conn.closed;
    }
    return false;
  }

  private async sendWithReconnect(data: string): Promise<void> {
    let attemptedReconnect = false;
    // Loop at most twice: initial send, then one reconnect + retry
    while (true) {
      const conn = this.conn;
      if (!conn || this.isConnectionClosed(conn)) {
        await this.openConnection(true);
      }
      if (!this.conn || this.isConnectionClosed(this.conn)) {
        throw new Error('WebSocket not connected');
      }
      try {
        await this.conn.send(data);
        return;
      } catch (error) {
        if (attemptedReconnect || !this.isNotOpenError(error)) {
          throw error instanceof Error ? error : new Error(String(error));
        }
        attemptedReconnect = true;
        if (this.conn === conn) {
          this.markDisconnectReason(conn, 'send_reconnect');
          this.conn = null;
          this.notifyDisconnected(this.buildDisconnectEvent(this.getRuntime(conn)));
          this.runtime = null;
        }
        await this.openConnection(true);
      }
    }
  }

  private isNotOpenError(error: unknown): boolean {
    if (!error) return false;
    const message = error instanceof Error ? error.message : String(error);
    return message.toLowerCase().includes('websocket is not open');
  }

  private createRuntime(conn: WebSocketLike): ConnectionRuntime {
    const connectedAt = Date.now();
    return {
      conn,
      connectedAt,
      supportsPongTracking: typeof conn.onPong === 'function',
      lastMessageAt: null,
      lastPingAt: null,
      lastPongAt: connectedAt,
      waitingForPong: false,
      missedPongs: 0,
      disconnectReason: null,
      closeCode: null,
      closeReason: null,
      socketError: null,
    };
  }

  private attachConnectionObservers(runtime: ConnectionRuntime): void {
    runtime.conn.onPong?.(() => {
      const activeRuntime = this.getRuntime(runtime.conn);
      if (!activeRuntime) {
        return;
      }
      const at = Date.now();
      const latencyMs = activeRuntime.lastPingAt ? at - activeRuntime.lastPingAt : null;
      activeRuntime.lastPongAt = at;
      activeRuntime.waitingForPong = false;
      activeRuntime.missedPongs = 0;
      if (this.onPong) {
        try {
          this.onPong({ at, latencyMs });
        } catch {
          // Swallow callback errors to avoid impacting reconnect behavior.
        }
      }
    });
    runtime.conn.onCloseInfo?.((info) => {
      const activeRuntime = this.getRuntime(runtime.conn);
      if (!activeRuntime) {
        return;
      }
      activeRuntime.closeCode = typeof info.code === 'number' ? info.code : null;
      activeRuntime.closeReason = normalizeOptionalString(info.reason);
    });
    runtime.conn.onErrorInfo?.((error) => {
      const activeRuntime = this.getRuntime(runtime.conn);
      if (!activeRuntime) {
        return;
      }
      activeRuntime.socketError = error instanceof Error ? error.message : String(error);
      if (!activeRuntime.disconnectReason) {
        activeRuntime.disconnectReason = 'socket_error';
      }
    });
  }

  private getRuntime(conn: WebSocketLike): ConnectionRuntime | null {
    if (!this.runtime || this.runtime.conn !== conn) {
      return null;
    }
    return this.runtime;
  }

  private markDisconnectReason(conn: WebSocketLike, reason: string): void {
    const runtime = this.getRuntime(conn);
    if (runtime && !runtime.disconnectReason) {
      runtime.disconnectReason = reason;
    }
  }

  private buildDisconnectEvent(runtime: ConnectionRuntime | null): WebSocketDisconnectEvent {
    return {
      reason: runtime?.disconnectReason || 'connection_lost',
      disconnectedAt: Date.now(),
      connectedAt: runtime?.connectedAt ?? null,
      closeCode: runtime?.closeCode ?? null,
      closeReason: runtime?.closeReason ?? null,
      socketError: runtime?.socketError ?? null,
      missedPongs: runtime?.missedPongs ?? 0,
      lastPingAt: runtime?.lastPingAt ?? null,
      lastPongAt: runtime?.lastPongAt ?? null,
      lastMessageAt: runtime?.lastMessageAt ?? null,
    };
  }

  private async closeConnection(conn: WebSocketLike): Promise<void> {
    if (typeof conn.close === 'function') {
      await conn.close();
    }
  }

  private async terminateConnection(conn: WebSocketLike): Promise<void> {
    if (typeof conn.terminate === 'function') {
      await conn.terminate();
      return;
    }
    await this.closeConnection(conn);
  }
}

async function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return;
  }
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function formatBeijingTimestamp(date = new Date()): string {
  return date.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false }).replace(' ', 'T');
}

async function defaultConnectImpl(url: string, options: ConnectOptions): Promise<WebSocketLike> {
  const { default: WebSocket } = await import('ws');
  return new Promise<WebSocketLike>((resolve, reject) => {
    const ws = new WebSocket(url, {
      headers: options.headers,
      perMessageDeflate: false,
    });
    ws.once('open', () => resolve(new WsAdapter(ws)));
    ws.once('error', (err) => reject(err));
  });
}

type WebSocketModule = typeof import('ws');
type NodeWebSocket = InstanceType<WebSocketModule['default']>;

function defaultHostName(): string {
  const pid = process.pid;
  const host = process.env.HOSTNAME || process.env.COMPUTERNAME || 'unknown-host';
  return `conductor-fire-${host}-${pid}`;
}

class WsAdapter implements WebSocketLike {
  private readonly queue: (string | null)[] = [];
  private readonly waiters: Array<(value: string | null) => void> = [];
  private readonly pongHandlers = new Set<() => void>();
  private readonly closeInfoHandlers = new Set<(info: WebSocketCloseInfo) => void>();
  private readonly errorHandlers = new Set<(error: unknown) => void>();
  public closed = false;

  constructor(private readonly ws: NodeWebSocket) {
    ws.on('message', (data) => this.enqueue(data.toString()));
    ws.on('pong', () => {
      for (const handler of this.pongHandlers) {
        handler();
      }
    });
    ws.on('close', (code, reason) => {
      this.closed = true;
      const closeInfo = {
        code,
        reason: normalizeOptionalString(reason?.toString()),
      };
      for (const handler of this.closeInfoHandlers) {
        handler(closeInfo);
      }
      this.enqueue(null);
    });
    ws.on('error', (error) => {
      this.closed = true;
      for (const handler of this.errorHandlers) {
        handler(error);
      }
      this.enqueue(null);
    });
  }

  send(data: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.send(data, (error?: Error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  ping(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.ping(undefined, undefined, (error?: Error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.closed) {
        resolve();
        return;
      }
      this.ws.once('close', () => resolve());
      this.ws.close();
    });
  }

  terminate(): void {
    if (this.closed) {
      return;
    }
    this.ws.terminate();
  }

  onPong(handler: () => void): void {
    this.pongHandlers.add(handler);
  }

  onCloseInfo(handler: (info: WebSocketCloseInfo) => void): void {
    this.closeInfoHandlers.add(handler);
  }

  onErrorInfo(handler: (error: unknown) => void): void {
    this.errorHandlers.add(handler);
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<string> {
    while (true) {
      const value = await this.nextValue();
      if (value === null) {
        return;
      }
      yield value;
    }
  }

  private nextValue(): Promise<string | null> {
    if (this.queue.length) {
      const value = this.queue.shift() ?? null;
      return Promise.resolve(value);
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private enqueue(value: string | null): void {
    if (this.waiters.length) {
      const resolve = this.waiters.shift()!;
      resolve(value);
    } else {
      this.queue.push(value);
    }
  }
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}
