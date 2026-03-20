# Chrome plug-in design -- GPT Chat ↔ MCP ↔ App Bridge

> Goal: In multiple GPT chat pages (ChatGPT, Gemini, Grok, Qwen, DeepSeek...), capture the current session and push it to the app through MCP, while receiving the app's downstream messages and injecting them into the page for sending. Using MV3, TypeScript and MCP SDK/WebSocket.

---
## 🎯 Scope and Principles
- Supports uplink (chat content → MCP/app) and downlink (app → chat window sending).
- No intrusion into the site: only DOM reading and writing and event simulation, no modification of page scripts.
- Extensible: New sites only need to implement the adapter interface and register.
- Minimum permissions: `host_permissions` only lists adapted domain names; configuration/logs are stored in `chrome.storage.local`.

---
## 🧩 Module division & dependency
1) **background/service worker**
   - Responsibilities: unified routing, status, reconnection, queue; holding MCP client; managing tab ↔ adapter binding.
   - Depends on: `transport/mcp_client`, `domain/models`, `adapters/index`, `storage`.
2) **transport/mcp_client**
   - Encapsulate MCP SDK/WebSocket (upstream sendEnvelope, downstream onEnvelope).
   - Depends on: `config`, `logger`.
3) **adapters (content scripts, per site)**
   - Responsibilities: DOM parsing, streaming monitoring, input/send injection.
   - Interface: `detect()`, `readSession()`, `readMessages()`, `onNewMessage(cb)`, `sendMessage(text)`.
   - Depends on: `common/dom-utils`, `message-serializer`.
4) **storage/config**
   - `chrome.storage.local` Persistent MCP endpoints, switches, site preferences; in-memory queue cache of undelivered messages.
5) **ui (popup/options)**
   - Configure MCP endpoint/token, site switch, log viewing; call background API.
6) **logger**
   - Lightweight hierarchical logs; content → background are collected uniformly to facilitate troubleshooting.

Dependency flow direction: `adapters -> background -> transport -> MCP/app`; `popup/options -> background`; `storage/logger` are cross-cutting dependencies.

---
## 📡 Data model and transmission
- `Session`: `{ id, provider, url, title?, createdAt, updatedAt }`
- `Message`: `{ id, sessionId, role: 'user' | 'assistant' | 'system', content, ts, meta: { streaming?: bool, providerMessageId?, status? } }`
- `TransportEnvelope`: `{ type: 'session_update' | 'message' | 'command', payload, traceId }`
- `Target`: `{ provider, sessionId, tabId }` is used for precise downstream delivery.
- Deduplication: `providerMessageId` takes priority; otherwise `(role, content hash, ts bucket)` is used.

---
## 🔄 Core process
### Uplink (page → MCP → app)
1. Content script `detect()` initializes the adapter after success.
2. `readSession()` + `readMessages()` constructs `session_update` and history `message`, which are sent to the background via `chrome.runtime.sendMessage`.
3. The background is pushed through `mcp_client.sendEnvelope`; if the network is interrupted, it is put into the local queue and waits for resend.
4. `onNewMessage` + `MutationObserver` monitor user input and model streaming output, and push incremental/completed status in real time.

### Downstream (app → MCP → Plug-in → Page)
1. MCP issues `TransportEnvelope{type:'message', payload:{target, message}}`.
2. The background locates the adapter according to `tabId/provider` and forwards it to the corresponding content script.
3. adapter `sendMessage(text)`: Write to the input box and trigger sending (button click priority, fallback to Enter).
4. Report a `user` message immediately after sending to ensure session alignment.

### Connectivity and Robustness
- WebSocket automatically reconnects after disconnection (exponential backoff), and replays the undelivered queue after recovery.
- When the site misses a selector, it prompts for an update; multiple sets of selectors are rolled back step by step.
- Shadow DOM auxiliary: `queryShadowAll` recursively enters `shadowRoot` to select nodes.

---
## 🖼 Key points of site adaptation (the first version of selector needs actual testing and adjustment)
- **ChatGPT**: Message `div[data-testid^="conversation-turn-"]`; input `textarea[data-id="root"]`/`textarea[placeholder*="Send"]`; send `button[data-testid="send-button"]`; stream listening for `.result-streaming` or message node text changes.
- **Gemini**: The message list contains `data-md`; the input bottom is `textarea`; the send button is adjacent to `button[aria-label*='send']`; lazy loading requires delayed observation.
- **Grok**: Custom web component, need to penetrate `shadowRoot`; message list & input are located inside the component, buttons often have `aria-label` description.
- **Qwen**: Message node `div[data-role]`; input `textarea`; send button fixed class/`aria-label`; DOM continuous append during streaming.
- **DeepSeek**: The message container class contains `conversation`; enter `textarea`; the button is the same level as `button`; pay attention to the asynchronous rendering caused by anti-crawling, and you need to retry the query.

---
## ⚙️ Key implementation details
- **Send injection**: After setting `textarea.value = text`/`textContent`, trigger the `input`/`change` event; click the send button first, and if it fails, simulate `keydown Enter` (with `metaKey/ctrlKey` if necessary).
- **Streaming Listening**: `MutationObserver` subscribes to the message list `childList + subtree`, and generates streaming chunks for new nodes and text changes; mark `streaming=false/status=done` after completion.
- **Session Identification**: Prioritize the URL fragment (such as ChatGPT `/c/<id>`), otherwise use the page title + first message hash to generate a pseudo ID.
- **Cleaning and Security**: Clear input after sending; do not store sensitive content across sites; option to switch site collection.

---
## 🧪 Test Strategy
- Unit (Jest): `dom-utils`, deduplication logic, adapter parsing function (using mock DOM).
- Integration (Playwright): drive target site, verify `readMessages`, streaming monitoring, `sendMessage` success rate.
- Hand test: Create new sessions at each site, verify that upstream push, downstream injection, and reconnection/queue are available.

---
## 🗺 Project plan (dependency order)
1) **Infrastructure**: Build MV3 + TS + build (Vite/Rollup); complete `domain/models`, `logger`, `storage`.
2) **Transport/MCP**: Implement `mcp_client` (WS + fallback HTTP) to open the send/on channel with the app.
3) **Background routing**: message distribution, reconnection, queue, tab ↔ adapter management.
4) **ChatGPT adaptation (first available link)**: implement adapter (reading, streaming monitoring, sending); open end-to-end upstream/downstream.
5) **Popup/Options**: Configure MCP endpoint/token, site switch, log panel.
6) **Other site adaptation**: Gemini → Grok → Qwen → DeepSeek, reuse adapter abstraction and DOM tools.
7) **Robustness**: Multiple selector fallback, Shadow DOM support, error prompts and queue compensation.
8) **Test Matrix**: Unit + Playwright integration; supplemented with hand test scripts/documents.

---
## 🔌 Future expansion
- More site/local models; multi-session parallelism; configurable message filtering/desensitization; i18n; optional SSE adaptation to MCP downlink. 

---
## 🗃️ Add/change file list (required for implementation)
- `modules/chrome_extension/manifest.json`: MV3 manifest, declares background service worker, content scripts, host_permissions, options/popup.
- `modules/chrome_extension/src/background.ts`: Service worker main entrance, routing messages, managing tab ↔ adapter, calling MCP client, queue/reconnection.
- `modules/chrome_extension/src/transport/mcp_client.ts`: MCP/WebSocket client encapsulation, send/on, reconnection, queue compensation.
- `modules/chrome_extension/src/domain/models.ts`: Session/Message/TransportEnvelope/Target and other data structures and types.
- `modules/chrome_extension/src/adapters/index.ts`: Site adapter registration and selection logic.
- `modules/chrome_extension/src/adapters/chatgpt.ts`: ChatGPT adaptation (detect/read/send/stream).
- `modules/chrome_extension/src/adapters/gemini.ts`: Gemini adaptation.
- `modules/chrome_extension/src/adapters/grok.ts`: Grok adaptation (including Shadow DOM processing).
- `modules/chrome_extension/src/adapters/qwen.ts`: Qwen adaptation.
- `modules/chrome_extension/src/adapters/deepseek.ts`: DeepSeek adaptation.
- `modules/chrome_extension/src/common/dom-utils.ts`: Selector fallback, Shadow DOM recursion, event triggering, MutationObserver packaging.
- `modules/chrome_extension/src/common/message-serializer.ts`: DOM to Message, deduplication hashing, status marking.
- `modules/chrome_extension/src/common/logger.ts`: Lightweight hierarchical log, provided to popup for viewing.
- `modules/chrome_extension/src/common/storage.ts`: `chrome.storage.local` access, configuration and undelivery queue.
- `modules/chrome_extension/src/popup/index.tsx`: Configure/log UI, call background API.
- `modules/chrome_extension/src/options/index.tsx`: MCP endpoint, token, site switch configuration page.
- `modules/chrome_extension/src/types/chrome.d.ts`: (optional) Supplementary chrome API TS type.
- `modules/chrome_extension/vite.config.ts` or equivalent build configuration: package background/content/popup/options and generate MV3 product.
