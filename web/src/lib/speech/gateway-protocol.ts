export const DEFAULT_SPEECH_SAMPLE_RATE = 16_000;
const MIN_SPEECH_SAMPLE_RATE = 8_000;
const MAX_SPEECH_SAMPLE_RATE = 48_000;

export type SpeechControlMessage =
  | { type: "start"; payload?: { language?: unknown; sample_rate?: unknown; sampleRate?: unknown } }
  | { type: "finish" }
  | { type: "cancel" };

export const normalizeSpeechSampleRate = (value: unknown): number => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (
    Number.isFinite(parsed) &&
    parsed >= MIN_SPEECH_SAMPLE_RATE &&
    parsed <= MAX_SPEECH_SAMPLE_RATE
  ) {
    return parsed;
  }
  return DEFAULT_SPEECH_SAMPLE_RATE;
};

export const parseSpeechControlMessage = (raw: string): SpeechControlMessage | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || !("type" in parsed)) return null;
  const type = parsed.type;
  if (type !== "start" && type !== "finish" && type !== "cancel") return null;
  return parsed as SpeechControlMessage;
};
