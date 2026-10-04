import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { gzipSync } from "zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

import { setupSpeechGateway } from "./gateway";
import { resetSpeechTranscribeRateLimitsForTest } from "./rate-limit";
import { MsgType, decodeVolcFrame } from "./volc-protocol";

// Slow on purpose: the client sends `start` before auth resolves, like a real DB lookup.
vi.mock("@/lib/auth/service", () => ({
  authenticateToken: vi.fn(async (token: string) => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return token === "good" ? { id: "user-1" } : null;
  }),
}));
vi.mock("@/lib/daemon-share/scope", () => ({ isDaemonShareUser: () => false }));

const asrResult = (seq: number, text: string, definite: boolean, last = false) => {
  const head = Buffer.from([0x11, (MsgType.FullServerResponse << 4) | (last ? 0b0011 : 0b0001), 0x11, 0]);
  const seqBuf = Buffer.alloc(4);
  seqBuf.writeInt32BE(last ? -seq : seq);
  const payload = gzipSync(Buffer.from(JSON.stringify({ result: { text, utterances: [{ text, definite }] } })));
  const size = Buffer.alloc(4);
  size.writeUInt32BE(payload.length);
  return Buffer.concat([head, seqBuf, size, payload]);
};

describe("/ws/speech with Doubao streaming ASR", () => {
  let upstream: WebSocketServer;
  let app: Server;
  let gatewayUrl: string;
  let upstreamAudioBytes = 0;
  /** "drop": answer the first chunk with a partial, then hang up (network blip / upstream failure). */
  let upstreamMode: "ok" | "drop" = "ok";

  beforeEach(async () => {
    resetSpeechTranscribeRateLimitsForTest();
    upstreamAudioBytes = 0;
    upstreamMode = "ok";
    upstream = new WebSocketServer({ port: 0 });
    upstream.on("connection", (socket) => {
      socket.on("message", (raw: Buffer) => {
        const frame = decodeVolcFrame(raw);
        if (frame.type !== MsgType.AudioOnlyClient) return;
        upstreamAudioBytes += frame.payload.length;
        if (upstreamMode === "drop") {
          socket.send(asrResult(frame.sequence!, "帮我把代码", false));
          setTimeout(() => socket.terminate(), 20);
          return;
        }
        if (frame.isLast) socket.send(asrResult(-frame.sequence!, "帮我跑一下测试。", true, true));
        else socket.send(asrResult(frame.sequence!, "帮我跑一下测试。", true));
      });
    });
    await new Promise((resolve) => upstream.once("listening", resolve));
    vi.stubEnv("VOLC_SPEECH_API_KEY", "key-1");
    vi.stubEnv("VOLC_ASR_URL", `ws://127.0.0.1:${(upstream.address() as AddressInfo).port}`);

    const wss = setupSpeechGateway();
    app = createServer();
    app.on("upgrade", (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    });
    await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
    gatewayUrl = `ws://127.0.0.1:${(app.address() as AddressInfo).port}/ws/speech`;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await new Promise((resolve) => upstream.close(resolve));
    await new Promise((resolve) => app.close(resolve));
  });

  it("relays partials with the endpoint flag, then the final result", async () => {
    const client = new WebSocket(`${gatewayUrl}?token=good`);
    const envelopes: Array<{ type: string; payload: Record<string, unknown> }> = [];
    client.on("message", (data) => envelopes.push(JSON.parse(String(data))));
    await new Promise((resolve) => client.once("open", resolve));

    client.send(JSON.stringify({ type: "start", payload: { sample_rate: 16_000 } }));
    client.send(Buffer.alloc(3200));
    await vi.waitFor(() => expect(envelopes.some((e) => e.type === "partial")).toBe(true));
    client.send(JSON.stringify({ type: "finish" }));
    await vi.waitFor(() => expect(envelopes.some((e) => e.type === "result")).toBe(true));
    client.close();

    expect(envelopes[0]).toMatchObject({ type: "ready", payload: { sample_rate: 16_000 } });
    expect(envelopes.find((e) => e.type === "partial")?.payload)
      .toEqual({ text: "帮我跑一下测试。", phase: "listening", endpoint: true });
    expect(envelopes.find((e) => e.type === "result")?.payload).toEqual({ text: "帮我跑一下测试。" });
    expect(upstreamAudioBytes).toBe(3200);
  });

  const connect = async () => {
    const client = new WebSocket(`${gatewayUrl}?token=good`);
    const envelopes: Array<{ type: string; payload: Record<string, unknown> }> = [];
    client.on("message", (data) => envelopes.push(JSON.parse(String(data))));
    await new Promise((resolve) => client.once("open", resolve));
    client.send(JSON.stringify({ type: "start", payload: { sample_rate: 16_000 } }));
    return { client, envelopes };
  };

  it("reports an upstream failure mid-recording with the partial text, never as a result", async () => {
    upstreamMode = "drop";
    const { client, envelopes } = await connect();
    client.send(Buffer.alloc(3200));
    // Reported right away, while the user may still be talking.
    await vi.waitFor(() => expect(envelopes.some((e) => e.type === "error")).toBe(true));
    expect(envelopes.find((e) => e.type === "error")?.payload).toMatchObject({
      message: "speech transcription failed",
      text: "帮我把代码",
    });
    client.send(JSON.stringify({ type: "finish" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    client.close();
    expect(envelopes.some((e) => e.type === "result")).toBe(false);
    expect(envelopes.filter((e) => e.type === "error")).toHaveLength(1);
  });

  it("enforces the hourly audio byte budget on streamed audio", async () => {
    vi.stubEnv("SPEECH_TRANSCRIBE_MAX_BYTES_PER_HOUR", "8000");
    const { client, envelopes } = await connect();
    const closed = new Promise<number>((resolve) => client.once("close", (code) => resolve(code)));
    client.send(Buffer.alloc(3200));
    client.send(Buffer.alloc(3200));
    client.send(Buffer.alloc(3200)); // 9600 > 8000
    expect(await closed).toBe(1008);
    expect(envelopes.find((e) => e.type === "error")?.payload).toMatchObject({
      message: "speech transcription rate limit exceeded",
    });
    expect(upstreamAudioBytes).toBeLessThanOrEqual(6400);

    // The budget is per user and hour: the next stream is refused at once.
    const next = await connect();
    const nextClosed = new Promise<number>((resolve) => next.client.once("close", (code) => resolve(code)));
    next.client.send(Buffer.alloc(3200));
    expect(await nextClosed).toBe(1008);
  });
});
