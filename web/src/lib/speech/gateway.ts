import type { IncomingMessage } from "http";
import { WebSocket, WebSocketServer, type RawData } from "ws";

import { authenticateToken } from "@/lib/auth/service";
import { isDaemonShareUser } from "@/lib/daemon-share/scope";
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
  transcribeSpeechFileStream,
} from "@/lib/speech/transcribe";

export const SPEECH_WS_PATH = "/ws/speech";

const DEFAULT_PARTIAL_TRANSCRIBE_INTERVAL_MS = 2_000;
const DEFAULT_PARTIAL_TRANSCRIBE_MAX_REQUESTS = 12;

const parsePositiveIntegerEnv = (name: string, fallback: number): number => {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const partialTranscribeIntervalMs = (): number =>
  parsePositiveIntegerEnv(
    "SPEECH_PARTIAL_TRANSCRIBE_INTERVAL_MS",
    DEFAULT_PARTIAL_TRANSCRIBE_INTERVAL_MS,
  );

const partialTranscribeMaxRequests = (): number =>
  parsePositiveIntegerEnv(
    "SPEECH_PARTIAL_TRANSCRIBE_MAX_REQUESTS",
    DEFAULT_PARTIAL_TRANSCRIBE_MAX_REQUESTS,
  );

const minPartialAudioBytes = (sampleRate: number): number => sampleRate * 2;

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
    // RFC 0035: same reasoning as /ws/app -- a share token has no business
    // spending the grantee's transcription quota.
    if (user && isDaemonShareUser(user)) {
      socket.close(4003, "share-token-not-allowed");
      return;
    }
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
    let socketClosed = false;
    let partialTimer: ReturnType<typeof setTimeout> | null = null;
    let partialInFlight = false;
    let partialPending = false;
    let partialRequestCount = 0;
    let lastPartialStartedAt = 0;
    let lastPartialText = "";
    let partialGeneration = 0;

    const sendError = (message: string, extra: Record<string, unknown> = {}) => {
      sendEnvelope(socket, { type: "error", payload: { message, ...extra } });
    };

    const clearPartialTimer = () => {
      if (!partialTimer) return;
      clearTimeout(partialTimer);
      partialTimer = null;
    };

    const stopPartialTranscription = () => {
      partialPending = false;
      partialGeneration += 1;
      clearPartialTimer();
    };

    const runPartialTranscription = async () => {
      if (
        partialInFlight ||
        finishing ||
        socketClosed ||
        !started ||
        byteCount < minPartialAudioBytes(sampleRate) ||
        partialRequestCount >= partialTranscribeMaxRequests()
      ) {
        return;
      }

      partialInFlight = true;
      partialPending = false;
      partialRequestCount += 1;
      lastPartialStartedAt = Date.now();
      const requestGeneration = partialGeneration;
      const pcm = Buffer.concat(chunks, byteCount);
      const wav = pcm16MonoToWav(pcm, sampleRate);
      const wavBlob = new Blob([new Uint8Array(wav)], { type: "audio/wav" });

      try {
        const result = await transcribeSpeechFile({
          file: wavBlob,
          filename: "speech-partial.wav",
          language,
          source: "websocket",
        });
        if (
          result.ok &&
          !finishing &&
          !socketClosed &&
          requestGeneration === partialGeneration &&
          result.text &&
          result.text !== lastPartialText
        ) {
          lastPartialText = result.text;
          sendEnvelope(socket, {
            type: "partial",
            payload: { text: result.text, phase: "listening" },
          });
        } else if (!result.ok && result.status !== 422) {
          console.info("speech_stream_partial_failed", {
            status: result.status,
            error: result.error,
          });
        }
      } finally {
        partialInFlight = false;
        if (partialPending && !finishing && !socketClosed) {
          schedulePartialTranscription();
        }
      }
    };

    const schedulePartialTranscription = () => {
      if (
        finishing ||
        socketClosed ||
        !started ||
        byteCount < minPartialAudioBytes(sampleRate) ||
        partialRequestCount >= partialTranscribeMaxRequests()
      ) {
        return;
      }
      if (partialInFlight) {
        partialPending = true;
        return;
      }
      if (partialTimer) return;
      const waitMs = Math.max(
        0,
        partialTranscribeIntervalMs() - (Date.now() - lastPartialStartedAt),
      );
      partialTimer = setTimeout(() => {
        partialTimer = null;
        void runPartialTranscription();
      }, waitMs);
    };

    const finishTranscription = async () => {
      if (finishing) return;
      finishing = true;
      stopPartialTranscription();

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
      const result = await transcribeSpeechFileStream({
        file: wavBlob,
        filename: "speech.wav",
        language,
        source: "websocket",
        onPartial: (text) => {
          if (text === lastPartialText) return;
          lastPartialText = text;
          sendEnvelope(socket, {
            type: "partial",
            payload: { text, phase: "recognizing" },
          });
        },
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
          schedulePartialTranscription();
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

    socket.on("close", () => {
      socketClosed = true;
      stopPartialTranscription();
    });
  });

  console.log(`Speech WebSocket gateway ready at ${SPEECH_WS_PATH}`);
  return wss;
};
