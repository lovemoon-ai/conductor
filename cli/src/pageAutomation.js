import createDeepseekProvider from './providers/deepseek.js';
import createGenericProvider from './providers/generic.js';
import createQwenProvider from './providers/qwen.js';

const HIGHLIGHT_CLASS = 'conductor-highlight';
const providerFactories = {
  deepseek: createDeepseekProvider,
  qwen: createQwenProvider,
  generic: createGenericProvider,
};
const providerMap = {
  'chat.deepseek.com': 'deepseek',
  'chat.qwen.ai': 'qwen',
};
const defaultProvider = 'generic';
const providerCache = new Map();
let styleInjected = false;

function getDocument() {
  return typeof document !== 'undefined' ? document : null;
}

function getWindow() {
  return typeof window !== 'undefined' ? window : null;
}

function ensureHighlightStyle() {
  const doc = getDocument();
  if (!doc || styleInjected) return;
  const styleId = 'conductor-highlight-style';
  if (doc.getElementById(styleId)) {
    styleInjected = true;
    return;
  }
  const style = doc.createElement('style');
  style.id = styleId;
  style.textContent = `
    .${HIGHLIGHT_CLASS} {
      outline: 2px solid #ff9800 !important;
      outline-offset: 2px !important;
      border-radius: 4px !important;
    }
  `;
  doc.head.appendChild(style);
  styleInjected = true;
}

function clearHighlights() {
  const doc = getDocument();
  if (!doc) return;
  doc.querySelectorAll(`.${HIGHLIGHT_CLASS}`).forEach(node => node.classList.remove(HIGHLIGHT_CLASS));
}

function addHighlight(el, scroll = false) {
  if (!el) return;
  const doc = getDocument();
  if (!doc) return;
  ensureHighlightStyle();
  el.classList.add(HIGHLIGHT_CLASS);
  if (scroll) {
    try {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch {
      // ignore
    }
  }
}

function highlight(el, scroll = true) {
  clearHighlights();
  addHighlight(el, scroll);
}

function detectProvider() {
  const win = getWindow();
  const host = win?.location?.host;
  return (host && providerMap[host]) || defaultProvider;
}

function resolveFactory(name) {
  return providerFactories[name] || providerFactories[defaultProvider];
}

function loadProvider(name) {
  const providerName = name || detectProvider();
  const cached = providerCache.get(providerName);
  if (cached) {
    return cached;
  }
  const factory = resolveFactory(providerName);
  if (!factory) {
    throw new Error(`Unknown provider: ${providerName}`);
  }
  try {
    const provider = factory({ highlight, clearHighlights, addHighlight });
    providerCache.set(providerName, provider);
    return provider;
  } catch (error) {
    if (providerName !== defaultProvider) {
      return loadProvider(defaultProvider);
    }
    throw error;
  }
}

function ensureProvider(name) {
  return loadProvider(name);
}

export function create_task() {
  const provider = ensureProvider();
  return provider.create_task();
}

export function send_message(text) {
  const provider = ensureProvider();
  return provider.send_message(text || '');
}

export function receive_message() {
  const provider = ensureProvider();
  return provider.receive_message();
}

export function highlightDetectedElements() {
  const provider = ensureProvider();
  if (typeof provider.highlightDetectedElements !== 'function') {
    return 0;
  }
  return provider.highlightDetectedElements();
}
