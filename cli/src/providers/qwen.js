import createDeepseekProvider from './deepseek.js';

export default function createQwenProvider(context) {
  const base = createDeepseekProvider(context);

  function isVisible(el) {
    if (!el || !(el instanceof HTMLElement)) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  }

  function findNewChatButton() {
    const candidates = [
      'button.sidebar-new-chat',
      '.sidebar-new-chat',
      '#sidebar button.qwen-chat-btn',
      '#sidebar [aria-label*="New Chat"]',
      '#sidebar [aria-label*="新建"]',
    ];
    for (const selector of candidates) {
      const el = document.querySelector(selector);
      if (el instanceof HTMLElement) {
        return el;
      }
    }
    const sidebarButtons = Array.from(document.querySelectorAll('#sidebar button, #sidebar [role="button"]'));
    return sidebarButtons.find(btn => {
      const text = (btn.innerText || btn.textContent || '').toLowerCase();
      const aria = `${btn.getAttribute('aria-label') || ''}`.toLowerCase();
      return (text.includes('new chat') || aria.includes('new chat')) && isVisible(btn);
    });
  }

  function findQwenMessages() {
    const blocks = Array.from(
      document.querySelectorAll('.qwen-chat-message-assistant .response-message-content .qwen-markdown'),
    );
    return blocks
      .map(el => {
        const text = (el.innerText || '').trim();
        return text ? { element: el, text } : null;
      })
      .filter(Boolean);
  }

  base.receive_message = () => {
    const messages = findQwenMessages();
    if (messages.length === 0) {
      return base.receive_message(); // fallback to generic heuristic
    }
    const latest = messages[messages.length - 1];
    context.highlight(latest.element);
    return {
      ok: true,
      message: '获取到 AI 回复',
      latest: latest.text,
      count: messages.length,
    };
  };

  async function waitForNewChatButton(timeoutMs = 3000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const btn = findNewChatButton();
      if (btn && isVisible(btn)) {
        return btn;
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    return null;
  }

  async function create_task() {
    const btn = await waitForNewChatButton();
    if (btn) {
      context.highlight(btn);
      setTimeout(() => btn.click(), 500);
      return { ok: true, message: '找到 Qwen 新建对话按钮' };
    }
    const fallback = base.create_task();
    return fallback;
  }

  function findQwenInput() {
    const selectors = ['#chat-input', '.chat-input-container textarea', '.chat-input textarea', '.chat-input'];
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
        // Qwen placeholder view may start with opacity 0; allow even if not visible yet.
        if (isVisible(el) || selector === '#chat-input') return el;
      }
    }
    const placeholderInput = Array.from(document.querySelectorAll('textarea, input[type="text"], input[type="search"]')).find(el => {
      const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
      return placeholder.includes('help you today') || placeholder.includes('请输入') || placeholder.includes('message');
    });
    return placeholderInput || null;
  }

  async function waitForInput(timeoutMs = 3000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const input = findQwenInput();
      if (input) return input;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    return null;
  }

  function setInputValue(input, text) {
    // Apply to all candidate inputs to handle layered placeholders.
    const inputs = new Set([
      input,
      ...Array.from(
        document.querySelectorAll('#chat-input, .chat-message-input textarea, .chat-input textarea, textarea[name="chat-input"]'),
      ),
    ]);

    inputs.forEach(el => {
      if (!(el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement)) return;
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
      const setter = descriptor?.set;
      el.focus();
      el.click();
      if (setter) {
        setter.call(el, text);
      } else {
        el.value = text;
      }
      el.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          cancelable: true,
          data: text,
          inputType: 'insertText',
        }),
      );
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  function dispatchEnter(input) {
    const keyboardEventInit = {
      bubbles: true,
      cancelable: true,
      key: 'Enter',
      code: 'Enter',
      which: 13,
      keyCode: 13,
    };
    input.dispatchEvent(new KeyboardEvent('keydown', keyboardEventInit));
    input.dispatchEvent(new KeyboardEvent('keypress', keyboardEventInit));
    input.dispatchEvent(new KeyboardEvent('keyup', keyboardEventInit));
  }

  function findQwenSendButton() {
    const selectors = [
      '.chat-message-input button[type="submit"]',
      '.chat-message-input .ant-btn-primary',
      '.chat-message-input .ant-btn-icon-only',
      '.chat-message-input [aria-label*="send" i]',
      '.chat-message-input [data-testid*="send"]',
    ];
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el instanceof HTMLElement && isVisible(el)) {
        return el;
      }
    }
    return null;
  }

  async function send_message(text) {
    const input = await waitForInput();
    if (!input) {
      return base.send_message(text);
    }
    setInputValue(input, text || '');
    const sendBtn = findQwenSendButton();
    if (sendBtn) {
      context.highlight(sendBtn);
      setTimeout(() => sendBtn.click(), 200);
    } else {
      context.highlight(input);
      setTimeout(() => dispatchEnter(input), 200);
    }
    return {
      ok: true,
      message: `填充消息${sendBtn ? '并尝试点击发送' : '并回车发送'}`,
      sendButton: sendBtn ? 'Qwen send button' : null,
    };
  }

  return {
    ...base,
    create_task,
    send_message,
    receive_message: base.receive_message,
  };
}
