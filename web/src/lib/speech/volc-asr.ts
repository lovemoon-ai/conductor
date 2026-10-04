import { randomUUID } from "crypto";
import { WebSocket } from "ws";

import {
  MsgType,
  decodeVolcFrame,
  encodeAsrAudio,
  encodeAsrFullRequest,
  volcSpeechAuthHeaders,
} from "@/lib/speech/volc-protocol";

const DEFAULT_ASR_URL = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async";
const DEFAULT_ASR_RESOURCE_ID = "volc.seedasr.sauc.duration";
const DEFAULT_END_WINDOW_MS = 800;
const FINISH_TIMEOUT_MS = 10_000;

type AsrUtterance = { text?: unknown; definite?: unknown };

/** Cumulative text plus whether the latest utterance is final (speaker paused). */
export const readAsrResult = (json: unknown): { text: string; endpoint: boolean } => {
  const result = (json as { result?: { text?: unknown; utterances?: unknown } } | undefined)?.result;
  const text = typeof result?.text === "string" ? result.text.trim() : "";
  const utterances = Array.isArray(result?.utterances) ? (result.utterances as AsrUtterance[]) : [];
  const last = utterances[utterances.length - 1];
  return { text, endpoint: Boolean(text) && last?.definite === true };
};

const endWindowMs = () => {
  const parsed = Number.parseInt(process.env.VOLC_ASR_END_WINDOW_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 200 ? parsed : DEFAULT_END_WINDOW_MS;
};

export type VolcAsrStream = {
  sendAudio: (pcm: Buffer) => void;
  /**
   * Flush the last packet and resolve with the transcript. After a failure
   * (reported through onError) this is only the partial text heard so far.
   */
  finish: () => Promise<string>;
  cancel: () => void;
};

export const openVolcAsrStream = (args: {
  sampleRate: number;
  userId: string;
  onPartial: (text: string, endpoint: boolean) => void;
  onError: (message: string) => void;
}): VolcAsrStream => {
  const auth = volcSpeechAuthHeaders();
  if (!auth) throw new Error("volc speech is not configured");

  const socket = new WebSocket(process.env.VOLC_ASR_URL?.trim() || DEFAULT_ASR_URL, {
    headers: {
      ...auth,
      "X-Api-Resource-Id": process.env.VOLC_ASR_RESOURCE_ID?.trim() || DEFAULT_ASR_RESOURCE_ID,
      "X-Api-Connect-Id": randomUUID(),
    },
  });
  const pending: Buffer[] = [];
  let seq = 1;
  let lastText = "";
  let finished = false;
  let failed = false;
  let gotLast = false;
  let cancelled = false;
  let resolveFinal: ((text: string) => void) | null = null;

  const send = (frame: Buffer) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(frame);
    else if (socket.readyState === WebSocket.CONNECTING) pending.push(frame);
  };
  const settle = () => {
    resolveFinal?.(lastText);
    resolveFinal = null;
  };
  const fail = (message: string) => {
    if (failed || cancelled) return;
    failed = true;
    args.onError(message);
    settle();
    socket.terminate();
  };

  send(encodeAsrFullRequest(seq++, {
    user: { uid: args.userId },
    audio: { format: "pcm", codec: "raw", rate: args.sampleRate, bits: 16, channel: 1 },
    request: {
      model_name: "bigmodel",
      enable_itn: true,
      enable_punc: true,
      show_utterances: true,
      result_type: "full",
      end_window_size: endWindowMs(),
    },
  }));

  socket.on("open", () => {
    for (const frame of pending.splice(0)) socket.send(frame);
  });
  socket.on("message", (raw: Buffer) => {
    let frame;
    try {
      frame = decodeVolcFrame(Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
    } catch (error) {
      fail(error instanceof Error ? error.message : "invalid asr frame");
      return;
    }
    if (frame.type === MsgType.Error) {
      fail(`volc asr error ${frame.errorCode}: ${frame.payload.toString("utf8").slice(0, 200)}`);
      return;
    }
    const { text, endpoint } = readAsrResult(frame.json);
    if (text && (text !== lastText || endpoint)) {
      lastText = text;
      if (!finished) args.onPartial(text, endpoint);
    }
    if (frame.isLast) {
      gotLast = true;
      settle();
      socket.close();
    }
  });
  socket.on("unexpected-response", (_req, res) => {
    fail(`volc asr handshake failed: HTTP ${res.statusCode}`);
  });
  socket.on("error", (error) => fail(`volc asr socket error: ${error.message}`));
  // Upstream hung up before the final result: the transcript is incomplete.
  socket.on("close", () => {
    if (!gotLast && !cancelled) fail("volc asr connection closed early");
    settle();
  });

  return {
    sendAudio: (pcm) => {
      if (finished || failed || pcm.length === 0) return;
      send(encodeAsrAudio(seq++, pcm, false));
    },
    finish: () => {
      if (!finished) {
        finished = true;
        if (!failed) send(encodeAsrAudio(seq++, Buffer.alloc(0), true));
      }
      if (failed || socket.readyState === WebSocket.CLOSED) return Promise.resolve(lastText);
      return new Promise((resolve) => {
        resolveFinal = resolve;
        setTimeout(() => {
          if (!gotLast) fail("volc asr final result timed out");
          settle();
        }, FINISH_TIMEOUT_MS).unref?.();
      });
    },
    cancel: () => {
      finished = true;
      cancelled = true;
      socket.terminate();
    },
  };
};
