import type { IncomingMessage } from "http";
import { WebSocket, WebSocketServer, type RawData } from "ws";

import { authenticateToken } from "@/lib/auth/service";
import {
  DEFAULT_SPEECH_SAMPLE_RATE,
  normalizeSpeechSampleRate,
  parseSpeechControlMessage,
} from "@/lib/speech/gateway-protocol";
import { checkSpeechRateLimit } from "@/lib/speech/rate-limit";
import {
  MAX_AUDIO_BYTES,
  normalizeLanguageTag,
  pcm16MonoToWav,
  transcribeSpeechFile,
} from "@/lib/speech/transcribe";

export const SPEECH_WS_PATH = "/ws/speech";

const sendEnvelope = (socket: WebSocket, envelope: Record<string, unknown>) => {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(envelope));
};

const extractToken = (req: IncomingMessage): string | undefined => {
  const url = new URL(req.url || "", `http://${req.headers.host}`);
  return url.searchParams.get("token") || undefined;
};

const rawDataToBuffer = (raw: RawData): Buffer => {
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof ArrayBuffer) return Buffer.from(raw);
  if (Array.isArray(raw)) return Buffer.concat(raw.map((part) => Buffer.from(part)));
  return Buffer.from(raw);
};

export const setupSpeechGateway = (): WebSocketServer => {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_AUDIO_BYTES });

  wss.on("connection", async (socket, request) => {
    const token = extractToken(request);
    if (!token) {
      sendEnvelope(socket, { type: "error", payload: { message: "Token required" } });
      socket.close(4001, "token-required");
      return;
    }

    const user = await authenticateToken(token);
    if (!user) {
      sendEnvelope(socket, { type: "error", payload: { message: "Invalid token" } });
      socket.close(4002, "invalid-token");
      return;
    }

    let started = false;
    let finishing = false;
    let language = "";
    let sampleRate = DEFAULT_SPEECH_SAMPLE_RATE;
    let byteCount = 0;
    const chunks: Buffer[] = [];
    const connectedAt = Date.now();

    const sendError = (message: string, extra: Record<string, unknown> = {}) => {
      sendEnvelope(socket, { type: "error", payload: { message, ...extra } });
    };

    const finishTranscription = async () => {
      if (finishing) return;
      finishing = true;

      if (!started) {
        sendError("speech stream not started");
        return;
      }
      if (byteCount <= 0) {
        sendError("audio required");
        return;
      }

      const pcm = Buffer.concat(chunks, byteCount);
      const wav = pcm16MonoToWav(pcm, sampleRate);
      const rateLimit = checkSpeechRateLimit(user.id, wav.length);
      if (!rateLimit.allowed) {
        console.warn("speech_stream_rate_limited", {
          file_bytes: wav.length,
          retry_after_seconds: rateLimit.retryAfterSeconds,
        });
        sendError("speech transcription rate limit exceeded", {
          retry_after_seconds: rateLimit.retryAfterSeconds,
        });
        return;
      }

      const wavBlob = new Blob([new Uint8Array(wav)], { type: "audio/wav" });
      const result = await transcribeSpeechFile({
        file: wavBlob,
        filename: "speech.wav",
        language,
        source: "websocket",
      });
      if (!result.ok) {
        sendError(result.error, {
          status: result.status,
          ...(result.detail ? { detail: result.detail } : {}),
          ...(result.retryAfterSeconds ? { retry_after_seconds: result.retryAfterSeconds } : {}),
        });
        return;
      }

      sendEnvelope(socket, {
        type: "result",
        payload: {
          text: result.text,
          upstream_ms: result.upstreamMs,
        },
      });
      console.info("speech_stream_ok", {
        file_bytes: wav.length,
        language: result.language,
        transcript_chars: result.text.length,
        elapsed_ms: Date.now() - connectedAt,
      });
    };

    socket.on("message", (raw, isBinary) => {
      void (async () => {
        if (isBinary) {
          if (!started || finishing) return;
          const chunk = rawDataToBuffer(raw);
          byteCount += chunk.length;
          if (byteCount > MAX_AUDIO_BYTES) {
            sendError("audio too large");
            socket.close(1009, "audio-too-large");
            return;
          }
          chunks.push(chunk);
          return;
        }

        const message = parseSpeechControlMessage(rawDataToBuffer(raw).toString("utf8"));
        if (!message) {
          sendError("invalid speech control message");
          return;
        }

        if (message.type === "start") {
          if (started) {
            sendError("speech stream already started");
            return;
          }
          started = true;
          language = normalizeLanguageTag(message.payload?.language);
          sampleRate = normalizeSpeechSampleRate(
            message.payload?.sample_rate ?? message.payload?.sampleRate,
          );
          sendEnvelope(socket, {
            type: "ready",
            payload: {
              sample_rate: sampleRate,
              max_audio_bytes: MAX_AUDIO_BYTES,
            },
          });
          return;
        }

        if (message.type === "finish") {
          await finishTranscription();
          return;
        }

        socket.close(1000, "cancel");
      })().catch((error) => {
        console.warn("speech_stream_failed", {
          error: error instanceof Error ? error.message : "speech stream failed",
        });
        sendError("speech stream failed");
      });
    });
  });

  console.log(`Speech WebSocket gateway ready at ${SPEECH_WS_PATH}`);
  return wss;
};
