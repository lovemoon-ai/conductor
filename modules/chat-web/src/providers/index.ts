import { registerProvider } from "../core/provider.js";

import { ChatGPTAdapter } from "./chatgpt.js";
import { DeepSeekAdapter } from "./deepseek.js";
import { GeminiAdapter } from "./gemini.js";

export { ChatGPTAdapter } from "./chatgpt.js";
export { DeepSeekAdapter } from "./deepseek.js";
export { GeminiAdapter } from "./gemini.js";

/**
 * Register all bundled providers. Call this once at process startup
 * (CLI / daemon entrypoints already do so).
 */
export function registerBuiltinProviders(): void {
  registerProvider(new ChatGPTAdapter());
  registerProvider(new DeepSeekAdapter());
  registerProvider(new GeminiAdapter());
}
