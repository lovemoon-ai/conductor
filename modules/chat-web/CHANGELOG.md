# @love-moon/chat-web

## 0.4.2

## 0.4.1

### Patch Changes

- aada753: Add explicit ChatGPT and Gemini web backend aliases, expose project icon
  configuration in generated CLI settings, and default browser-backed session
  checks to headed mode for reliable authenticated detection.

## 0.4.0

### Minor Changes

- 4ecc359: Publish the chat-web browser runtime and wire it into the CLI and AI SDK for
  ChatGPT and Gemini web sessions, including provider error handling and local
  development installation support.

  Ship app SDK realtime history catch-up and the CLI/AI SDK goal-mode and custom
  command runtime updates included in this release.

## 0.3.2

### Minor Changes

- Introduce the browser-backed chat runtime for ChatGPT, DeepSeek, and Gemini
  providers, packaged for integration with `@love-moon/ai-sdk`.
