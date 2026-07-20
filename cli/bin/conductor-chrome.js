#!/usr/bin/env node

import { homedir } from 'os';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import yaml from 'js-yaml';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { launch as launchChrome } from 'chrome-launcher';
import CDP from 'chrome-remote-interface';
import { resolveConductorConfigPath } from '../src/conductor-paths.js';


const BACKEND_URLS = {
  gemini: 'https://aistudio.google.com/prompts/new_chat?model=gemini-3-pro-preview',
  chatgpt: 'https://chat.openai.com',
  claude: 'https://claude.ai',
  grok: 'https://grok.com',
  deepseek: 'https://chat.deepseek.com',
  qwen: 'https://chat.qwen.ai'
};

const argv = yargs(hideBin(process.argv))
  .option('backend', {
    type: 'string',
    choices: Object.keys(BACKEND_URLS),
    default: 'deepseek',
    describe: 'Target backend tab to open',
  })
  .option('action', {
    type: 'string',
    choices: ['create_task', 'send_message', 'receive_message'],
    describe: 'Run a page automation helper once after the tab loads',
  })
  .option('launch-browser', {
    type: 'boolean',
    default: false,
    describe: 'Only launch Chrome; skip opening tabs or running automation',
  })
  .option('message', {
    type: 'string',
    describe: 'Text to send when --action=send_message',
  })
  .parseSync();

const TARGET_URL = BACKEND_URLS[argv.backend];
const CACHE_DIR = path.join(homedir(), '.cache', 'conductor');
const PORT_STORE = path.join(CACHE_DIR, '.chrome-port');

const AUTOMATION_SRC_ROOT = new URL('../src/', import.meta.url);
const PAGE_AUTOMATION_PATH = new URL('pageAutomation.js', AUTOMATION_SRC_ROOT);
const PROVIDERS_DIR = new URL('providers/', AUTOMATION_SRC_ROOT);
let automationScriptCache;

const CONFIG_PATH = resolveConductorConfigPath();

function expandHomeDir(maybePath) {
  if (!maybePath) {
    return maybePath;
  }
  const home = homedir();
  return maybePath
    .replace(/^~(?=$|\/)/, home)
    .replace(/\$HOME/g, home)
    .replace(/\${HOME}/g, home);
}

let cachedUserConfig;
async function loadUserConfig() {
  if (cachedUserConfig !== undefined) {
    return cachedUserConfig;
  }
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf-8');
    const parsed = yaml.load(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      cachedUserConfig = parsed;
    } else {
      cachedUserConfig = {};
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`Failed to read ${CONFIG_PATH}:`, error);
    }
    cachedUserConfig = {};
  }
  return cachedUserConfig;
}

function pickConfiguredUserDataDir(config) {
  if (typeof config?.cdp_user_data_dir === 'string' && config.cdp_user_data_dir.trim()) {
    return config.cdp_user_data_dir;
  }
  if (typeof config?.cdpUserDataDir === 'string' && config.cdpUserDataDir.trim()) {
    return config.cdpUserDataDir;
  }
  return undefined;
}

async function resolveUserDataDir() {
  const envValue = expandHomeDir(process.env.CDP_USER_DATA_DIR);
  if (envValue) {
    return envValue;
  }
  const config = await loadUserConfig();
  const configValue = pickConfiguredUserDataDir(config);
  return expandHomeDir(configValue);
}

async function readStoredPort() {
  try {
    const raw = await fs.readFile(PORT_STORE, 'utf-8');
    const port = Number(raw.trim());
    if (Number.isFinite(port) && port > 0) {
      return port;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('Failed to read cached Chrome port:', error);
    }
  }
  return null;
}

function isPortListening(port) {
  return new Promise((resolve) => {
    const client = net.createConnection({ port, host: '127.0.0.1' });
    const cleanup = () => client.destroy();
    client.once('connect', () => {
      cleanup();
      resolve(true);
    });
    client.once('error', () => {
      cleanup();
      resolve(false);
    });
    setTimeout(() => {
      cleanup();
      resolve(false);
    }, 200);
  });
}

async function storePort(port) {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(PORT_STORE, String(port), 'utf-8');
}

async function clearPortStore() {
  await fs.unlink(PORT_STORE).catch((error) => {
    if (error.code !== 'ENOENT') {
      console.warn('Failed to remove cached Chrome port:', error);
    }
  });
}

async function tryReusePort() {
  const storedPort = await readStoredPort();
  if (!storedPort) {
    return null;
  }
  if (await isPortListening(storedPort)) {
    return storedPort;
  }
  await clearPortStore();
  return null;
}

let chrome;
let browserClient;
let tabClient;
let exitResolve;
let shuttingDown = false;
let ownsChromeInstance = false;

const exitPromise = new Promise((resolve) => {
  exitResolve = resolve;
});

async function launchBrowser() {
  if (chrome && chrome.process && chrome.process.exitCode === null) {
    console.log(`Reusing existing Chrome instance on port ${chrome.port}`);
    return;
  }
  const reusedPort = await tryReusePort();
  if (reusedPort) {
    console.log(`Reusing existing Chrome process on port ${reusedPort}`);
    chrome = {
      port: reusedPort,
      process: null,
      kill: async () => {
        console.log('Leaving reused Chrome running.');
      }
    };
    ownsChromeInstance = false;
    return;
  }
  const launchOptions = {
    startingUrl: 'about:blank',
    chromeFlags: [
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-popup-blocking',
    ],
    port: 0
  };
  const userDataDir = await resolveUserDataDir();
  if (userDataDir) {
    launchOptions.userDataDir = userDataDir;
    console.log(`Launching Chrome with user data directory ${userDataDir}`);
  }
  chrome = await launchChrome(launchOptions);
  ownsChromeInstance = true;
  await storePort(chrome.port);
  console.log(`Chrome launched with remote debugging port ${chrome.port}`);
}

async function createTab(url) {
  browserClient = await CDP({ port: chrome.port });
  const { Target } = browserClient;
  const { targetId } = await Target.createTarget({ url: url });
  tabClient = await CDP({ port: chrome.port, target: targetId });
}

async function navigateTab(url) {
  const { Page, Runtime } = tabClient;
  await Page.enable();
  await Runtime.enable();
  await installAutomationScript(Page);
  await Page.navigate({ url: url });
  await Page.loadEventFired();
  console.log(`Opened new tab that navigated to ${url}`);
  return Runtime;
}

async function installAutomationScript(Page) {
  const script = await getAutomationScript();
  await Page.addScriptToEvaluateOnNewDocument({ source: script });
}

async function getAutomationScript() {
  if (automationScriptCache) {
    return automationScriptCache;
  }
  automationScriptCache = await buildAutomationScript();
  return automationScriptCache;
}

async function buildAutomationScript() {
  const deepseek = await fs.readFile(new URL('deepseek.js', PROVIDERS_DIR), 'utf-8');
  const generic = await fs.readFile(new URL('generic.js', PROVIDERS_DIR), 'utf-8');
  const qwen = await fs.readFile(new URL('qwen.js', PROVIDERS_DIR), 'utf-8');
  const automation = await fs.readFile(PAGE_AUTOMATION_PATH, 'utf-8');

  const deepseekClean = deepseek.replace('export default function createDeepseekProvider', 'function createDeepseekProvider');
  const genericClean = generic
    .replace(/^import .*?;\s*\n/, '')
    .replace(/deepseekProvider/g, 'createDeepseekProvider')
    .replace('export default function createGenericProvider', 'function createGenericProvider');
  const qwenClean = qwen
    .replace(/^import .*?;\s*\n/, '')
    .replace(/deepseekProvider/g, 'createDeepseekProvider')
    .replace('export default function createQwenProvider', 'function createQwenProvider');
  const automationClean = automation
    .replace(/import .*?;\s*\n/g, '')
    .replace(/export function ([a-zA-Z0-9_]+)/g, 'function $1');

  return `
(() => {
${deepseekClean}

${genericClean}

${qwenClean}

${automationClean}

  if (typeof window === 'undefined') {
    return;
  }

  window.__conductorAutomation = {
    create_task,
    send_message,
    receive_message,
    highlightDetectedElements,
  };
})();
`;
}

async function runAutomationAction(Runtime, action, message) {
  if (!Runtime) {
    return { ok: false, message: 'Runtime channel unavailable' };
  }
  const argument = action === 'send_message' ? JSON.stringify(message ?? '') : '';
  const callExpression =
    action === 'send_message' ? `automation.send_message(${argument})` : `automation.${action}()`;
  const expression = `(async () => {
    const automation = window.__conductorAutomation;
    if (!automation || typeof automation.${action} !== 'function') {
      return { ok: false, message: 'Page automation unavailable' };
    }
    return ${callExpression};
  })();`;

  const { result } = await Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true });
  return result?.value;
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('Cleaning up Chrome connection...');
  const closePromises = [];
  if (tabClient) {
    closePromises.push(tabClient.close());
    tabClient = null;
  }
  if (browserClient) {
    closePromises.push(browserClient.close());
    browserClient = null;
  }
  if (chrome) {
    if (ownsChromeInstance && typeof chrome.kill === 'function') {
      closePromises.push((async () => {
        await chrome.kill();
        await clearPortStore();
      })());
    } else {
      console.log('Leaving reused Chrome running.');
    }
    chrome = null;
    ownsChromeInstance = false;
  }
  await Promise.allSettled(closePromises);
  process.stdin.pause();
}

async function handleSignal() {
  await shutdown();
  exitResolve?.();
}

process.on('SIGINT', handleSignal);
process.on('SIGTERM', handleSignal);

async function main() {
  try {
    await launchBrowser();
    if (argv.launchBrowser) {
      console.log('Chrome launched with --launch-browser; no tabs will be opened.');
      console.log('Press Ctrl+C to close Chrome and exit.');
      process.stdin.resume();
      await exitPromise;
      return;
    }
    await createTab(TARGET_URL);
    const runtime = await navigateTab(TARGET_URL);
    if (argv.action) {
      const message = argv.action === 'send_message' ? argv.message ?? '' : undefined;
      const result = await runAutomationAction(runtime, argv.action, message);
      console.log(`Automation "${argv.action}" result:`, result);
    }
    console.log('Press Ctrl+C to close Chrome and exit.');
    process.stdin.resume();
    await exitPromise;
  } catch (error) {
    console.error('Failed to open tab via CDP:', error);
    await shutdown();
    process.exit(1);
  }
}

main();
