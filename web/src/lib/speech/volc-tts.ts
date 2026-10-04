import { randomUUID } from "crypto";
import { WebSocket } from "ws";

import {
  MsgType,
  TtsEvent,
  decodeVolcFrame,
  encodeTtsEvent,
  volcSpeechAuthHeaders,
  type VolcFrame,
} from "@/lib/speech/volc-protocol";

const DEFAULT_TTS_URL = "wss://openspeech.bytedance.com/api/v3/tts/bidirection";
const DEFAULT_TTS_RESOURCE_ID = "seed-tts-2.0";
const DEFAULT_TTS_SPEAKER = "zh_female_vv_uranus_bigtts";
/** Fail when upstream sends nothing for this long (reset on every frame, so long texts are fine). */
const DEFAULT_TTS_INACTIVITY_TIMEOUT_MS = 30_000;
const ttsInactivityTimeoutMs = () => {
  const parsed = Number.parseInt(process.env.VOLC_TTS_INACTIVITY_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTS_INACTIVITY_TIMEOUT_MS;
};
const CONNECT_TIMEOUT_MS = 10_000;
/** After a failed connect, do not dial spares for a while (bad key, upstream down). */
const CONNECT_FAILURE_BACKOFF_MS = 10_000;
/** Pooled sockets tried per request before one fresh dial; then give up. */
const MAX_POOLED_TRIES = 2;

/**
 * Connection pool. Opening a Doubao TTS socket (TLS + StartConnection) costs
 * ~0.3-0.6s, so ready connections are kept and reused: one connection runs
 * sessions back to back. Measured: idle connections survive >90s upstream;
 * we retire them sooner and open fresh ones while a voice conversation is
 * active (the "warm window").
 */
const IDLE_TTL_MS = 60_000;
const WARM_WINDOW_MS = 5 * 60_000;
/** Ready spares while warm: the web voice mode synthesizes up to 3 replies at once. */
const WARM_SPARES = 2;
const MAX_IDLE = 4;

export type TtsAudioFormat = "pcm" | "mp3";

const ttsTarget = () => {
  const auth = volcSpeechAuthHeaders();
  if (!auth) return null;
  const url = process.env.VOLC_TTS_URL?.trim() || DEFAULT_TTS_URL;
  const resourceId = process.env.VOLC_TTS_RESOURCE_ID?.trim() || DEFAULT_TTS_RESOURCE_ID;
  return { auth, url, resourceId, key: `${url}|${resourceId}|${JSON.stringify(auth)}` };
};

class TtsConnection {
  readonly socket: WebSocket;
  readonly ready: Promise<void>;
  readonly key: string;
  closed = false;
  readyAt = 0;
  idleTimer: ReturnType<typeof setTimeout> | null = null;
  handler: ((frame: VolcFrame) => void) | null = null;
  onClose: ((error: Error) => void) | null = null;
  private rejectReady: (error: Error) => void = () => {};
  private connectTimer: ReturnType<typeof setTimeout>;

  constructor(target: NonNullable<ReturnType<typeof ttsTarget>>) {
    this.key = target.key;
    let resolveReady: () => void = () => {};
    this.ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.ready.catch(() => {});
    this.connectTimer = setTimeout(() => this.fail(new Error("volc tts connect timed out")), CONNECT_TIMEOUT_MS);
    this.connectTimer.unref?.();

    this.socket = new WebSocket(target.url, {
      headers: { ...target.auth, "X-Api-Resource-Id": target.resourceId, "X-Api-Connect-Id": randomUUID() },
    });
    this.socket.on("open", () => this.socket.send(encodeTtsEvent(TtsEvent.StartConnection, {})));
    this.socket.on("message", (raw: Buffer) => {
      let frame: VolcFrame;
      try {
        frame = decodeVolcFrame(Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error("invalid tts frame"));
        return;
      }
      if (!this.readyAt) {
        if (frame.event === TtsEvent.ConnectionStarted) {
          clearTimeout(this.connectTimer);
          this.readyAt = Date.now();
          resolveReady();
        } else if (frame.type === MsgType.Error || frame.event === TtsEvent.ConnectionFailed) {
          this.fail(new Error(`volc tts connection failed: ${frame.payload.toString("utf8").slice(0, 200)}`));
        }
        return;
      }
      this.handler?.(frame);
    });
    this.socket.on("unexpected-response", (_req, res) => {
      this.fail(new Error(`volc tts handshake failed: HTTP ${res.statusCode}`));
    });
    this.socket.on("error", (error) => this.fail(error));
    this.socket.on("close", () => this.fail(new Error("volc tts connection closed")));
  }

  /** Upstream failure (vs. destroy() for local teardown): a failed connect pauses spare dialing. */
  private fail(error: Error) {
    if (!this.closed && !this.readyAt) pool.connectFailedAt = Date.now();
    this.destroy(error);
  }

  destroy(error: Error) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.connectTimer);
    const wasIdle = removeIdle(this);
    this.rejectReady(error);
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(encodeTtsEvent(TtsEvent.FinishConnection, {}));
      this.socket.close();
    } else if (this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.terminate();
    }
    this.onClose?.(error);
    // A healthy spare that aged out or was dropped upstream: replace it.
    // (Never re-dial straight after a failed connect: no hot retry loop.)
    if (wasIdle && this.readyAt) topUpPool();
  }
}

// On globalThis: server.ts (the /ws/speech prewarm) and the Next route bundle
// load separate copies of this module but must share one pool.
type TtsPool = { idle: TtsConnection[]; warmUntil: number; connectFailedAt: number };
const globalForTts = globalThis as unknown as { volcTtsPool?: TtsPool };
const pool = (globalForTts.volcTtsPool ??= { idle: [], warmUntil: 0, connectFailedAt: 0 });
pool.connectFailedAt ??= 0;
const idle = pool.idle;

function removeIdle(connection: TtsConnection): boolean {
  if (connection.idleTimer) clearTimeout(connection.idleTimer);
  connection.idleTimer = null;
  const index = idle.indexOf(connection);
  if (index < 0) return false;
  idle.splice(index, 1);
  return true;
}

function park(connection: TtsConnection) {
  connection.handler = null;
  connection.onClose = null;
  if (connection.closed) return;
  if (idle.length >= MAX_IDLE) {
    connection.destroy(new Error("volc tts pool full"));
    return;
  }
  idle.push(connection);
  connection.idleTimer = setTimeout(() => connection.destroy(new Error("volc tts idle")), IDLE_TTL_MS);
  connection.idleTimer.unref?.();
}

function dropStaleIdle(key: string) {
  for (const connection of [...idle]) {
    if (connection.key !== key) connection.destroy(new Error("volc tts config changed"));
  }
}

function topUpPool() {
  if (Date.now() >= pool.warmUntil) return;
  if (Date.now() - pool.connectFailedAt < CONNECT_FAILURE_BACKOFF_MS) return;
  const target = ttsTarget();
  if (!target) return;
  dropStaleIdle(target.key);
  while (idle.filter((connection) => !connection.closed).length < WARM_SPARES) {
    park(new TtsConnection(target));
  }
}

/**
 * Keep ready connections around for the next few minutes, e.g. as soon as
 * the user starts speaking in voice mode, so the reply's first audio skips
 * the connection setup.
 */
export function prewarmVolcTts(windowMs = WARM_WINDOW_MS) {
  pool.warmUntil = Math.max(pool.warmUntil, Date.now() + windowMs);
  topUpPool();
}

/** Tests only. */
export function resetVolcTtsPool() {
  pool.warmUntil = 0;
  for (const connection of [...idle]) connection.destroy(new Error("volc tts pool reset"));
  pool.connectFailedAt = 0;
}

/**
 * A ready connection: a pooled one when possible, else a fresh dial. Bounded:
 * at most MAX_POOLED_TRIES pooled sockets, then one fresh connect, then throw,
 * so a bad key or an unreachable upstream fails the request instead of
 * re-dialing in a loop.
 */
async function acquireConnection(signal: AbortSignal): Promise<TtsConnection> {
  const target = ttsTarget();
  if (!target) throw new Error("volc speech is not configured");
  dropStaleIdle(target.key);
  const aborted = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(new Error("aborted"));
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  aborted.catch(() => {});
  for (let pooledTries = 0; ; ) {
    // Prefer the most recently used ready socket; fall back to one still connecting.
    let pooled: TtsConnection | undefined;
    if (pooledTries < MAX_POOLED_TRIES && idle.length) {
      let index = -1;
      for (let i = idle.length - 1; i >= 0 && index < 0; i -= 1) if (idle[i].readyAt) index = i;
      pooled = idle[index >= 0 ? index : 0];
      pooledTries += 1;
      removeIdle(pooled);
    }
    const connection = pooled ?? new TtsConnection(target);
    try {
      await Promise.race([connection.ready, aborted]);
      if (connection.closed) throw new Error("volc tts connection closed");
      topUpPool(); // upstream is reachable: replace the spare we just took
      return connection;
    } catch (error) {
      if (signal.aborted) {
        if (pooled && !connection.closed) park(connection);
        else connection.destroy(new Error("aborted"));
        throw error;
      }
      connection.destroy(error instanceof Error ? error : new Error("volc tts connect failed"));
      // A pooled socket died while idle: try another / a fresh one. A fresh one failing is final.
      if (!pooled) throw error;
    }
  }
}

/**
 * Stream Doubao TTS audio for `text`. Yields audio chunks as the service
 * produces them, so playback can start on the first sentence.
 * `pcm` is 16-bit little-endian mono at `sampleRate`.
 */
export async function* synthesizeVolcSpeech(args: {
  text: string;
  format: TtsAudioFormat;
  sampleRate: number;
  userId: string;
  signal?: AbortSignal;
}): AsyncGenerator<Buffer> {
  if (!ttsTarget()) throw new Error("volc speech is not configured");
  // More replies usually follow; keep spares ready for them.
  prewarmVolcTts();

  const queue: Buffer[] = [];
  let done = false;
  let reusable = false;
  let failure: Error | null = null;
  let wake: (() => void) | null = null;
  const notify = () => {
    wake?.();
    wake = null;
  };
  const finish = (error?: Error) => {
    if (done) return;
    done = true;
    failure = error ?? null;
    notify();
  };
  // Cancels a pending connect too, on caller abort or timeout.
  const acquireAbort = new AbortController();
  const timeoutMs = ttsInactivityTimeoutMs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const armTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      finish(new Error("volc tts timed out"));
      acquireAbort.abort();
    }, timeoutMs);
  };
  armTimer();
  const onAbort = () => {
    finish(new Error("aborted"));
    acquireAbort.abort();
  };
  if (args.signal?.aborted) onAbort();
  args.signal?.addEventListener("abort", onAbort, { once: true });

  let connection: TtsConnection | null = null;
  try {
    try {
      connection = await acquireConnection(acquireAbort.signal);
    } catch (error) {
      throw failure ?? error;
    }
    const socket = connection.socket;
    const sessionId = randomUUID();
    const reqParams = {
      speaker: process.env.VOLC_TTS_SPEAKER?.trim() || DEFAULT_TTS_SPEAKER,
      audio_params: { format: args.format, sample_rate: args.sampleRate },
    };
    const envelope = (event: number, extra: Record<string, unknown> = {}) => ({
      user: { uid: args.userId },
      event,
      namespace: "BidirectionalTTS",
      ...extra,
    });

    connection.onClose = (error) => finish(error);
    connection.handler = (frame) => {
      armTimer();
      if (frame.type === MsgType.Error) {
        finish(new Error(`volc tts error ${frame.errorCode}: ${frame.payload.toString("utf8").slice(0, 200)}`));
        return;
      }
      if (frame.type === MsgType.AudioOnlyServer) {
        if (frame.payload.length > 0) {
          queue.push(frame.payload);
          notify();
        }
        return;
      }
      switch (frame.event) {
        case TtsEvent.SessionStarted:
          socket.send(encodeTtsEvent(
            TtsEvent.TaskRequest,
            envelope(TtsEvent.TaskRequest, { req_params: { ...reqParams, text: args.text } }),
            sessionId,
          ));
          socket.send(encodeTtsEvent(TtsEvent.FinishSession, {}, sessionId));
          return;
        case TtsEvent.SessionFinished:
          reusable = true;
          finish();
          return;
        case TtsEvent.SessionFailed:
        case TtsEvent.ConnectionFailed:
        case TtsEvent.ConnectionFinished:
          finish(new Error(`volc tts failed: ${frame.payload.toString("utf8").slice(0, 200)}`));
          return;
        default:
      }
    };
    socket.send(encodeTtsEvent(
      TtsEvent.StartSession,
      envelope(TtsEvent.StartSession, { req_params: reqParams }),
      sessionId,
    ));

    while (true) {
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      if (done) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    if (failure) throw failure;
  } finally {
    clearTimeout(timer);
    args.signal?.removeEventListener("abort", onAbort);
    if (connection) {
      // Only a cleanly finished session leaves the socket in a known state.
      if (reusable && !connection.closed) park(connection);
      else connection.destroy(new Error("volc tts session ended early"));
    }
  }
}
