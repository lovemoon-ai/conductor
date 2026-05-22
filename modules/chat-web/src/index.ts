/**
 * Public entry point for `@love-moon/chat-web`.
 *
 * The primary SDK surface is `ChatSession` — multi-turn dialogue against
 * a persistent browser profile. CLI users get `login`, `doctor`, `info`;
 * everything else (ask, daemon, ...) lives at the SDK level.
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

// Provider plumbing.
export * from "./core/provider.js";
export * from "./providers/index.js";

// Supporting types & utilities — exposed because SDK consumers occasionally
// need them (custom providers, custom snapshots, custom error handling, ...).
export * from "./core/errors.js";
export * from "./core/profile-manager.js";
export * from "./core/browser.js";
export * from "./core/paths.js";
export * from "./core/response-watcher.js";
export * from "./core/snapshot.js";
export * from "./core/locator-score.js";
export * from "./core/logger.js";

// CLI commands as SDK functions, in case callers want to drive them
// programmatically (e.g. a UI that runs doctor and renders the report).
export * from "./commands/index.js";
