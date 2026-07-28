# [CLOSED — NOT A BUG] P2 — message input intermittently triggers a React update loop

## Resolution (2026-07-28): 经复核不成立,关闭

- **Status: CLOSED — not a confirmed product defect (dev-only).** Reclassified from P2 after source review.
- **Root cause of the report:** dev-environment noise, not a structural re-render loop. `make run-dev` runs Next.js in dev mode, where StrictMode / HMR / the error overlay surface transient warnings that do not occur in the shipped product. The symptom's signature — intermittent, appears on new-task / task-restart, clears after a full reload — is characteristic of dev/HMR/StrictMode, not a real loop (a genuine `Maximum update depth exceeded` reproduces on every render, including after a fresh reload).
- **Code evidence** (`web/src/features/chat/components/MessageInput.tsx`):
  - The cited frames only fire on real keystrokes: `:165` is `setContent` inside `updateContent`, `:528` is the textarea `onChange` → `updateContent`. Neither runs during render, so neither can self-perpetuate.
  - The one loop-prone effect (auto-resize, `:209-266`) is correctly guarded: dependency array is `[content]` only (`:266`, does not include the `layoutState` it updates), and `setLayoutState` uses a functional updater that returns the same reference when unchanged (`:258-265`), so React bails out — it converges in one pass.
  - The other self-referential effect (`:380-384`) converges in a single step; no `setState`-in-render anywhere in the component.
- **Verification gap:** the error was never reproduced on a production build. Per the updated SOP, dev-overlay React errors must be re-verified on a production build before grading.
- **SOP updated to prevent recurrence:** `claw/sop/05_qa.md` — §9 bug-reporting rule now requires production-build re-verification for dev-overlay React errors before assigning severity or filing.
- No `claw/lessons/` entry is required: this is not a confirmed product bug, so the `ui`-lesson handoff below is void. If it is ever reproduced on a production build, reopen with the production-build evidence attached.

---

## Symptom

Typing a normal prompt in Message input can raise an uncaught React
`Maximum update depth exceeded` error. In the dev QA surface, Next.js shows an
issue badge. The typed message can still be sent and the AI reply completes.

## Environment

- Local E2E on `main`; product sources at `5fef287`.
- Web: `make run-dev`, `http://localhost:6152/`.
- Browser driver: Chrome DevTools MCP, viewport 1440×1000.

## Reproduction

1. Open an active AI task.
2. Focus Message input.
3. Type a normal prompt through Chrome DevTools MCP `type_text`.
4. Inspect browser console.

The error occurred during the new-task happy path and reproduced again after a
separate existing task was restarted. A later attempt after a full reload did
not reproduce, so the condition is intermittent.

## Expected vs observed

- Expected: typing updates the message field without uncaught client errors.
- Observed: console reports
  `Uncaught Error: Maximum update depth exceeded`, with stack frames at
  `MessageInput.tsx:165:5` and `MessageInput.tsx:528:32`.

## Severity and suspected layer

- Severity: **P2 (minor)** — intermittent client error; the message-send and
  AI-reply path still succeeds.
- Suspected layer: **UI state / final state**.

## Evidence

- Screenshot:
  `claw/issues/tmp_release-post-v0.7.7-qa-20260727/tmp_evidence/tmp_round3_C0_happy_path_pass.png`
- Console capture:
  `claw/issues/tmp_release-post-v0.7.7-qa-20260727/tmp_evidence/tmp_round3_browser_console_network.md`

## Fix handoff

Because this is a normal product-usage bug, the eventual bugfix commit must add
one `ui` lesson under `claw/lessons/` as required by the repository review
guidelines.
