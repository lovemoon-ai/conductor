import { fileMediaToBase64, fileMediaToDataUri } from "./media-input.js";

export const UNSUPPORTED_MEDIA_CAPABILITIES = Object.freeze({
  image: "unsupported",
});

export const PROVIDER_MEDIA_CAPABILITIES = Object.freeze({
  "chat-web-session": UNSUPPORTED_MEDIA_CAPABILITIES,
  "claude-agent-sdk": Object.freeze({ image: "native" }),
  "codex-app-server": Object.freeze({ image: "native" }),
  "codex-exec": Object.freeze({ image: "native" }),
  "copilot-sdk": Object.freeze({ image: "native" }),
  "kimi-cli-print": Object.freeze({ image: "native" }),
  "kimi-cli-wire": Object.freeze({ image: "native" }),
  "opencode-sdk": Object.freeze({ image: "native" }),
});

export function buildCodexAppServerInput(promptText, media) {
  return [
    { type: "text", text: promptText },
    ...media.map((item) => ({ type: "localImage", path: item.path })),
  ];
}

export function buildClaudeContent(promptText, media) {
  return [
    { type: "text", text: promptText },
    ...media.map((item) => ({
      type: "image",
      source: {
        type: "base64",
        media_type: item.mimeType,
        data: fileMediaToBase64(item),
      },
    })),
  ];
}

export function buildCopilotAttachments(media) {
  return media.map((item) => ({
    type: "file",
    path: item.path,
    displayName: item.name,
  }));
}

export function buildKimiContent(promptText, media) {
  return [
    { type: "text", text: promptText },
    ...media.map((item) => ({ type: "image_url", image_url: { url: fileMediaToDataUri(item) } })),
  ];
}

export function buildOpencodeParts(promptText, media) {
  return [
    { type: "text", text: promptText },
    ...media.map((item) => ({
      type: "file",
      mime: item.mimeType,
      filename: item.name,
      url: fileMediaToDataUri(item),
    })),
  ];
}
