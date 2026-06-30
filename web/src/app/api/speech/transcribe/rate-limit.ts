const REQUEST_WINDOW_MS = 60 * 1000;
const BYTE_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_MAX_REQUESTS_PER_WINDOW = 20;
const DEFAULT_MAX_BYTES_PER_WINDOW = 60 * 1024 * 1024;

type SpeechRateLimitBucket = {
  requestWindowStartedAt: number;
  requestCount: number;
  byteWindowStartedAt: number;
  byteCount: number;
};

export type SpeechRateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

const speechRateLimitBuckets = new Map<string, SpeechRateLimitBucket>();

const parsePositiveIntegerEnv = (name: string, fallback: number): number => {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const getRateLimitConfig = () => ({
  maxRequestsPerWindow: parsePositiveIntegerEnv(
    "SPEECH_TRANSCRIBE_MAX_REQUESTS_PER_MINUTE",
    DEFAULT_MAX_REQUESTS_PER_WINDOW,
  ),
  maxBytesPerWindow: parsePositiveIntegerEnv(
    "SPEECH_TRANSCRIBE_MAX_BYTES_PER_HOUR",
    DEFAULT_MAX_BYTES_PER_WINDOW,
  ),
});

const secondsUntilReset = (now: number, startedAt: number, windowMs: number): number =>
  Math.max(1, Math.ceil((startedAt + windowMs - now) / 1000));

export const checkSpeechRateLimit = (
  userId: string,
  fileBytes: number,
  now = Date.now(),
): SpeechRateLimitResult => {
  const config = getRateLimitConfig();
  const existing = speechRateLimitBuckets.get(userId);
  const bucket: SpeechRateLimitBucket = existing ?? {
    requestWindowStartedAt: now,
    requestCount: 0,
    byteWindowStartedAt: now,
    byteCount: 0,
  };

  if (now - bucket.requestWindowStartedAt >= REQUEST_WINDOW_MS) {
    bucket.requestWindowStartedAt = now;
    bucket.requestCount = 0;
  }
  if (now - bucket.byteWindowStartedAt >= BYTE_WINDOW_MS) {
    bucket.byteWindowStartedAt = now;
    bucket.byteCount = 0;
  }

  if (bucket.requestCount >= config.maxRequestsPerWindow) {
    speechRateLimitBuckets.set(userId, bucket);
    return {
      allowed: false,
      retryAfterSeconds: secondsUntilReset(now, bucket.requestWindowStartedAt, REQUEST_WINDOW_MS),
    };
  }
  if (bucket.byteCount + fileBytes > config.maxBytesPerWindow) {
    speechRateLimitBuckets.set(userId, bucket);
    return {
      allowed: false,
      retryAfterSeconds: secondsUntilReset(now, bucket.byteWindowStartedAt, BYTE_WINDOW_MS),
    };
  }

  bucket.requestCount += 1;
  bucket.byteCount += fileBytes;
  speechRateLimitBuckets.set(userId, bucket);
  return { allowed: true };
};

export const resetSpeechTranscribeRateLimitsForTest = () => {
  speechRateLimitBuckets.clear();
};
