# cli2sdk -- Universal Code‑LLM CLI → SDK packaging framework

> **Goal**: Unify *a variety of AI Code CLI tools* (Claude / Gemini / Cursor‑CLI / extensible) into a JS/TS SDK, and provide:
> - run in one request
> - Multi-turn dialogue/persistent session
> - streaming output
> - Multiple Providers hot-swappable

---
## 🎯 Product positioning
| Current situation | After using cli2sdk |
|---|---|
| Each CLI/interface method is different | Unified SDK, one-time learning and full adaptation |
| Lack of session/streaming capabilities | Built-in ChatSession + SSE streaming output |
| New Provider has high access cost | Provider plug-in → Add one in 5 minutes |
| Experience fragmentation | run / session / stream three things unified API |

---
## ⭐ Target user experience
```ts
import { cli2sdk } from "cli2sdk";

const sdk = cli2sdk({ provider: "claude", apiKey: CLAUDE_API });

const result = await sdk.run("Explanation quicksort");console.log(result.text);

//Multiple rounds of sessionsconst chat = sdk.session();
await chat.ask("A* search concept")await chat.ask("Write me pseudocode to continue")console.log(chat.history)

// Streaming
for await (const token of sdk.stream("Analyze this code:") )  process.stdout.write(token.delta);
```

---
## 📁 Code structure
```
cli2sdk/
├─ src/
│  ├─ index.ts
│  ├─ core/
│ │ ├─ base.ts # Provider unified abstraction layer│ │ ├─ chat_session.ts # Multiple rounds of dialogue│ │ ├─ stream.ts # Streaming Token analysis│ │ ├─ router.ts # Provider dynamic routing│ ├─ providers/ # 🔥 Add any new provider│  │  ├─ claude.ts
│  │  ├─ gemini.ts
│  │  ├─ cursor.ts
│  │  ├─ local_binary.ts
│  ├─ utils/
│ │ ├─ shell.ts # CLI process executor│ │ ├─ cache.ts # LRU cache/session persistence│  │  ├─ logger.ts
│  ├─ types/
│     ├─ provider.ts
│     ├─ message.ts
│     ├─ result.ts
└─ package.json
```

---
## 🧠 Provider abstraction layer (core)
```ts
export abstract class CodeProvider {
  abstract run(prompt: string, options?): Promise<ResultChunk>;
  abstract stream(prompt: string, options?): AsyncGenerator<ResultChunk>;
  chatHistory?: Message[];
}
```
> Each CLI only needs `extends CodeProvider` to connect successfully.

---
## 🔄 Provider routing
```ts
export const cli2sdk = (config: Config) => ({
  run:      (...args) => router(config).run(...args),
  session:  () => new ChatSession(router(config)),
  stream:   (...args) => router(config).stream(...args)
});
```
support:
```
provider="claude" | "gemini" | "cursor" | "auto"
```

---
## 💬 ChatSession multi-round session
```ts
class ChatSession {
  history = [];
  constructor(provider){ this.p = provider; }
  async ask(q){
    const r = await this.p.run(q,{history:this.history});
    this.history.push(r);
    return r;
  }
}
```
Support: save()/load()/token truncation/LRU memory cache

---
## 🌐 Streaming output
```ts
for await (const t of sdk.stream("Go vs Rust optimization strategy"))  process.stdout.write(t.delta);
```
The bottom layer is unified and `utils/shell.ts` is analyzed `stdout chunk`

---
## 📦 Roadmap
| Version | Feature |
|---|---|
| **0.1.0** | Claude+Gemini+Cursor provider adaptation completed |
| **0.2.0** | ChatSession + Streaming stable version |
| **0.3.0** | Provider plug-in mechanism (users can hot-plug and customize) |
| **1.0 Release** | ReAct / Agent / Tools call integration |

---
## 🧪 Test CLI (Claude example)
1. Install dependencies and build: `npm install --prefix modules/cli2sdk`
2. Configure Claude CLI path (default search `claude`):`export CLI2SDK_CLAUDE_BIN=$(which claude)`
3. Run a one-time call: `npx --prefix modules/cli2sdk cli2sdk-claude "Explain quicksort"`
4. Enter multiple rounds of interaction: `npx --prefix modules/cli2sdk cli2sdk-claude --interactive`
   - Added `--stream` to output tokens in real time

Environment variables such as `CLI2SDK_CLAUDE_ARGS="--response-format json"` can override the default parameters; similarly, the `provider` configuration can be rewritten to switch Gemini/Cursor/local.
``

