const BUTTON_TEXTS = ['开启新对话', '新建对话', 'new chat', 'new conversation', '开启新對話', '新建對話', 'New Chat'];
const SEND_KEYWORDS = ['发送', 'send', 'submit', 'enter', 'send message', '发出', 'arrow', '↑', 'paper plane', 'plane'];
const AI_KEYWORDS = ['assistant', 'ai', 'bot', '系统', '回复'];

export default function createDeepseekProvider({ highlight, clearHighlights, addHighlight }) {
  function isVisible(el) {
    if (!el || !(el instanceof HTMLElement)) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
    if (rect.bottom < 0 || rect.top > window.innerHeight + 200) return false;
    return true;
  }

  function describe(el) {
    const text = (el.innerText || el.value || '').trim();
    const trimmed = text.length > 40 ? `${text.slice(0, 37)}...` : text;
    return `${el.tagName.toLowerCase()}${trimmed ? ` "${trimmed}"` : ''}`;
  }

  function getText(el) {
    return ((el.innerText || el.textContent || '').replace(/\s+/g, ' ') || '').trim();
  }

  function isClickable(el) {
    if (!(el instanceof HTMLElement)) return false;
    const tag = el.tagName.toLowerCase();
    const role = (el.getAttribute('role') || '').toLowerCase();
    const tabindex = el.getAttribute('tabindex');
    const style = window.getComputedStyle(el);
    const pointer = style.cursor === 'pointer';
    const dataClick = el.getAttribute('data-action') || el.getAttribute('data-testid') || '';
    return (
      tag === 'button' ||
      tag === 'a' ||
      tag === 'summary' ||
      (['input', 'div', 'span'].includes(tag) && el.getAttribute('onclick') != null) ||
      role === 'button' ||
      role === 'link' ||
      (tabindex && Number(tabindex) >= 0) ||
      pointer ||
      /button|click|toggle|new|plus/.test(dataClick.toLowerCase())
    );
  }

  function findButtonByText(texts) {
    const candidates = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      const el = walker.currentNode;
      if (!isClickable(el)) continue;
      if (!isVisible(el)) continue;
      const text = getText(el).toLowerCase();
      const aria = (
        `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.getAttribute('data-tooltip') || ''}`
      )
        .trim()
        .toLowerCase();
      const combined = `${text} ${aria}`;
      if (!combined) continue;
      if (texts.some(target => combined.includes(target.toLowerCase()))) {
        candidates.push({ el, score: combined.length });
      }
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.score - b.score);
    return candidates[0].el;
  }

  function findClosestClickable(el) {
    let current = el;
    while (current && current !== document.body) {
      if (isClickable(current) && isVisible(current)) return current;
      current = current.parentElement;
    }
    return null;
  }

  function findNewChatButton() {
    const button = findButtonByText(BUTTON_TEXTS);
    if (button) return button;
    const maybePlus = Array.from(document.querySelectorAll('[aria-label],[title],[data-testid]')).find(el => {
      if (!isVisible(el)) return false;
      if (!isClickable(el)) return false;
      const label = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.getAttribute('data-testid') || ''}`
        .toLowerCase();
      return BUTTON_TEXTS.some(t => label.includes(t.toLowerCase()));
    });
    if (maybePlus) return maybePlus;

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const textNode = walker.currentNode;
      const text = (textNode.textContent || '').toLowerCase().trim();
      if (!text) continue;
      if (!BUTTON_TEXTS.some(t => text.includes(t.toLowerCase()))) continue;
      const clickable = findClosestClickable(textNode.parentElement);
      if (clickable) return clickable;
    }
    return null;
  }

  function scoreInput(el) {
    let score = 0;
    const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
    const aria = (el.getAttribute('aria-label') || '').toLowerCase();
    const classes = (el.className || '').toLowerCase();
    if (el.tagName === 'TEXTAREA') score += 2;
    if (el.getAttribute('contenteditable') === 'true') score += 3;
    if (placeholder.includes('聊天') || placeholder.includes('chat') || placeholder.includes('message')) score += 3;
    if (aria.includes('聊天') || aria.includes('chat') || aria.includes('message')) score += 3;
    if (placeholder.includes('输入') || aria.includes('输入') || classes.includes('chat')) score += 1;
    if (el.closest('[role="textbox"]')) score += 1;
    return score;
  }

  function findChatInput() {
    const selectors = ['textarea', 'input[type="text"]', 'input[type="search"]', '[contenteditable="true"]', '[role="textbox"]'];
    const candidates = Array.from(document.querySelectorAll(selectors.join(','))).filter(isVisible);
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => scoreInput(b) - scoreInput(a));
    return candidates[0] || null;
  }

  function findInputContainer(input) {
    if (!input) return null;
    return (
      input.closest(
        [
          '[data-testid*="composer"]',
          '[data-testid*="chat-input"]',
          '[data-testid*="message-input"]',
          '[role="textbox"]',
          '[aria-label*="输入"]',
          '[class*="composer"]',
          '[class*="input"]',
          '[class*="message"]',
          '[class*="editor"]',
          'form',
        ].join(','),
      ) || input.parentElement
    );
  }

  function calculateDistance(a, b) {
    try {
      const rectA = a.getBoundingClientRect();
      const rectB = b.getBoundingClientRect();
      const dx = rectA.left + rectA.width / 2 - (rectB.left + rectB.width / 2);
      const dy = rectA.top + rectA.height / 2 - (rectB.top + rectB.height / 2);
      return Math.sqrt(dx * dx + dy * dy);
    } catch (e) {
      return Number.POSITIVE_INFINITY;
    }
  }

  function findSendButtonNear(input) {
    if (!input) return null;
    const container = findInputContainer(input) || input.parentElement;
    const roots = [container];
    const inputRect = (() => {
      try {
        return input.getBoundingClientRect();
      } catch {
        return null;
      }
    })();
    const candidates = [];
    let fallbackNearest = null;
    let fallbackNearestDistance = Number.POSITIVE_INFINITY;
    let fallbackRightmost = null;

    for (const root of roots) {
      if (!root) continue;
      const buttons = Array.from(
        root.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"], a'),
      );
      for (const btn of buttons) {
        if (!isVisible(btn)) continue;
        const label = `${btn.innerText || ''} ${btn.value || ''} ${btn.getAttribute('aria-label') || ''} ${btn.getAttribute('title') || ''}`
          .toLowerCase()
          .trim();
        const type = (btn.getAttribute('type') || '').toLowerCase();
        const distance = calculateDistance(input, btn);
        const hasSvg = !!btn.querySelector('svg');
        const textHasArrow = label.includes('arrow') || (btn.textContent || '').includes('↑');
        const circleLike = (() => {
          try {
            const rect = btn.getBoundingClientRect();
            const style = window.getComputedStyle(btn);
            const radius = parseFloat(style.borderRadius || '0');
            return Math.abs(rect.width - rect.height) < 8 && radius >= rect.width / 3;
          } catch {
            return false;
          }
        })();

        const rect = (() => {
          try {
            return btn.getBoundingClientRect();
          } catch {
            return null;
          }
        })();

        let score = 0;
        if (SEND_KEYWORDS.some(k => label.includes(k))) score += 5;
        if (type === 'submit') score += 3;
        if (btn.getAttribute('data-send') === 'true') score += 3;
        const testid = btn.getAttribute('data-testid') || '';
        if (testid.toLowerCase().includes('send')) score += 3;
        if (hasSvg) score += 1;
        if (textHasArrow) score += 2;
        if (circleLike) score += 1;
        if (rect && inputRect) {
          const belowInput = rect.top >= inputRect.bottom - 20;
          const nearRight = rect.right >= inputRect.right - 20;
          const rightOfInput = rect.left >= inputRect.left;
          if (belowInput) score += 2;
          if (nearRight) score += 2;
          if (rightOfInput) score += 1;
          score += Math.max(0, rect.right - inputRect.right) / 150;
        }
        const distanceScore = distance < 500 ? (500 - distance) / 100 : 0;
        score += distanceScore;

        if (score > 0) {
          candidates.push({ btn, score, distance });
        } else if (distance < fallbackNearestDistance) {
          fallbackNearest = btn;
          fallbackNearestDistance = distance;
        }

        if (rect && inputRect) {
          const isBelowRow = rect.top >= inputRect.bottom - 60;
          if (isBelowRow) {
            if (
              !fallbackRightmost ||
              rect.right > fallbackRightmost.rect.right + 4 ||
              (rect.right > fallbackRightmost.rect.right - 4 && rect.top > fallbackRightmost.rect.top)
            ) {
              fallbackRightmost = { btn, rect };
            }
          }
        }
      }
    }
    if (candidates.length === 0) {
      if (fallbackRightmost) return fallbackRightmost.btn;
      return fallbackNearestDistance < 300 ? fallbackNearest : null;
    }
    candidates.sort((a, b) => b.score - a.score || a.distance - b.distance);
    return candidates[0].btn;
  }

  function setInputValue(el, text) {
    if (el.getAttribute('contenteditable') === 'true') {
      el.focus();
      el.textContent = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    if ('value' in el) {
      el.focus();
      el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function dispatchEnter(el) {
    if (!el) return;
    el.focus();
    ['keydown', 'keypress', 'keyup'].forEach(type => {
      const event = new KeyboardEvent(type, {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
        composed: true,
      });
      el.dispatchEvent(event);
    });
  }

  function findAiMessages() {
    const deepseekBlocks = Array.from(document.querySelectorAll('.ds-message .ds-markdown'));
    const deepseekMessages = deepseekBlocks
      .map(el => {
        const text = (el.innerText || '').trim();
        return text ? { element: el, text } : null;
      })
      .filter(Boolean);
    if (deepseekMessages.length > 0) return deepseekMessages;

    const candidates = Array.from(document.querySelectorAll('article, div, li, section, p, span'));
    const messages = [];
    const seen = new Set();

    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const text = (el.innerText || '').trim();
      if (!text) continue;

      const descriptor = [
        el.getAttribute('data-role'),
        el.getAttribute('data-message-author'),
        el.getAttribute('data-author'),
        el.getAttribute('data-testid'),
        el.getAttribute('aria-label'),
        el.className,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      const looksLikeAi =
        descriptor.includes('assistant') ||
        descriptor.includes('ai') ||
        descriptor.includes('bot') ||
        descriptor.includes('reply') ||
        AI_KEYWORDS.some(keyword => descriptor.includes(keyword));
      if (!looksLikeAi) continue;

      const key = `${text.slice(0, 50)}|${descriptor}`;
      if (seen.has(key)) continue;
      seen.add(key);
      messages.push({ element: el, text });
    }

    return messages;
  }

  function create_task() {
    const button = findNewChatButton();
    if (!button) {
      return { ok: false, message: '未找到“开启新对话/新建对话”按钮' };
    }
    highlight(button);
    setTimeout(() => button.click(), 1000);
    return { ok: true, message: `找到按钮: ${describe(button)}` };
  }

  function send_message(text) {
    const input = findChatInput();
    if (!input) return { ok: false, message: '未找到聊天输入框' };
    setInputValue(input, text || '');
    const sendBtn = findSendButtonNear(input);
    if (sendBtn) {
      highlight(sendBtn);
      sendBtn.click();
    } else {
      highlight(input);
      setTimeout(() => dispatchEnter(input), 1000);
    }
    return {
      ok: true,
      message: `填充消息${sendBtn ? '并尝试点击发送' : ''}`,
      sendButton: sendBtn ? describe(sendBtn) : null,
      input: describe(input),
    };
  }

  function receive_message() {
    const messages = findAiMessages();
    if (messages.length === 0) return { ok: false, message: '未找到 AI 聊天内容' };
    const latest = messages[messages.length - 1];
    highlight(latest.element);
    return {
      ok: true,
      message: '获取到 AI 回复',
      latest: latest.text,
      count: messages.length,
    };
  }

  function highlightDetectedElements() {
    const found = [];
    const btn = findNewChatButton();
    if (btn) found.push(btn);
    const input = findChatInput();
    if (input) {
      const container = findInputContainer(input);
      found.push(container || input);
      const sendBtn = findSendButtonNear(input);
      if (sendBtn) found.push(sendBtn);
    }
    if (found.length > 0) {
      clearHighlights();
      found.forEach((el, idx) => addHighlight(el, idx === 0));
    }
    return found.length;
  }

  return {
    create_task,
    send_message,
    receive_message,
    highlightDetectedElements,
  };
}
