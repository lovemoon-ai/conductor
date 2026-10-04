import { createServer } from "http";
import type { AddressInfo } from "net";
import { gunzipSync, gzipSync } from "zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";

import { openVolcAsrStream, readAsrResult } from "./volc-asr";
import {
  MsgType,
  TtsEvent,
  decodeVolcFrame,
  encodeAsrAudio,
  encodeAsrFullRequest,
  encodeTtsEvent,
  volcSpeechAuthHeaders,
} from "./volc-protocol";
import { prewarmVolcTts, resetVolcTtsPool, synthesizeVolcSpeech } from "./volc-tts";

// Server-side frame builders, mirroring what openspeech.bytedance.com sends.
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};
const i32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
};
const sized = (b: Buffer) => Buffer.concat([u32(b.length), b]);
const asrServerResult = (seq: number, json: unknown, last = false) => Buffer.concat([
  Buffer.from([0x11, (MsgType.FullServerResponse << 4) | (last ? 0b0011 : 0b0001), 0x11, 0]),
  i32(last ? -seq : seq),
  sized(gzipSync(Buffer.from(JSON.stringify(json)))),
]);
const ttsServerEvent = (event: number, id: string, json: unknown = {}) => Buffer.concat([
  Buffer.from([0x11, (MsgType.FullServerResponse << 4) | 0b0100, 0x10, 0]),
  i32(event),
  sized(Buffer.from(id)),
  sized(Buffer.from(JSON.stringify(json))),
]);
const ttsServerAudio = (sessionId: string, audio: Buffer) => Buffer.concat([
  Buffer.from([0x11, (MsgType.AudioOnlyServer << 4) | 0b0100, 0x00, 0]),
  i32(TtsEvent.TtsResponse),
  sized(Buffer.from(sessionId)),
  sized(audio),
]);

describe("volc speech protocol", () => {
  it("round-trips ASR request frames", () => {
    const full = decodeVolcFrame(encodeAsrFullRequest(1, { a: 1 }));
    expect(full).toMatchObject({ type: MsgType.FullClientRequest, sequence: 1, json: { a: 1 }, isLast: false });

    const last = decodeVolcFrame(encodeAsrAudio(7, Buffer.from([1, 2, 3, 4]), true));
    expect(last).toMatchObject({ type: MsgType.AudioOnlyClient, sequence: -7, isLast: true });
    expect([...last.payload]).toEqual([1, 2, 3, 4]);
  });

  it("frames TTS session events with the session id, connection events without", () => {
    const session = decodeVolcFrame(encodeTtsEvent(TtsEvent.StartSession, { x: 1 }, "sid-1"));
    expect(session).toMatchObject({ event: TtsEvent.StartSession, sessionId: "sid-1", json: { x: 1 } });
    const connection = decodeVolcFrame(encodeTtsEvent(TtsEvent.StartConnection, {}, "ignored"));
    expect(connection).toMatchObject({ event: TtsEvent.StartConnection, json: {} });
    expect(connection.sessionId).toBeUndefined();
  });

  it("decodes server error frames", () => {
    const frame = decodeVolcFrame(Buffer.concat([
      Buffer.from([0x11, 0xf0, 0x10, 0]),
      u32(45000001),
      sized(Buffer.from('{"error":"bad"}')),
    ]));
    expect(frame).toMatchObject({ type: MsgType.Error, errorCode: 45000001, json: { error: "bad" } });
  });

  it("reads cumulative ASR text and the endpoint flag", () => {
    expect(readAsrResult({ result: { text: "你好", utterances: [{ text: "你好", definite: false }] } }))
      .toEqual({ text: "你好", endpoint: false });
    expect(readAsrResult({ result: { text: "你好。", utterances: [{ text: "你好。", definite: true }] } }))
      .toEqual({ text: "你好。", endpoint: true });
    expect(readAsrResult({})).toEqual({ text: "", endpoint: false });
  });

  it("supports API-key and app-id/token auth", () => {
    expect(volcSpeechAuthHeaders({ VOLC_SPEECH_API_KEY: "k" })).toEqual({ "X-Api-Key": "k" });
    expect(volcSpeechAuthHeaders({ VOLC_SPEECH_APP_ID: "a", VOLC_SPEECH_ACCESS_TOKEN: "t" }))
      .toEqual({ "X-Api-App-Key": "a", "X-Api-Access-Key": "t" });
    expect(volcSpeechAuthHeaders({})).toBeNull();
  });
});

describe("volc speech clients against a fake openspeech server", () => {
  let server: WebSocketServer;
  let url: string;
  let onConnection: (socket: ServerSocket, headers: Record<string, unknown>) => void;

  beforeEach(async () => {
    server = new WebSocketServer({ port: 0 });
    server.on("connection", (socket, req) => onConnection(socket, req.headers));
    await new Promise((resolve) => server.once("listening", resolve));
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
    vi.stubEnv("VOLC_SPEECH_API_KEY", "key-1");
  });

  afterEach(async () => {
    resetVolcTtsPool();
    vi.unstubAllEnvs();
    await new Promise((resolve) => server.close(resolve));
  });

  it("streams audio to ASR and resolves the final transcript", async () => {
    vi.stubEnv("VOLC_ASR_URL", url);
    const received: ReturnType<typeof decodeVolcFrame>[] = [];
    let headers: Record<string, unknown> = {};
    onConnection = (socket, h) => {
      headers = h;
      socket.on("message", (raw: Buffer) => {
        const frame = decodeVolcFrame(raw);
        received.push(frame);
        if (frame.type === MsgType.AudioOnlyClient && !frame.isLast) {
          socket.send(asrServerResult(frame.sequence!, {
            result: { text: "打开", utterances: [{ text: "打开", definite: false }] },
          }));
        }
        if (frame.isLast) {
          socket.send(asrServerResult(frame.sequence!, {
            result: { text: "打开设置。", utterances: [{ text: "打开设置。", definite: true }] },
          }, true));
        }
      });
    };

    const partials: Array<[string, boolean]> = [];
    const stream = openVolcAsrStream({
      sampleRate: 16_000,
      userId: "u1",
      onPartial: (text, endpoint) => partials.push([text, endpoint]),
      onError: (message) => { throw new Error(message); },
    });
    stream.sendAudio(Buffer.alloc(3200));
    await vi.waitFor(() => expect(partials).toEqual([["打开", false]]));
    await expect(stream.finish()).resolves.toBe("打开设置。");

    expect(headers["x-api-key"]).toBe("key-1");
    expect(headers["x-api-resource-id"]).toBe("volc.seedasr.sauc.duration");
    expect(received[0]).toMatchObject({ type: MsgType.FullClientRequest, sequence: 1 });
    expect(received[0].json).toMatchObject({
      audio: { format: "pcm", rate: 16_000, bits: 16, channel: 1 },
      request: { model_name: "bigmodel", show_utterances: true, end_window_size: 800 },
    });
    expect(received[1]).toMatchObject({ type: MsgType.AudioOnlyClient, sequence: 2 });
    expect(gunzipSync(gzipSync(received[1].payload)).length).toBe(3200);
    expect(received[2]).toMatchObject({ sequence: -3, isLast: true });
  });

  it("reports ASR upstream errors", async () => {
    vi.stubEnv("VOLC_ASR_URL", url);
    onConnection = (socket) => {
      socket.once("message", () => socket.send(Buffer.concat([
        Buffer.from([0x11, 0xf0, 0x10, 0]),
        u32(45000081),
        sized(Buffer.from("quota exceeded")),
      ])));
    };
    const errors: string[] = [];
    const stream = openVolcAsrStream({ sampleRate: 16_000, userId: "u1", onPartial: () => {}, onError: (m) => errors.push(m) });
    await vi.waitFor(() => expect(errors[0]).toMatch(/45000081.*quota exceeded/));
    await expect(stream.finish()).resolves.toBe("");
  });

  it("reports an ASR failure when upstream hangs up before the final result", async () => {
    vi.stubEnv("VOLC_ASR_URL", url);
    onConnection = (socket) => {
      socket.on("message", (raw: Buffer) => {
        const frame = decodeVolcFrame(raw);
        if (frame.type !== MsgType.AudioOnlyClient) return;
        socket.send(asrServerResult(frame.sequence!, { result: { text: "帮我把", utterances: [] } }));
        setTimeout(() => socket.close(), 10);
      });
    };
    const errors: string[] = [];
    const partials: string[] = [];
    const stream = openVolcAsrStream({
      sampleRate: 16_000, userId: "u1", onPartial: (text) => partials.push(text), onError: (m) => errors.push(m),
    });
    stream.sendAudio(Buffer.alloc(3200));
    await vi.waitFor(() => expect(errors).toEqual(["volc asr connection closed early"]));
    expect(partials).toEqual(["帮我把"]);
    // finish() only yields the partial text; the caller must treat it as failed.
    await expect(stream.finish()).resolves.toBe("帮我把");
  });

  it("fails TTS fast, with a bounded number of dials, when every handshake is rejected", async () => {
    let dials = 0;
    const rejecting = createServer();
    rejecting.on("upgrade", (_req, socket) => {
      dials += 1;
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
    });
    await new Promise<void>((resolve) => rejecting.listen(0, "127.0.0.1", resolve));
    vi.stubEnv("VOLC_TTS_URL", `ws://127.0.0.1:${(rejecting.address() as AddressInfo).port}`);
    try {
      const started = Date.now();
      await expect(synth("你好")).rejects.toThrow(/HTTP 401/);
      // A second request right after: no spares re-dialed (failure backoff), one fresh try.
      await expect(synth("再来")).rejects.toThrow(/HTTP 401/);
      expect(Date.now() - started).toBeLessThan(3_000);
      await new Promise((resolve) => setTimeout(resolve, 200)); // nothing keeps dialing in the background
      expect(dials).toBeLessThanOrEqual(5);
    } finally {
      await new Promise((resolve) => rejecting.close(resolve));
    }
  });

  /** Fake TTS upstream: logs (socket, event) in arrival order; one session at a time per socket. */
  const fakeTts = (opts: { failSession?: string; holdAudio?: boolean } = {}) => {
    const log: Array<{ socket: number; event?: number; json?: unknown }> = [];
    let sockets = 0;
    onConnection = (socket) => {
      const id = ++sockets;
      socket.on("message", (raw: Buffer) => {
        const frame = decodeVolcFrame(raw);
        log.push({ socket: id, event: frame.event, json: frame.json });
        if (frame.event === TtsEvent.StartConnection) socket.send(ttsServerEvent(TtsEvent.ConnectionStarted, "c1"));
        if (frame.event === TtsEvent.StartSession) {
          if (opts.failSession) {
            socket.send(ttsServerEvent(TtsEvent.SessionFailed, frame.sessionId!, { error: opts.failSession }));
            return;
          }
          socket.send(ttsServerEvent(TtsEvent.SessionStarted, frame.sessionId!));
        }
        if (frame.event === TtsEvent.FinishSession) {
          socket.send(ttsServerAudio(frame.sessionId!, Buffer.from([1, 2])));
          if (opts.holdAudio) return;
          socket.send(ttsServerAudio(frame.sessionId!, Buffer.from([3, 4])));
          socket.send(ttsServerEvent(TtsEvent.SessionFinished, frame.sessionId!));
        }
      });
    };
    const sessionsOf = (socket: number) => log.filter((e) => e.socket === socket && e.event === TtsEvent.StartSession).length;
    return { log, sessionsOf, socketCount: () => sockets };
  };
  const synth = async (text: string, signal?: AbortSignal) => {
    const chunks: number[] = [];
    for await (const chunk of synthesizeVolcSpeech({ text, format: "pcm", sampleRate: 24_000, userId: "u1", signal })) {
      chunks.push(...chunk);
    }
    return chunks;
  };

  it("runs the bidirectional TTS handshake and yields audio chunks", async () => {
    vi.stubEnv("VOLC_TTS_URL", url);
    const fake = fakeTts();
    expect(await synth("你好")).toEqual([1, 2, 3, 4]);
    const session = fake.log.find((e) => e.event === TtsEvent.StartSession)!.socket;
    expect(fake.log.filter((e) => e.socket === session).map((e) => e.event)).toEqual([
      TtsEvent.StartConnection, TtsEvent.StartSession, TtsEvent.TaskRequest, TtsEvent.FinishSession,
    ]);
    expect(fake.log.find((e) => e.event === TtsEvent.TaskRequest)!.json).toMatchObject({
      namespace: "BidirectionalTTS",
      req_params: { text: "你好", speaker: "zh_female_vv_uranus_bigtts", audio_params: { format: "pcm", sample_rate: 24_000 } },
    });
  });

  it("reuses ready connections: later replies skip the connection handshake", async () => {
    vi.stubEnv("VOLC_TTS_URL", url);
    const fake = fakeTts();
    await synth("一");
    await vi.waitFor(() => expect(fake.log.filter((e) => e.event === TtsEvent.StartConnection)).toHaveLength(3));
    const before = fake.log.length;
    expect(await synth("二")).toEqual([1, 2, 3, 4]);
    const after = fake.log.slice(before);
    // The second session went out on an already-started socket, no new handshake first.
    const firstSession = after.find((e) => e.event === TtsEvent.StartSession)!;
    expect(fake.log.slice(0, before).some((e) => e.socket === firstSession.socket && e.event === TtsEvent.StartConnection)).toBe(true);
    expect(after.indexOf(firstSession)).toBe(0);
    // Sequential sessions on one socket.
    expect(await synth("三")).toEqual([1, 2, 3, 4]);
    expect(Math.max(...Array.from({ length: fake.socketCount() }, (_, i) => fake.sessionsOf(i + 1)))).toBeGreaterThanOrEqual(2);
  });

  it("prewarms connections before any synthesis", async () => {
    vi.stubEnv("VOLC_TTS_URL", url);
    const fake = fakeTts();
    prewarmVolcTts();
    await vi.waitFor(() => expect(fake.log.filter((e) => e.event === TtsEvent.StartConnection)).toHaveLength(2));
    const before = fake.log.length;
    await synth("你好");
    expect(fake.log[before].event).toBe(TtsEvent.StartSession);
  });

  it("does not reuse a connection whose session was aborted", async () => {
    vi.stubEnv("VOLC_TTS_URL", url);
    const fake = fakeTts({ holdAudio: true });
    const controller = new AbortController();
    const chunks: number[] = [];
    const run = (async () => {
      for await (const chunk of synthesizeVolcSpeech({ text: "长", format: "pcm", sampleRate: 24_000, userId: "u1", signal: controller.signal })) {
        chunks.push(...chunk);
        controller.abort();
      }
    })();
    await expect(run).rejects.toThrow(/aborted/);
    const aborted = fake.log.find((e) => e.event === TtsEvent.StartSession)!.socket;
    await vi.waitFor(() => expect(fake.log.some((e) => e.socket === aborted && e.event === TtsEvent.FinishConnection)).toBe(true));
  });

  it("times TTS out on upstream silence, not on total length", async () => {
    vi.stubEnv("VOLC_TTS_URL", url);
    vi.stubEnv("VOLC_TTS_INACTIVITY_TIMEOUT_MS", "150");
    let silentAfter = Infinity;
    onConnection = (socket) => {
      socket.on("message", (raw: Buffer) => {
        const frame = decodeVolcFrame(raw);
        if (frame.event === TtsEvent.StartConnection) socket.send(ttsServerEvent(TtsEvent.ConnectionStarted, "c1"));
        if (frame.event === TtsEvent.StartSession) socket.send(ttsServerEvent(TtsEvent.SessionStarted, frame.sessionId!));
        if (frame.event !== TtsEvent.FinishSession) return;
        // 8 chunks 60ms apart: ~480ms in total, longer than the 150ms timeout.
        let sent = 0;
        const drip = setInterval(() => {
          if (sent >= silentAfter) return clearInterval(drip); // then go quiet
          socket.send(ttsServerAudio(frame.sessionId!, Buffer.from([sent])));
          sent += 1;
          if (sent === 8) {
            clearInterval(drip);
            socket.send(ttsServerEvent(TtsEvent.SessionFinished, frame.sessionId!));
          }
        }, 60);
      });
    };
    expect(await synth("很长的一段")).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    silentAfter = 2;
    resetVolcTtsPool();
    await expect(synth("卡住")).rejects.toThrow(/timed out/);
  });

  it("throws when the TTS session fails", async () => {
    vi.stubEnv("VOLC_TTS_URL", url);
    onConnection = (socket) => {
      socket.on("message", (raw: Buffer) => {
        const frame = decodeVolcFrame(raw);
        if (frame.event === TtsEvent.StartConnection) socket.send(ttsServerEvent(TtsEvent.ConnectionStarted, "c1"));
        if (frame.event === TtsEvent.StartSession) {
          socket.send(ttsServerEvent(TtsEvent.SessionFailed, frame.sessionId!, { error: "speaker not granted" }));
        }
      });
    };
    const run = async () => {
      for await (const chunk of synthesizeVolcSpeech({ text: "hi", format: "mp3", sampleRate: 24_000, userId: "u1" })) {
        void chunk;
      }
    };
    await expect(run()).rejects.toThrow(/speaker not granted/);
  });
});
