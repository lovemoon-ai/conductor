import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

// Usage: node smoke.mjs /absolute/path/to/moli [results.json]
// Uses local fixtures and fresh temporary profiles; no chatbot credentials.
assert(process.argv[2], 'Usage: node smoke.mjs /absolute/path/to/moli [results.json]');
const binary = resolve(process.argv[2]);
const version = spawnSync(binary, ['--version'], { encoding: 'utf8' });
assert.equal(version.status, 0, version.stderr);
const root = await mkdtemp(join(tmpdir(), 'moli-chat-runtime-'));
const resultPath = process.argv[3] ? resolve(process.argv[3]) : join(root, 'results.json');
const children = new Set();
const sockets = new Set();
const checks = [];
const events = [];
const report = (name, details = {}) => { checks.push({ name, ...details }); console.log('PASS', name, JSON.stringify(details)); };
const fixture = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.flushHeaders();
    const tag = url.searchParams.get('tag');
    const count = Number(url.searchParams.get('count') || 4);
    let index = 0;
    const timer = setInterval(() => {
      res.write('data: ' + tag + ':' + index + '\n\n');
      if (++index === count) { clearInterval(timer); res.end(); }
    }, 300);
    res.on('close', () => clearInterval(timer));
  } else {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html><body>moli chat runtime fixture</body></html>');
  }
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + fixture.address().port;
async function port() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const p = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return p;
}
class CDP {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map();
    ws.addEventListener('message', ({ data }) => {
      const msg = JSON.parse(data);
      if (msg.id) {
        const p = this.pending.get(msg.id); if (!p) return;
        this.pending.delete(msg.id); clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error))); else p.resolve(msg.result);
      } else events.push({ at: Date.now(), ...msg });
    });
  }
  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async evaluate(session, expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false }, session);
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
}
async function boot(profile) {
  const p = await port();
  const child = spawn(binary, ['serve', '--port', String(p), '--profile-dir', profile, '--http-no-proxy', '*'], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let log = '';
  child.stdout.on('data', d => { log += d; }); child.stderr.on('data', d => { log += d; });
  let version;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error('Moli exited: ' + log);
    try {
      const r = await fetch('http://127.0.0.1:' + p + '/json/version', { signal: AbortSignal.timeout(500) });
      version = await r.json(); if (version.webSocketDebuggerUrl) break;
    } catch {}
    await delay(100);
  }
  assert(version?.webSocketDebuggerUrl, 'No CDP endpoint: ' + log);
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  sockets.add(ws);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  return { child, cdp: new CDP(ws), ws, profile };
}
async function stop(worker, signal = 'graceful') {
  if (worker.child.exitCode === null && worker.child.signalCode === null) {
    const done = new Promise(resolve => worker.child.once('exit', resolve));
    if (signal === 'graceful') await worker.cdp.send('Browser.close').catch(() => {});
    else worker.child.kill(signal);
    await Promise.race([done, delay(3000)]);
    if (worker.child.exitCode === null && worker.child.signalCode === null) { worker.child.kill('SIGKILL'); await done; }
  }
  worker.ws.close(); sockets.delete(worker.ws);
  children.delete(worker.child);
}
async function page(worker, browserContextId) {
  const { targetId } = await worker.cdp.send('Target.createTarget', { url: origin, ...(browserContextId ? { browserContextId } : {}) });
  const { sessionId } = await worker.cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await worker.cdp.send('Runtime.enable', {}, sessionId);
  await worker.cdp.send('Network.enable', {}, sessionId);
  for (let i = 0; i < 80; i++) {
    try { if (await worker.cdp.evaluate(sessionId, "document.URL.startsWith(" + JSON.stringify(origin) + ") && document.readyState !== 'loading'")) return sessionId; } catch {}
    await delay(50);
  }
  throw new Error('Fixture page not ready');
}
async function startStream(worker, session, tag, count = 4) {
  await worker.cdp.send('Runtime.addBinding', { name: '__reportChunk' }, session);
  const expression = `(() => {
    window.parts = []; window.streamDone = false; window.streamError = null;
    (async () => {
      try {
        const response = await fetch('/stream?tag=' + ${JSON.stringify(tag)} + '&count=' + ${count});
        const reader = response.body.getReader(); const decoder = new TextDecoder();
        for (;;) { const {value, done} = await reader.read(); if (done) break;
          const text = decoder.decode(value, {stream: true}); window.parts.push(text); __reportChunk(text);
        }
        window.streamDone = true;
      } catch (error) { window.streamError = String(error); }
    })();
    return true;
  })()`;
  await worker.cdp.evaluate(session, expression);
}
async function sample(worker, session) {
  return worker.cdp.evaluate(session, '({parts: window.parts, done: window.streamDone, error: window.streamError})');
}
let workerA, workerB;
try {
  const profiles = await Promise.all(['A-', 'B-'].map(prefix => mkdtemp(join(root, prefix))));
  [workerA, workerB] = await Promise.all(profiles.map(boot));
  const contextA = (await workerA.cdp.send('Target.createBrowserContext')).browserContextId;
  const contextB = (await workerA.cdp.send('Target.createBrowserContext')).browserContextId;
  const [sessionA, sessionB] = await Promise.all([page(workerA, contextA), page(workerA, contextB)]);
  await workerA.cdp.evaluate(sessionA, "localStorage.setItem('chat', 'A'); sessionStorage.setItem('chat', 'A'); document.cookie='chat=A; path=/'");
  const clean = await workerA.cdp.evaluate(sessionB, "({local: localStorage.getItem('chat'), session: sessionStorage.getItem('chat'), cookie: document.cookie})");
  assert.deepEqual(clean, {local: null, session: null, cookie: ''});
  await workerA.cdp.evaluate(sessionB, "localStorage.setItem('chat', 'B'); sessionStorage.setItem('chat', 'B'); document.cookie='chat=B; path=/'");
  const aState = await workerA.cdp.evaluate(sessionA, "({local: localStorage.getItem('chat'), session: sessionStorage.getItem('chat'), cookie: document.cookie})");
  assert.deepEqual(aState, {local: 'A', session: 'A', cookie: 'chat=A'});
  report('same-origin context storage isolation', { contexts: 2, stores: ['cookies', 'localStorage', 'sessionStorage'] });

  await Promise.all([startStream(workerA, sessionA, 'A'), startStream(workerA, sessionB, 'B')]);
  await delay(750);
  const early = await Promise.all([sample(workerA, sessionA), sample(workerA, sessionB)]);
  assert(early.every(s => s.parts.length > 0 && !s.done && !s.error), JSON.stringify(early));
  assert(early[0].parts.join('').includes('A:0') && early[1].parts.join('').includes('B:0'));
  report('two contexts receive concurrent body chunks before EOF', { chunksAt750ms: early.map(s => s.parts.length) });
  await delay(1000);
  const finished = await Promise.all([sample(workerA, sessionA), sample(workerA, sessionB)]);
  assert(finished.every(s => s.done && !s.error), JSON.stringify(finished));
  assert(!finished[0].parts.join('').includes('B:') && !finished[1].parts.join('').includes('A:'));
  const binding = events.filter(e => e.method === 'Runtime.bindingCalled');
  assert(binding.some(e => e.sessionId === sessionA) && binding.some(e => e.sessionId === sessionB));
  report('CDP binding carries per-session incremental payloads', { bindingEvents: binding.length });

  await startStream(workerA, sessionB, 'B-survives', 6);
  await delay(400);
  await workerA.cdp.send('Target.disposeBrowserContext', {browserContextId: contextA});
  await delay(1800);
  const survivor = await sample(workerA, sessionB);
  assert(survivor.done && !survivor.error && survivor.parts.join('').includes('B-survives:5'), JSON.stringify(survivor));
  report('disposing one context preserves other context stream');

  let persistentError;
  try { await workerA.cdp.send('Target.createBrowserContext', {persistentPartitionId:'chat-a'}); }
  catch(error) { persistentError = error.message; }
  assert(persistentError?.includes('PersistentBrowserContextNotSupported'), persistentError);
  report('additional persistent context rejected', {error: persistentError});

  const [defaultA, defaultB] = await Promise.all([page(workerA), page(workerB)]);
  await workerA.cdp.evaluate(defaultA, "localStorage.setItem('persistentChat', 'A'); document.cookie='persistentChat=A; max-age=3600; path=/'");
  const cleanProfile = await workerB.cdp.evaluate(defaultB, "({local: localStorage.getItem('persistentChat'), cookie: document.cookie})");
  assert.deepEqual(cleanProfile, {local: null, cookie: ''});
  await workerB.cdp.evaluate(defaultB, "localStorage.setItem('persistentChat', 'B'); document.cookie='persistentChat=B; max-age=3600; path=/'");
  await startStream(workerB, defaultB, 'worker-B', 6);
  await delay(400);
  await stop(workerA, 'SIGKILL'); workerA = undefined;
  await delay(1800);
  const alive = await sample(workerB, defaultB);
  assert(alive.done && !alive.error && alive.parts.join('').includes('worker-B:5'), JSON.stringify(alive));
  report('two processes isolate profile state; killing A preserves B stream');

  const savedProfile = workerB.profile;
  await stop(workerB); workerB = undefined;
  workerB = await boot(savedProfile);
  const restored = await page(workerB);
  const saved = await workerB.cdp.evaluate(restored, "({local: localStorage.getItem('persistentChat'), cookie: document.cookie})");
  assert.deepEqual(saved, {local: 'B', cookie: 'persistentChat=B'});
  report('profile cookies and localStorage survive Browser.close and restart');
  const result = {binary:version.stdout.trim(), platform:process.platform, arch:process.arch, fixture:'local HTTP, no chatbot accounts', checks};
  await writeFile(resultPath, JSON.stringify(result, null, 2) + '\n');
  console.log('RESULT', JSON.stringify(result));
} finally {
  if (workerA) await stop(workerA);
  if (workerB) await stop(workerB);
  for (const ws of sockets) ws.close();
  for (const child of children) child.kill('SIGKILL');
  fixture.closeAllConnections();
  await new Promise(resolve => fixture.close(resolve));
}
