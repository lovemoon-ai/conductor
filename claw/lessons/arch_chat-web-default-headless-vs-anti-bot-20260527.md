# Conductor's chat-web wrapper inverted the SDK's headed-by-default

## Symptom

After fixing the M1 issue so the daemon properly advertised `web-chatgpt` and
`web-gemini`, the Web UI could create tasks against either alias, but every
task with `web-chatgpt` failed with:

```text
chat-web provider "chatgpt" is not logged in. Run: chat-web login chatgpt
```

even though `chat-web login chatgpt` had been completed and the profile
cookies were valid. Manual probe with `chat-web doctor chatgpt` (which
defaults to headed mode) reported `loggedIn: true`. `chat-web info chatgpt
--live` (which defaulted to headless) reported `loggedIn: false` against the
same profile.

## Root cause

Three layers, two of them with a default that contradicted the third.

- `modules/chat-web/src/core/browser.ts` — the actual browser launcher —
  documents headed as the project-wide default ("per RFC §19.3, better
  against anti-bot heuristics") and only flips to headless when the caller
  explicitly opts in or sets `CHAT_WEB_HEADLESS=1`.
- `modules/chat-web/src/commands/info.ts:65` defaulted `--live` probes to
  headless (`options.headless ?? true`). ChatGPT serves a stripped-down
  unauthenticated landing page to `chrome-headless-shell` even when the
  profile's cookies would otherwise authenticate the user. chat-web's
  `isLoggedIn()` checks for the ProseMirror composer; the bot page has none,
  so the probe returned `false`. Users who just successfully ran `login` saw
  `Logged in: no` and assumed their credentials were bad.
- `modules/ai-sdk/src/providers/chat-web-session.js:123` was the same bug
  one layer down, and the one that bit production: `this.headless =
  options.headless !== false`. Because daemon/serve-ai/fire never pass a
  `headless` option, that expression evaluates to `true`, and every
  `ChatWebSession` opened by Conductor ran in headless mode. The boot-time
  `isLoggedIn()` check returned `false`, throwing a `not_logged_in` error
  that surfaced in the Web UI as the operator-facing message. Users had no
  way to make this work short of editing the source — `chat-web login`
  alone was insufficient because the daemon never used the same browser
  shape as the login flow.

## Fix

- `modules/chat-web/src/commands/info.ts`: change `headless: options.headless
  ?? true` to `?? false`. Add a comment explaining the anti-bot rationale and
  pointing back to `core/browser.ts`. Callers that genuinely want a headless
  probe (CI, scripted health checks) still have `--headless` to opt in.
- `modules/ai-sdk/src/providers/chat-web-session.js`: flip the default so an
  unset option yields headed mode. Replace `options.headless !== false` with
  `options.headless === true`. Document why both layers must agree with
  chat-web's documented default.
- Rebuild `modules/ai-sdk` so the change lands in `dist/` (the package's
  `main` is `dist/index.js`; the daemon resolves the published shape, not
  `src/`).

Verified end-to-end via `ai-sdk`'s `createAiSession("chat-web", { model:
"chatgpt" }).runTurn("say only the word pong")` — boot succeeded, the chat
session opened a real Chrome window with the existing profile, ChatGPT
returned `text: "pong"` in 3.1s, and `providerUrl` pointed at a fresh
`https://chatgpt.com/c/<uuid>` conversation.

## How to avoid next time

- When wrapping an SDK that documents a non-trivial default, prefer
  forwarding `undefined` to the SDK rather than picking a wrapper-level
  default. `this.headless = options.headless` (and pass through verbatim)
  would have inherited the SDK's correct behaviour for free. If a wrapper
  *must* pick a default, the wrapper's default and the SDK's default must
  match and be tested together — drift between them is silent and breaks
  late.
- "Two probes disagree on the same profile" is a strong tell that the
  probes are not equivalent operations. Whenever a chat-web command takes a
  `headless` option, surface the resolved value (and the source: env var,
  CLI flag, default) in the CLI output so the user can see at a glance why
  the answer was what it was.
- Headed vs headless is **not** a performance knob for chat-web — it's a
  product-correctness knob, because ChatGPT/AI Studio actively distinguish
  the two. Treat any code path that flips it as needing a regression test.
- For Conductor specifically, when adding a new built-in backend that wraps
  an external SDK (chat-web, future browser-driving runtimes), include a
  one-shot smoke test in the install-cli verification step that opens the
  session and asserts `isLoggedIn` (or an equivalent health check)
  succeeds. Without it, the headless default flip would not have been
  caught at build time on a developer machine with valid profile cookies.
