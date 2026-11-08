/**
 * Public entry point for `@love-moon/chat-web`.
 *
 * ChatRuntimeClient and RuntimeChatSession connect to an isolated multi-chat
 * daemon. The CLI exposes serve/chat/turn commands.
 * QueuedChatSession shares a browser and turn queue across tasks/processes.
 * ChatSession offers exclusive ownership and direct Playwright Page access.
 *
 * @example
 *   import { ChatSession, registerBuiltinProviders } from "@love-moon/chat-web";
 *
 *   registerBuiltinProviders();
 *   const session = await ChatSession.open("chatgpt");
 *   try {
 *     const r1 = await session.send("Hello");
 *     const r2 = await session.send("Tell me more");
 *     console.log(r1.response, r2.response);
 *   } finally {
 *     await session.close();
 *   }
 */

// Primary session API.
export {
  ChatSession,
  withSession,
  type SendOptions,
  type SendResult,
  type SessionOpenOptions,
} from "./session.js";

export { QueuedChatSession } from "./queued-session.js";

// Provider plumbing.
export * from "./core/provider.js";
export * from "./providers/index.js";

// Supporting types & utilities — exposed because SDK consumers occasionally
// need them (custom providers, custom snapshots, custom error handling, ...).
export * from "./core/errors.js";
export * from "./core/profile-manager.js";
export * from "./core/browser.js";
export * from "./core/install-chromium.js";
export * from "./core/paths.js";
export * from "./core/response-watcher.js";
export * from "./core/snapshot.js";
export * from "./core/locator-score.js";
export * from "./core/logger.js";

// CLI commands as SDK functions, in case callers want to drive them
// programmatically (e.g. a UI that runs doctor and renders the report).
export * from "./commands/index.js";

// Isolated multi-chat runtime and local socket client.
export * from "./runtime/index.js";
