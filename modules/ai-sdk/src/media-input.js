import fs from "node:fs";
import path from "node:path";

const SUPPORTED_KINDS = new Set(["image", "video"]);
const SUPPORTED_MIME_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/quicktime",
  "video/webm",
]);
const MAX_MEDIA_ITEMS = 20;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_MEDIA_BYTES = 100 * 1024 * 1024;

export const MEDIA_CAPABILITY_NATIVE = "native";
export const MEDIA_CAPABILITY_UNSUPPORTED = "unsupported";

function inferKind(mimeType) {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  return "";
}

function inferMimeType(filePath, kind) {
  const extension = path.extname(filePath).toLowerCase();
  const known = {
    ".bmp": "image/bmp",
    ".gif": "image/gif",
    ".heic": "image/heic",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".mov": "video/quicktime",
    ".mp4": "video/mp4",
    ".png": "image/png",
    ".webm": "video/webm",
    ".webp": "image/webp",
  };
  return known[extension] || `${kind}/unknown`;
}

function hasExpectedSignature(filePath, mimeType) {
  const handle = fs.openSync(filePath, "r");
  try {
    const header = Buffer.alloc(12);
    const bytesRead = fs.readSync(handle, header, 0, header.length, 0);
    if (bytesRead < 4) return false;
    if (mimeType === "image/png") return header.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
    if (mimeType === "image/jpeg") return header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
    if (mimeType === "image/gif") return header.subarray(0, 6).toString("ascii") === "GIF87a" || header.subarray(0, 6).toString("ascii") === "GIF89a";
    if (mimeType === "image/webp") return header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "WEBP";
    if (mimeType === "video/webm") return header.subarray(0, 4).equals(Buffer.from("1a45dfa3", "hex"));
    if (mimeType === "video/mp4" || mimeType === "video/quicktime") {
      return header.subarray(4, 8).toString("ascii") === "ftyp";
    }
    return false;
  } finally {
    fs.closeSync(handle);
  }
}

export function normalizeMediaInputs(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw createMediaInputError("media must be an array", { reason: "invalid_media_input" });
  }
  if (value.length > MAX_MEDIA_ITEMS) {
    throw createMediaInputError(`media cannot contain more than ${MAX_MEDIA_ITEMS} files`, {
      reason: "media_limit_exceeded",
    });
  }

  let totalBytes = 0;
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw createMediaInputError(`media[${index}] must be an object`, {
        reason: "invalid_media_input",
        mediaIndex: index,
      });
    }
    const filePath = typeof item.path === "string" ? item.path.trim() : "";
    const mimeType = typeof item.mimeType === "string" ? item.mimeType.trim().toLowerCase() : "";
    const explicitKind = typeof item.kind === "string" ? item.kind.trim().toLowerCase() : "";
    const kind = explicitKind || inferKind(mimeType);

    if (!SUPPORTED_KINDS.has(kind)) {
      throw createMediaInputError(`media[${index}] kind must be image or video`, {
        reason: "invalid_media_input",
        mediaIndex: index,
      });
    }
    if (!filePath || !path.isAbsolute(filePath)) {
      throw createMediaInputError(`media[${index}] path must be absolute`, {
        reason: "invalid_media_input",
        mediaIndex: index,
      });
    }
    let stat;
    try {
      const linkStat = fs.lstatSync(filePath);
      if (linkStat.isSymbolicLink()) {
        throw new Error("symbolic links are not allowed");
      }
      stat = fs.statSync(filePath);
    } catch {
      throw createMediaInputError(`media[${index}] file does not exist`, {
        reason: "invalid_media_input",
        mediaIndex: index,
      });
    }
    if (!stat.isFile()) {
      throw createMediaInputError(`media[${index}] path must reference a file`, {
        reason: "invalid_media_input",
        mediaIndex: index,
      });
    }
    const normalizedMimeType = mimeType || inferMimeType(filePath, kind);
    if (!SUPPORTED_MIME_TYPES.has(normalizedMimeType) || inferKind(normalizedMimeType) !== kind) {
      throw createMediaInputError(`media[${index}] kind does not match mimeType`, {
        reason: "invalid_media_input",
        mediaIndex: index,
      });
    }
    if (!hasExpectedSignature(filePath, normalizedMimeType)) {
      throw createMediaInputError(`media[${index}] content does not match mimeType`, {
        reason: "invalid_media_input",
        mediaIndex: index,
      });
    }
    const itemLimit = kind === "video" ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
    if (stat.size > itemLimit) {
      throw createMediaInputError(`media[${index}] exceeds the ${kind} size limit`, {
        reason: "media_limit_exceeded",
        mediaIndex: index,
        maxBytes: itemLimit,
      });
    }
    totalBytes += stat.size;
    if (totalBytes > MAX_TOTAL_MEDIA_BYTES) {
      throw createMediaInputError("media exceeds the total size limit", {
        reason: "media_limit_exceeded",
        maxBytes: MAX_TOTAL_MEDIA_BYTES,
      });
    }

    return {
      kind,
      path: filePath,
      mimeType: normalizedMimeType,
      name:
        typeof item.name === "string" && item.name.trim()
          ? path.basename(item.name.trim())
          : path.basename(filePath),
      sizeBytes: stat.size,
    };
  });
}

export function resolveTurnMedia(sessionOptions, turnOptions = {}) {
  const media = normalizeMediaInputs(turnOptions.media);
  if (!turnOptions.useInitialImages || !Array.isArray(sessionOptions?.initialImages)) {
    return media;
  }
  const legacy = sessionOptions.initialImages
    .filter((item) => typeof item === "string" && item.trim())
    .map((filePath) => ({
      kind: "image",
      path: path.resolve(sessionOptions?.cwd || process.cwd(), filePath.trim()),
      mimeType: inferMimeType(filePath.trim(), "image"),
    }));
  const combined = [...normalizeMediaInputs(legacy), ...media];
  const seen = new Set();
  return combined.filter((item) => {
    const key = `${item.kind}:${item.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function assertMediaCapabilities(media, backend, capabilities) {
  for (const [index, item] of media.entries()) {
    if (capabilities?.[item.kind] !== MEDIA_CAPABILITY_NATIVE) {
      throw createMediaInputError(`${backend} does not support ${item.kind} input`, {
        reason: "unsupported_media",
        backend,
        mediaKind: item.kind,
        mediaIndex: index,
      });
    }
  }
}

export function fileMediaToDataUri(media) {
  return `data:${media.mimeType};base64,${fs.readFileSync(media.path).toString("base64")}`;
}

export function fileMediaToBase64(media) {
  return fs.readFileSync(media.path).toString("base64");
}

export function createMediaInputError(message, extras = {}) {
  const error = new Error(message);
  for (const [key, value] of Object.entries(extras)) {
    error[key] = value;
  }
  return error;
}

export function defaultPromptForMedia(media) {
  const hasVideo = media.some((item) => item.kind === "video");
  return hasVideo ? "Analyze the attached media." : "Analyze the attached images.";
}
