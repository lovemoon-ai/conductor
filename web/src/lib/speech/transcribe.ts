export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
export const DEFAULT_TRANSCRIBE_MODEL = "glm-asr-2512";
export const GLM_TRANSCRIPTIONS_URL = "https://open.bigmodel.cn/api/paas/v4/audio/transcriptions";
export const MAX_LANGUAGE_TAG_LENGTH = 32;

export type SpeechTranscriptionResult =
  | { ok: true; text: string; model: string; language: string | null; upstreamMs: number }
  | { ok: false; status: number; error: string; detail?: string; retryAfterSeconds?: number };

export type SpeechTranscriptionStreamResult = SpeechTranscriptionResult;

type SpeechTranscriptMergeMode = "snapshot" | "delta";

type SpeechStreamTextChunk = {
  text: string;
  mode: SpeechTranscriptMergeMode;
};

type SpeechTranscriptionStreamArgs = {
  file: File | Blob;
  filename?: string;
  language?: string | null;
  source: "http" | "websocket";
  onPartial?: (text: string) => void;
};

export const isSupportedAudioType = (type: string): boolean => {
  const normalized = type.trim().toLowerCase();
  return normalized === "audio/wav" ||
    normalized === "audio/wave" ||
    normalized === "audio/x-wav" ||
    normalized === "audio/mpeg" ||
    normalized === "audio/mp3" ||
    normalized === "application/octet-stream";
};

export const normalizeLanguageTag = (value: unknown): string => {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, MAX_LANGUAGE_TAG_LENGTH);
};

const fileLikeSize = (file: { size: number }) => file.size;

const makeUpstreamFormData = (
  args: SpeechTranscriptionStreamArgs,
  model: string,
  stream: boolean,
): { formData: FormData; language: string } => {
  const language = normalizeLanguageTag(args.language);
  const upstreamFormData = new FormData();
  upstreamFormData.set("file", args.file, args.filename || "speech.wav");
  upstreamFormData.set("model", model);
  upstreamFormData.set("stream", stream ? "true" : "false");
  if (language) {
    upstreamFormData.set("language", language);
  }
  return { formData: upstreamFormData, language };
};

export const mergeSpeechTranscriptText = (
  previous: string,
  next: string,
  mode: SpeechTranscriptMergeMode = "snapshot",
): string => {
  if (!next.trim()) return previous;
  if (mode === "snapshot") return next.trim();
  if (!previous) return next.trimStart();
  return `${previous}${next}`.trim();
};

const extractSpeechStreamChunkFromObject = (
  value: Record<string, unknown>,
  inheritedMode: SpeechTranscriptMergeMode = "snapshot",
): SpeechStreamTextChunk | null => {
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    if (typeof item === "string" && item.trim()) {
      if (normalizedKey === "delta") {
        return { text: item, mode: "delta" };
      }
      if (normalizedKey === "text" || normalizedKey === "transcript") {
        return { text: item, mode: "snapshot" };
      }
      if (normalizedKey === "content") {
        return { text: item, mode: inheritedMode };
      }
    }
  }

  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    const nestedMode = normalizedKey === "delta" ? "delta" : inheritedMode;
    if (Array.isArray(item)) {
      for (const entry of item) {
        const nested = extractSpeechStreamChunk(entry, nestedMode);
        if (nested) return nested;
      }
      continue;
    }
    const nested = extractSpeechStreamChunk(item, nestedMode);
    if (nested) return nested;
  }
  return null;
};

export const extractSpeechStreamChunk = (
  value: unknown,
  inheritedMode: SpeechTranscriptMergeMode = "snapshot",
): SpeechStreamTextChunk | null => {
  if (typeof value === "string") {
    return value.trim() ? { text: value, mode: "delta" } : null;
  }
  if (!value || typeof value !== "object") return null;
  return extractSpeechStreamChunkFromObject(value as Record<string, unknown>, inheritedMode);
};

export const extractSpeechStreamText = (value: unknown): string =>
  extractSpeechStreamChunk(value)?.text.trim() ?? "";

export const parseSpeechEventStreamDataLines = (rawEvent: string): string[] =>
  rawEvent
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter(Boolean);

const consumeSpeechEventStream = async (
  body: ReadableStream<Uint8Array>,
  onPartial?: (text: string) => void,
): Promise<string> => {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let transcript = "";

  const consumeRawEvent = (rawEvent: string) => {
    for (const data of parseSpeechEventStreamDataLines(rawEvent)) {
      if (data === "[DONE]") return;
      let parsed: unknown = data;
      try {
        parsed = JSON.parse(data);
      } catch {
        // Some providers send raw text chunks as data lines.
      }
      const chunk = extractSpeechStreamChunk(parsed);
      if (!chunk) continue;
      const nextTranscript = mergeSpeechTranscriptText(transcript, chunk.text, chunk.mode);
      if (nextTranscript && nextTranscript !== transcript) {
        transcript = nextTranscript;
        onPartial?.(transcript);
      }
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() ?? "";
    for (const event of events) {
      consumeRawEvent(event);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    consumeRawEvent(buffer);
  }

  return transcript.trim();
};

export async function transcribeSpeechFile(args: {
  file: File | Blob;
  filename?: string;
  language?: string | null;
  source: "http" | "websocket";
}): Promise<SpeechTranscriptionResult> {
  const apiKey = process.env.GLM_API_KEY?.trim();
  if (!apiKey) {
    return {
      ok: false,
      status: 503,
      error: "Speech transcription is not configured: GLM_API_KEY missing",
    };
  }

  const model = process.env.GLM_ASR_MODEL?.trim() || DEFAULT_TRANSCRIBE_MODEL;
  const { formData: upstreamFormData, language } = makeUpstreamFormData(args, model, false);

  let upstream: Response;
  const upstreamStartedAt = Date.now();
  try {
    upstream = await fetch(GLM_TRANSCRIPTIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: upstreamFormData,
    });
  } catch (error) {
    console.warn("speech_transcribe_upstream_request_failed", {
      source: args.source,
      model,
      language: language || null,
      file_bytes: fileLikeSize(args.file),
      upstream_ms: Date.now() - upstreamStartedAt,
      error: error instanceof Error ? error.message : "Transcription request failed",
    });
    return {
      ok: false,
      status: 502,
      error: error instanceof Error ? error.message : "Transcription request failed",
    };
  }

  const text = await upstream.text();
  if (!upstream.ok) {
    console.warn("speech_transcribe_upstream_failed", {
      source: args.source,
      model,
      language: language || null,
      file_bytes: fileLikeSize(args.file),
      upstream_status: upstream.status,
      upstream_ms: Date.now() - upstreamStartedAt,
    });
    return {
      ok: false,
      status: 502,
      error: "Transcription failed",
      detail: text.slice(0, 500),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.warn("speech_transcribe_invalid_response", {
      source: args.source,
      model,
      language: language || null,
      file_bytes: fileLikeSize(args.file),
      upstream_status: upstream.status,
      upstream_ms: Date.now() - upstreamStartedAt,
    });
    return { ok: false, status: 502, error: "Invalid transcription response" };
  }

  const transcript =
    parsed && typeof parsed === "object" && "text" in parsed && typeof parsed.text === "string"
      ? parsed.text.trim()
      : "";
  if (!transcript) {
    console.info("speech_transcribe_no_match", {
      source: args.source,
      model,
      language: language || null,
      file_bytes: fileLikeSize(args.file),
      upstream_ms: Date.now() - upstreamStartedAt,
    });
    return { ok: false, status: 422, error: "No speech recognized" };
  }

  const upstreamMs = Date.now() - upstreamStartedAt;
  console.info("speech_transcribe_ok", {
    source: args.source,
    model,
    language: language || null,
    file_bytes: fileLikeSize(args.file),
    transcript_chars: transcript.length,
    upstream_ms: upstreamMs,
  });

  return { ok: true, text: transcript, model, language: language || null, upstreamMs };
}

export async function transcribeSpeechFileStream(
  args: SpeechTranscriptionStreamArgs,
): Promise<SpeechTranscriptionStreamResult> {
  const apiKey = process.env.GLM_API_KEY?.trim();
  if (!apiKey) {
    return {
      ok: false,
      status: 503,
      error: "Speech transcription is not configured: GLM_API_KEY missing",
    };
  }

  const model = process.env.GLM_ASR_MODEL?.trim() || DEFAULT_TRANSCRIBE_MODEL;
  const { formData: upstreamFormData, language } = makeUpstreamFormData(args, model, true);

  let upstream: Response;
  const upstreamStartedAt = Date.now();
  try {
    upstream = await fetch(GLM_TRANSCRIPTIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: upstreamFormData,
    });
  } catch (error) {
    console.warn("speech_transcribe_stream_upstream_request_failed", {
      source: args.source,
      model,
      language: language || null,
      file_bytes: fileLikeSize(args.file),
      upstream_ms: Date.now() - upstreamStartedAt,
      error: error instanceof Error ? error.message : "Transcription request failed",
    });
    return {
      ok: false,
      status: 502,
      error: error instanceof Error ? error.message : "Transcription request failed",
    };
  }

  if (!upstream.ok) {
    const detail = await upstream.text();
    console.warn("speech_transcribe_stream_upstream_failed", {
      source: args.source,
      model,
      language: language || null,
      file_bytes: fileLikeSize(args.file),
      upstream_status: upstream.status,
      upstream_ms: Date.now() - upstreamStartedAt,
    });
    return {
      ok: false,
      status: 502,
      error: "Transcription failed",
      detail: detail.slice(0, 500),
    };
  }

  if (!upstream.body) {
    return { ok: false, status: 502, error: "Invalid transcription response" };
  }

  let transcript = "";
  try {
    transcript = await consumeSpeechEventStream(upstream.body, args.onPartial);
  } catch (error) {
    console.warn("speech_transcribe_stream_invalid_response", {
      source: args.source,
      model,
      language: language || null,
      file_bytes: fileLikeSize(args.file),
      upstream_status: upstream.status,
      upstream_ms: Date.now() - upstreamStartedAt,
      error: error instanceof Error ? error.message : "Invalid transcription response",
    });
    return { ok: false, status: 502, error: "Invalid transcription response" };
  }

  if (!transcript) {
    console.info("speech_transcribe_stream_no_match", {
      source: args.source,
      model,
      language: language || null,
      file_bytes: fileLikeSize(args.file),
      upstream_ms: Date.now() - upstreamStartedAt,
    });
    return { ok: false, status: 422, error: "No speech recognized" };
  }

  const upstreamMs = Date.now() - upstreamStartedAt;
  console.info("speech_transcribe_stream_ok", {
    source: args.source,
    model,
    language: language || null,
    file_bytes: fileLikeSize(args.file),
    transcript_chars: transcript.length,
    upstream_ms: upstreamMs,
  });

  return { ok: true, text: transcript, model, language: language || null, upstreamMs };
}

export function pcm16MonoToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * 2;
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(pcm.length + 36, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
