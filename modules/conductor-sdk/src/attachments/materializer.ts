import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { ConductorConfig } from '../config/index.js';

const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const MAX_ATTACHMENTS = 20;
const DEFAULT_TRANSFER_TIMEOUT_MS = 120_000;

type FetchLike = typeof fetch;
type JsonRecord = Record<string, unknown>;

export interface AttachmentMaterializerOptions {
  config: ConductorConfig;
  projectPath: string;
  agentHost: string;
  fetchImpl?: FetchLike;
  transferTimeoutMs?: number;
}

function cleanSegment(value: unknown, fallback: string): string {
  const basename = path.basename(typeof value === 'string' ? value : '').replace(/[^A-Za-z0-9._-]+/g, '-');
  return basename || fallback;
}

function normalizeSha256(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : '';
}

function atomicWriteJson(filePath: string, value: unknown): void {
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

async function hashFile(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export class AttachmentMaterializer {
  private readonly config: ConductorConfig;
  private readonly projectPath: string;
  private readonly agentHost: string;
  private readonly fetchImpl: FetchLike;
  private readonly transferTimeoutMs: number;
  private readonly inFlight = new Map<string, Promise<JsonRecord>>();

  constructor(options: AttachmentMaterializerOptions) {
    this.config = options.config;
    this.projectPath = path.resolve(options.projectPath);
    this.agentHost = options.agentHost;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.transferTimeoutMs = options.transferTimeoutMs ?? DEFAULT_TRANSFER_TIMEOUT_MS;
  }

  async materializeEnvelope(envelope: JsonRecord): Promise<JsonRecord> {
    if (envelope.type !== 'task_user_message') return envelope;
    const payload = envelope.payload && typeof envelope.payload === 'object'
      ? { ...(envelope.payload as JsonRecord) }
      : null;
    if (!payload || !Array.isArray(payload.attachments) || payload.attachments.length === 0) return envelope;
    const attachments = payload.attachments;
    // Attachments created before the reliable-transfer protocol did not carry a
    // digest. Preserve those legacy display-only descriptors instead of
    // turning an old message into a permanently unacknowledgeable command.
    if (payload.attachments.some((entry) =>
      !entry || typeof entry !== 'object' || Array.isArray(entry) || !normalizeSha256((entry as JsonRecord).sha256)
    )) return envelope;
    if (payload.attachments.length > MAX_ATTACHMENTS) throw new Error('Too many message attachments');
    const attachmentIds = payload.attachments.map((entry) =>
      typeof (entry as JsonRecord).id === 'string' ? String((entry as JsonRecord).id).trim() : '',
    );
    if (attachmentIds.some((id) => !id) || new Set(attachmentIds).size !== attachmentIds.length) {
      throw new Error('Message attachments must have unique IDs');
    }
    const taskId = typeof payload.task_id === 'string' ? payload.task_id.trim() : '';
    const messageId = typeof payload.message_id === 'string' ? payload.message_id.trim() : '';
    if (!taskId || !messageId) throw new Error('Attachment message is missing task_id or message_id');

    const key = `${taskId}:${messageId}`;
    const current = this.inFlight.get(key);
    if (current) return current;
    const operation = this.materializeAttachments(envelope, payload, attachments, taskId, messageId);
    this.inFlight.set(key, operation);
    try {
      return await operation;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async materializeAttachments(
    envelope: JsonRecord,
    payload: JsonRecord,
    attachments: unknown[],
    taskId: string,
    messageId: string,
  ): Promise<JsonRecord> {

    const messageDir = path.join(
      this.projectPath,
      '.conductor',
      'attachments',
      cleanSegment(messageId, 'message'),
    );
    fs.mkdirSync(messageDir, { recursive: true, mode: 0o700 });
    const manifestPath = path.join(messageDir, 'manifest.json');
    atomicWriteJson(manifestPath, {
      taskId,
      messageId,
      status: 'materializing',
      attachments,
      updatedAt: new Date().toISOString(),
    });

    const localAttachments = [];
    for (const raw of attachments) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid attachment descriptor');
      localAttachments.push(await this.materializeOne(taskId, messageDir, raw as JsonRecord));
    }
    atomicWriteJson(manifestPath, {
      taskId,
      messageId,
      status: 'ready',
      attachments: localAttachments,
      updatedAt: new Date().toISOString(),
    });
    await this.reportMaterialized(taskId, messageId, localAttachments);

    const metadata = payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
      ? { ...(payload.metadata as JsonRecord), attachments: localAttachments }
      : { attachments: localAttachments };
    return { ...envelope, payload: { ...payload, metadata, attachments: localAttachments } };
  }

  private async materializeOne(taskId: string, messageDir: string, attachment: JsonRecord): Promise<JsonRecord> {
    const id = typeof attachment.id === 'string' ? attachment.id.trim() : '';
    const name = cleanSegment(attachment.name, 'attachment');
    const sha256 = normalizeSha256(attachment.sha256);
    const sizeBytes = typeof attachment.sizeBytes === 'number' ? attachment.sizeBytes : Number.NaN;
    const kind = attachment.kind === 'image' ? 'image' : attachment.kind === 'file' ? 'file' : '';
    if (!id || !sha256 || !kind || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > MAX_ATTACHMENT_BYTES) {
      throw new Error(`Invalid attachment descriptor for ${id || name}`);
    }
    const localPath = path.join(messageDir, `${cleanSegment(id, 'attachment')}--${name}`);
    if (fs.existsSync(localPath)) {
      const stat = fs.statSync(localPath);
      if (stat.isFile() && stat.size === sizeBytes && await hashFile(localPath) === sha256) {
        return { ...attachment, path: localPath, localPath, status: 'ready' };
      }
      fs.rmSync(localPath, { force: true });
    }

    const url = new URL(
      `/api/agent/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(id)}/content`,
      this.config.backendUrl,
    );
    const transferSignal = AbortSignal.timeout(this.transferTimeoutMs);
    const response = await this.fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${this.config.agentToken}`,
        'X-Conductor-Host': this.agentHost,
        Accept: 'application/octet-stream',
      },
      signal: transferSignal,
    });
    if (!response.ok || !response.body) throw new Error(`Attachment download failed with HTTP ${response.status}`);
    const contentLength = response.headers.get('content-length');
    const declaredLength = contentLength === null ? null : Number(contentLength);
    if (declaredLength !== null && Number.isFinite(declaredLength) && declaredLength !== sizeBytes) {
      throw new Error('Attachment Content-Length mismatch');
    }

    const temporaryPath = `${localPath}.${process.pid}.${crypto.randomUUID()}.part`;
    const hash = crypto.createHash('sha256');
    let received = 0;
    const verifier = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > sizeBytes || received > MAX_ATTACHMENT_BYTES) {
          callback(new Error('Attachment exceeded declared size'));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(
        Readable.fromWeb(response.body as never),
        verifier,
        fs.createWriteStream(temporaryPath, { mode: 0o600 }),
        { signal: transferSignal },
      );
      if (received !== sizeBytes) throw new Error('Attachment size mismatch');
      if (hash.digest('hex') !== sha256) throw new Error('Attachment SHA-256 mismatch');
      fs.renameSync(temporaryPath, localPath);
    } catch (error) {
      fs.rmSync(temporaryPath, { force: true });
      throw error;
    }
    return { ...attachment, path: localPath, localPath, status: 'ready' };
  }

  private async reportMaterialized(taskId: string, messageId: string, attachments: JsonRecord[]): Promise<void> {
    const url = new URL(
      `/api/agent/tasks/${encodeURIComponent(taskId)}/messages/${encodeURIComponent(messageId)}/materialized`,
      this.config.backendUrl,
    );
    const response = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.agentToken}`,
        'X-Conductor-Host': this.agentHost,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        attachments: attachments.map((attachment) => ({
          id: attachment.id,
          sha256: attachment.sha256,
          status: 'ready',
        })),
      }),
    });
    if (!response.ok) throw new Error(`Attachment materialization report failed with HTTP ${response.status}`);
  }

  private async fetchWithTimeout(input: URL, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Attachment transfer timed out')), this.transferTimeoutMs);
    timeout.unref?.();
    try {
      return await this.fetchImpl(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }
}
