import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { KimiAdapter, readKimiPage } from "../src/providers/kimi.js";
import { ChatSession } from "../src/session.js";

// Unit turn-state tests always run. These DOM/SDK integration tests also run
// when Playwright Chromium is installed; no website account/network is needed.
describe.skipIf(!existsSync(chromium.executablePath()))("Kimi browser integration", () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
  afterAll(async () => { await browser?.close(); });

  it("distinguishes an editable signed-out page, an account, and an expired login", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<button class="login-button">Log in</button><div class="chat-input-editor" contenteditable="true" role="textbox"></div>');
      const adapter = new KimiAdapter();
      expect(await adapter.isLoggedIn(page)).toBe(false);
      expect(await adapter.findInput(page)).toBeTruthy();
      await page.setContent('<button data-testid="sidebar-user-menu-trigger">Account</button>');
      expect(await adapter.isLoggedIn(page)).toBe(true);
      await page.locator('body').evaluate((body) => { const modal = document.createElement('div'); modal.className = 'login-modal-next-mask'; modal.textContent = 'Log in'; body.append(modal); });
      expect(await adapter.isLoggedIn(page)).toBe(false);
    } finally { await page.close(); }
  });

  it("preserves answer code/links and excludes user text, thinking and tool cards", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <div class="segment-user"><div class="markdown">User text</div></div>
        <div class="segment-assistant"><div class="segment-content-box">
          <div class="thinking-container"><div class="markdown">Hidden thinking</div></div>
          <div class="toolcall-container"><div class="markdown">Tool card</div></div>
          <div class="markdown"><p>Hello <strong>world</strong>. <a href="https://example.com/">Source</a></p>
            <div class="segment-code"><header class="segment-code-header"><span class="segment-code-lang">Python</span><button>Copy</button></header><pre class="segment-code-content">print(42)\nprint(43)</pre></div>
            <p>Use <code>value</code>.</p>
          </div>
        </div><div class="segment-assistant-actions">Copy Like</div></div>
      `);
      const snapshot = await page.evaluate(readKimiPage);
      expect(snapshot.assistants).toHaveLength(1);
      const text = snapshot.assistants[0]!.text;
      expect(text).toContain('Hello **world**. [Source](https://example.com/)');
      expect(text).toContain('```python\nprint(42)\nprint(43)\n```');
      expect(text).toContain('Use `value`.');
      expect(text).not.toMatch(/User text|Hidden thinking|Tool card|Copy|Like/);
    } finally { await page.close(); }
  });

  it("serializes multi-turn sends in one page and starts a clean conversation on newChat", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const profile = mkdtempSync(path.join(tmpdir(), 'kimi-browser-test-'));
    const adapter = new KimiAdapter();
    await page.route('https://www.kimi.com/**', (route) => route.fulfill({ contentType: 'text/html', body: fixture }));
    const session = ChatSession.fromBrowser({ provider: adapter, context, page, userDataDir: profile });
    try {
      await adapter.open(page);
      const progress: string[] = [];
      const [first, second] = await Promise.all([
        session.send('remember 42\nkeep it secret', { timeoutMs: 4000, stableMs: 10, onProgress: (text) => progress.push(text) }),
        session.send('what was the number?', { timeoutMs: 4000, stableMs: 10 }),
      ]);
      expect(first.response).toBe('Remembered 42');
      expect(second.response).toBe('42');
      expect([first.turnIndex, second.turnIndex]).toEqual([0, 1]);
      expect(await page.evaluate(() => (window as unknown as { prompts: string[] }).prompts)).toEqual(['remember 42\nkeep it secret', 'what was the number?']);
      expect(progress).toContain('Remembered 42');
      expect(session.conversationId).toBe('fixture-session');
      await session.newChat();
      expect(session.conversationId).toBeUndefined();
      expect(session.turns).toBe(0);
      const fresh = await session.send('what was the number?', { timeoutMs: 4000, stableMs: 10 });
      expect(fresh.response).toBe('No number remembered');
      expect(fresh.turnIndex).toBe(0);
    } finally { await session.close(); rmSync(profile, { recursive: true, force: true }); }
  });
});

const fixture = `<!doctype html><html><body>
<button data-testid="sidebar-user-menu-trigger">Account</button>
<main id="messages"></main>
<div class="chat-input-editor" contenteditable="true" role="textbox"></div>
<div class="send-button-container" style="width:40px;height:40px">Send</div>
<script>
window.prompts = [];
let number = '';
const input = document.querySelector('.chat-input-editor');
const send = document.querySelector('.send-button-container');
input.addEventListener('input', () => { send.className = input.innerText.trim() ? 'send-button-container' : 'send-button-container disabled'; });
send.onclick = () => {
  const message = input.innerText;
  window.prompts.push(message);
  const user = document.createElement('div'); user.className = 'segment-user'; user.textContent = message;
  const assistant = document.createElement('div'); assistant.className = 'segment-assistant';
  assistant.innerHTML = '<div class="segment-content-box"><div class="segment-pending-loading">Thinking</div></div>';
  document.querySelector('#messages').append(user, assistant);
  input.innerText = ''; send.className = 'send-button-container stop';
  history.replaceState({}, '', '/chat/fixture-session');
  setTimeout(() => {
    const answer = message.startsWith('remember') ? (number = '42', 'Remembered 42') : number || 'No number remembered';
    const box = assistant.querySelector('.segment-content-box');
    box.innerHTML = '<div class="markdown"><p></p></div>';
    box.querySelector('p').textContent = answer;
    send.className = 'send-button-container disabled';
  }, 80);
};
</script></body></html>`;
