import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

function inferExtensionFromMimeType(mimeType) {
  const normalized = String(mimeType || "").trim().toLowerCase();
  if (normalized === "image/png") return ".png";
  if (normalized === "image/jpeg") return ".jpg";
  if (normalized === "image/webp") return ".webp";
  if (normalized === "image/gif") return ".gif";
  if (normalized === "image/bmp") return ".bmp";
  if (normalized === "image/svg+xml") return ".svg";
  return ".bin";
}

function inferExtensionFromUrl(urlString) {
  try {
    const pathname = new URL(urlString).pathname || "";
    const ext = path.extname(pathname);
    return ext || ".bin";
  } catch {
    return ".bin";
  }
}

function parseDataUri(uri) {
  const match = String(uri || "").match(/^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,(.+)$/i);
  if (!match) {
    return null;
  }
  return {
    mimeType: match[1] || "application/octet-stream",
    data: match[2],
  };
}

async function writeTempFile(buffer, extension) {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "conductor-serve-ai-image-"));
  const filePath = path.join(tempDir, `${randomUUID()}${extension || ".bin"}`);
  await fs.promises.writeFile(filePath, buffer);
  return {
    filePath,
    cleanup: async () => {
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

async function materializeImageUrl(imageUrl, fetchImpl) {
  const dataUri = parseDataUri(imageUrl);
  if (dataUri) {
    const buffer = Buffer.from(dataUri.data, "base64");
    return writeTempFile(buffer, inferExtensionFromMimeType(dataUri.mimeType));
  }

  const response = await fetchImpl(imageUrl);
  if (!response.ok) {
    throw new Error(`failed to download image: HTTP ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  const mimeType = response.headers.get("content-type") || "";
  return writeTempFile(
    Buffer.from(arrayBuffer),
    mimeType ? inferExtensionFromMimeType(mimeType) : inferExtensionFromUrl(imageUrl),
  );
}

export async function materializeImageInputs(imageUrls, { fetchImpl = fetch } = {}) {
  const normalizedUrls = Array.isArray(imageUrls)
    ? imageUrls.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim())
    : [];
  const files = [];
  const cleanups = [];

  try {
    for (const imageUrl of normalizedUrls) {
      const file = await materializeImageUrl(imageUrl, fetchImpl);
      files.push(file.filePath);
      cleanups.push(file.cleanup);
    }
    return {
      files,
      cleanup: async () => {
        await Promise.allSettled(cleanups.map((fn) => fn()));
      },
    };
  } catch (error) {
    await Promise.allSettled(cleanups.map((fn) => fn()));
    throw error;
  }
}
