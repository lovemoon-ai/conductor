import { registerProvider } from "../core/provider.js";

import { AIStudioAdapter } from "./aistudio.js";
import { ChatGPTAdapter } from "./chatgpt.js";
import { DeepSeekAdapter } from "./deepseek.js";
import { GeminiAdapter } from "./gemini.js";

export { AIStudioAdapter } from "./aistudio.js";
export { ChatGPTAdapter } from "./chatgpt.js";
export { DeepSeekAdapter } from "./deepseek.js";
export { GeminiAdapter } from "./gemini.js";

/**
 * Register all bundled providers. Call this once at process startup
 * (CLI / daemon entrypoints already do so).
 *
 * Note: `gemini` and `aistudio` are TWO different products under the
 * same brand (consumer chat vs developer playground) — both shipped so
 * users can pick whichever their network / API-key setup supports.
 */
export function registerBuiltinProviders(): void {
  registerProvider(new ChatGPTAdapter());
  registerProvider(new DeepSeekAdapter());
  registerProvider(new GeminiAdapter());
  registerProvider(new AIStudioAdapter());
}
