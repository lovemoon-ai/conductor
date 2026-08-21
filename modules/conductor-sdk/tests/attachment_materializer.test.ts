import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { AttachmentMaterializer } from '../src/attachments/index.js';
import { ConductorConfig } from '../src/config/index.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('AttachmentMaterializer', () => {
  test('downloads, verifies, persists, and reports multiple attachments', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'materializer-'));
    roots.push(root);
    const bodies = new Map([
      ['image-1', Buffer.from('image-data')],
      ['file-1', Buffer.from('context-data')],
    ]);
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/materialized')) {
        expect(init?.headers).toMatchObject({
          Authorization: 'Bearer token',
          'X-Conductor-Host': 'fire-1',
        });
        return new Response('{}', { status: 200 });
      }
      const id = url.includes('image-1') ? 'image-1' : 'file-1';
      const body = bodies.get(id)!;
      return new Response(body, {
        status: 200,
        headers: { 'content-length': String(body.length) },
      });
    }) as typeof fetch;
    const materializer = new AttachmentMaterializer({
      config: new ConductorConfig({ agentToken: 'token', backendUrl: 'https://backend.test' }),
      projectPath: root,
      agentHost: 'fire-1',
      fetchImpl,
    });
    const attachments = Array.from(bodies, ([id, body], index) => ({
      id,
      name: index === 0 ? 'image.png' : 'spec.txt',
      mimeType: index === 0 ? 'image/png' : 'text/plain',
      kind: index === 0 ? 'image' : 'file',
      transferToken: `token-${id}`,
      sizeBytes: body.length,
      sha256: crypto.createHash('sha256').update(body).digest('hex'),
    }));

    const result = await materializer.materializeEnvelope({
      type: 'task_user_message',
      payload: { task_id: 'task-1', message_id: 'msg-1', attachments },
    });
    const local = (result.payload as any).attachments;
    expect(local).toHaveLength(2);
    expect(local.every((entry: any) => entry.transferToken === undefined)).toBe(true);
    expect(local.every((entry: any) => path.isAbsolute(entry.path) && fs.existsSync(entry.path))).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, '.conductor/attachments/msg-1/manifest.json'), 'utf8'));
    expect(manifest.status).toBe('ready');
    expect(manifest.attachments.every((entry: any) => entry.transferToken === undefined)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  test('rejects content whose digest does not match the descriptor', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'materializer-'));
    roots.push(root);
    const materializer = new AttachmentMaterializer({
      config: new ConductorConfig({ agentToken: 'token', backendUrl: 'https://backend.test' }),
      projectPath: root,
      agentHost: 'fire-1',
      fetchImpl: vi.fn(async () => new Response('wrong', {
        status: 200,
        headers: { 'content-length': '5' },
      })) as typeof fetch,
    });
    await expect(materializer.materializeEnvelope({
      type: 'task_user_message',
      payload: {
        task_id: 'task-1',
        message_id: 'msg-1',
        attachments: [{
          id: 'file-1', name: 'spec.txt', mimeType: 'text/plain', kind: 'file', sizeBytes: 5, transferToken: 'token',
          sha256: crypto.createHash('sha256').update('right').digest('hex'),
        }],
      },
    })).rejects.toThrow('SHA-256 mismatch');
  });

  test('rejects duplicate attachment IDs before downloading', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'materializer-'));
    roots.push(root);
    const fetchImpl = vi.fn();
    const materializer = new AttachmentMaterializer({
      config: new ConductorConfig({ agentToken: 'token', backendUrl: 'https://backend.test' }),
      projectPath: root,
      agentHost: 'fire-1',
      fetchImpl: fetchImpl as typeof fetch,
    });
    const descriptor = {
      id: 'same', name: 'spec.txt', mimeType: 'text/plain', kind: 'file', sizeBytes: 5, transferToken: 'token',
      sha256: crypto.createHash('sha256').update('right').digest('hex'),
    };
    await expect(materializer.materializeEnvelope({
      type: 'task_user_message',
      payload: { task_id: 'task-1', message_id: 'msg-1', attachments: [descriptor, descriptor] },
    })).rejects.toThrow('unique IDs');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('accepts a streamed response when a proxy omits Content-Length', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'materializer-'));
    roots.push(root);
    const body = Buffer.from('context');
    const materializer = new AttachmentMaterializer({
      config: new ConductorConfig({ agentToken: 'token', backendUrl: 'https://backend.test' }),
      projectPath: root,
      agentHost: 'fire-1',
      fetchImpl: vi.fn(async (input) => String(input).endsWith('/materialized')
        ? new Response('{}', { status: 200 })
        : new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(body);
            controller.close();
          },
        }), { status: 200 })) as typeof fetch,
    });

    await expect(materializer.materializeEnvelope({
      type: 'task_user_message',
      payload: { task_id: 'task-1', message_id: 'msg-1', attachments: [{
        id: 'file-1', name: 'spec.txt', mimeType: 'text/plain', kind: 'file', sizeBytes: body.length, transferToken: 'token',
        sha256: crypto.createHash('sha256').update(body).digest('hex'),
      }] },
    })).resolves.toMatchObject({ payload: { attachments: [{ status: 'ready' }] } });
  });

  test('aborts a stalled attachment download', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'materializer-'));
    roots.push(root);
    const materializer = new AttachmentMaterializer({
      config: new ConductorConfig({ agentToken: 'token', backendUrl: 'https://backend.test' }),
      projectPath: root,
      agentHost: 'fire-1',
      transferTimeoutMs: 10,
      fetchImpl: vi.fn((_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as typeof fetch,
    });
    await expect(materializer.materializeEnvelope({
      type: 'task_user_message',
      payload: { task_id: 'task-1', message_id: 'msg-timeout', attachments: [{
        id: 'file-1', name: 'spec.txt', mimeType: 'text/plain', kind: 'file', sizeBytes: 5, transferToken: 'token',
        sha256: crypto.createHash('sha256').update('right').digest('hex'),
      }] },
    })).rejects.toThrow(/timeout/i);
  });

});
