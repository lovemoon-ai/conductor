import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ChatGPTAdapter } from "../src/providers/chatgpt.js";
import { GeminiAdapter } from "../src/providers/gemini.js";
import { KimiAdapter } from "../src/providers/kimi.js";

describe.skipIf(!existsSync(chromium.executablePath()))("provider conversation restore", () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
  afterAll(async () => { await browser?.close(); });

  it("settles a restored Kimi stream before allowing the next prompt", async () => {
    const page = await browser.newPage();
    try {
      await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html>
        <button data-testid="sidebar-user-menu-trigger">Account</button>
        <div class="chat-input-editor" contenteditable="true" role="textbox">Composer ready</div>
        <div class="segment-user">Previously submitted prompt</div>
        <div class="send-button-container disabled">Send</div>
        <script>
          window.stops = 0;
          const send = document.querySelector('.send-button-container');
          // History renders before the stream's hydrated state.
          setTimeout(() => send.className = 'send-button-container stop', 150);
          send.onclick = () => {
            window.stops++;
            send.className = 'send-button-container loading';
            setTimeout(() => send.className = 'send-button-container disabled', 100);
          };
        </script>` }));
      await new KimiAdapter().resumeConversation(page, "6a103f7e-bd94-83ea-ae46-9652657bbedf");
      expect(await page.locator('.send-button-container').getAttribute('class')).toBe('send-button-container disabled');
      expect(await page.evaluate(() => (window as unknown as { stops: number }).stops)).toBe(1);
      expect(await page.locator('.chat-input-editor').innerText()).toBe('Composer ready');
      expect(await page.locator('.segment-user').count()).toBe(1);
    } finally { await page.close(); }
  });

  it.each([
    [new KimiAdapter(), "https://www.kimi.com/chat/6a103f7e-bd94-83ea-ae46-9652657bbedf", '<div class="segment-user">Saved prompt</div>'],
    [new ChatGPTAdapter(), "https://chatgpt.com/c/6a103f7e-bd94-83ea-ae46-9652657bbedf", '<div data-message-author-role="user">Saved prompt</div>'],
    [new GeminiAdapter(), "https://aistudio.google.com/prompts/6a103f7e-bd94-83ea-ae46-9652657bbedf", '<ms-chat-turn>Saved prompt</ms-chat-turn>'],
  ] as const)("%s restores history before returning and never submits a prompt", async (provider, url, history) => {
    const page = await browser.newPage();
    try {
      await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html>
        <button data-testid="sidebar-user-menu-trigger">Account</button>
        <div id="prompt-textarea" class="chat-input-editor" contenteditable="true" role="textbox">Composer ready</div>
        <textarea aria-label="Enter a prompt"></textarea>
        <main></main>
        <script>
          window.submissions = 0;
          document.addEventListener('click', () => window.submissions++);
          document.addEventListener('keydown', () => window.submissions++);
          setTimeout(() => document.querySelector('main').innerHTML = ${JSON.stringify(history)}, 100);
        </script>` }));
      await provider.resumeConversation(page, "6a103f7e-bd94-83ea-ae46-9652657bbedf");
      expect(page.url()).toBe(url);
      expect(provider.getConversationId(page)).toBe("6a103f7e-bd94-83ea-ae46-9652657bbedf");
      expect(await page.locator("main").innerText()).toBe("Saved prompt");
      expect(await page.evaluate(() => (window as unknown as { submissions: number }).submissions)).toBe(0);
    } finally { await page.close(); }
  });
});
