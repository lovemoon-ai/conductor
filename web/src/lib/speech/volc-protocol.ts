import { gunzipSync, gzipSync } from "zlib";

/**
 * Binary framing shared by Volcengine (Doubao) speech v3 WebSocket APIs:
 * streaming ASR (`/api/v3/sauc/bigmodel_async`) and bidirectional TTS
 * (`/api/v3/tts/bidirection`).
 *
 * Header (4 bytes): version<<4|headerSize, type<<4|flags, serialization<<4|compression, reserved.
 * Then, depending on type/flags: sequence (int32) or error code (uint32),
 * event (int32), session/connection id (uint32 len + utf8), payload (uint32 len + bytes).
 */

export const MsgType = {
  FullClientRequest: 0b0001,
  AudioOnlyClient: 0b0010,
  FullServerResponse: 0b1001,
  AudioOnlyServer: 0b1011,
  FrontEndResult: 0b1100,
  Error: 0b1111,
} as const;

export const MsgFlag = {
  NoSeq: 0b0000,
  PositiveSeq: 0b0001,
  LastNoSeq: 0b0010,
  NegativeSeq: 0b0011,
  WithEvent: 0b0100,
} as const;

export const TtsEvent = {
  StartConnection: 1,
  FinishConnection: 2,
  ConnectionStarted: 50,
  ConnectionFailed: 51,
  ConnectionFinished: 52,
  StartSession: 100,
  CancelSession: 101,
  FinishSession: 102,
  SessionStarted: 150,
  SessionCanceled: 151,
  SessionFinished: 152,
  SessionFailed: 153,
  TaskRequest: 200,
  TtsSentenceStart: 350,
  TtsSentenceEnd: 351,
  TtsResponse: 352,
} as const;

const SERIALIZATION_NONE = 0;
const SERIALIZATION_JSON = 1;
const COMPRESSION_NONE = 0;
const COMPRESSION_GZIP = 1;

const CONNECTION_EVENTS = new Set<number>([
  TtsEvent.StartConnection,
  TtsEvent.FinishConnection,
  TtsEvent.ConnectionStarted,
  TtsEvent.ConnectionFailed,
  TtsEvent.ConnectionFinished,
]);

const header = (type: number, flags: number, serialization: number, compression: number) =>
  Buffer.from([0x11, (type << 4) | flags, (serialization << 4) | compression, 0]);

const uint32 = (value: number) => {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(value >>> 0, 0);
  return buf;
};

const int32 = (value: number) => {
  const buf = Buffer.alloc(4);
  buf.writeInt32BE(value, 0);
  return buf;
};

const sized = (payload: Buffer) => Buffer.concat([uint32(payload.length), payload]);

/** ASR: the gzip'd JSON config that opens a recognition stream. */
export const encodeAsrFullRequest = (seq: number, config: unknown): Buffer =>
  Buffer.concat([
    header(MsgType.FullClientRequest, MsgFlag.PositiveSeq, SERIALIZATION_JSON, COMPRESSION_GZIP),
    int32(seq),
    sized(gzipSync(Buffer.from(JSON.stringify(config), "utf8"))),
  ]);

/** ASR: one PCM chunk; the last one carries a negative sequence number. */
export const encodeAsrAudio = (seq: number, pcm: Buffer, isLast: boolean): Buffer =>
  Buffer.concat([
    header(
      MsgType.AudioOnlyClient,
      isLast ? MsgFlag.NegativeSeq : MsgFlag.PositiveSeq,
      SERIALIZATION_NONE,
      COMPRESSION_GZIP,
    ),
    int32(isLast ? -seq : seq),
    sized(gzipSync(pcm)),
  ]);

/** TTS: an event frame with a JSON payload. */
export const encodeTtsEvent = (event: number, payload: unknown, sessionId?: string): Buffer => {
  const parts = [
    header(MsgType.FullClientRequest, MsgFlag.WithEvent, SERIALIZATION_JSON, COMPRESSION_NONE),
    int32(event),
  ];
  if (sessionId !== undefined && !CONNECTION_EVENTS.has(event)) {
    parts.push(sized(Buffer.from(sessionId, "utf8")));
  }
  parts.push(sized(Buffer.from(JSON.stringify(payload ?? {}), "utf8")));
  return Buffer.concat(parts);
};

export type VolcFrame = {
  type: number;
  flags: number;
  sequence?: number;
  errorCode?: number;
  event?: number;
  sessionId?: string;
  connectionId?: string;
  /** True for the server's final frame of an ASR stream (negative/last flag). */
  isLast: boolean;
  /** Parsed JSON when serialization is JSON, otherwise undefined. */
  json?: unknown;
  /** Raw (decompressed) payload bytes, e.g. audio for AudioOnlyServer. */
  payload: Buffer;
};

export const decodeVolcFrame = (data: Buffer): VolcFrame => {
  if (data.length < 4) throw new Error(`volc frame too short: ${data.length}`);
  const headerSize = (data[0] & 0x0f) * 4;
  const type = data[1] >> 4;
  const flags = data[1] & 0x0f;
  const serialization = data[2] >> 4;
  const compression = data[2] & 0x0f;
  let offset = headerSize;
  const frame: VolcFrame = { type, flags, isLast: false, payload: Buffer.alloc(0) };

  const readInt32 = () => {
    const value = data.readInt32BE(offset);
    offset += 4;
    return value;
  };
  const readSized = () => {
    const size = data.readUInt32BE(offset);
    offset += 4;
    const value = data.subarray(offset, offset + size);
    offset += size;
    return value;
  };

  if (type === MsgType.Error) {
    frame.errorCode = data.readUInt32BE(offset);
    offset += 4;
  } else if (flags === MsgFlag.PositiveSeq || flags === MsgFlag.NegativeSeq) {
    frame.sequence = readInt32();
  }
  frame.isLast = flags === MsgFlag.NegativeSeq || flags === MsgFlag.LastNoSeq;

  if (flags === MsgFlag.WithEvent) {
    frame.event = readInt32();
    if (CONNECTION_EVENTS.has(frame.event)) {
      if (frame.event !== TtsEvent.StartConnection && frame.event !== TtsEvent.FinishConnection) {
        frame.connectionId = readSized().toString("utf8");
      }
    } else {
      frame.sessionId = readSized().toString("utf8");
    }
  }

  let payload = Buffer.from(readSized());
  if (compression === COMPRESSION_GZIP && payload.length > 0) payload = gunzipSync(payload);
  frame.payload = payload;
  if (serialization === SERIALIZATION_JSON && payload.length > 0) {
    try {
      frame.json = JSON.parse(payload.toString("utf8"));
    } catch {
      frame.json = undefined;
    }
  }
  return frame;
};

/** Auth headers: new-console API key, or legacy app id + access token. */
export const volcSpeechAuthHeaders = (
  env: Record<string, string | undefined> = process.env,
): Record<string, string> | null => {
  const apiKey = env.VOLC_SPEECH_API_KEY?.trim();
  if (apiKey) return { "X-Api-Key": apiKey };
  const appId = env.VOLC_SPEECH_APP_ID?.trim();
  const accessToken = env.VOLC_SPEECH_ACCESS_TOKEN?.trim();
  if (appId && accessToken) return { "X-Api-App-Key": appId, "X-Api-Access-Key": accessToken };
  return null;
};

export const isVolcSpeechConfigured = (env: Record<string, string | undefined> = process.env): boolean =>
  volcSpeechAuthHeaders(env) !== null;
