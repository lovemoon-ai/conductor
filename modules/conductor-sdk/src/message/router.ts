import crypto from 'node:crypto';

import { SessionManager } from '../session/manager.js';

export type BackendPayload = Record<string, any>;
export type OutboundHandler = (payload: BackendPayload) => Promise<void> | void;
export interface MessageNotifier {
  notifyNewMessage(taskId: string): Promise<void>;
}

const RANDOM_UUID = () => (typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'));

export class MessageRouter {
  private readonly outboundHandlers: OutboundHandler[] = [];

  constructor(private readonly sessions: SessionManager, private readonly notifier?: MessageNotifier) {}

  registerOutboundHandler(handler: OutboundHandler): void {
    this.outboundHandlers.push(handler);
  }

  async handleBackendEvent(payload: BackendPayload): Promise<void> {
    const eventType = payload?.type;
    const data = payload?.payload && typeof payload.payload === 'object' ? payload.payload : {};
    const taskId = typeof data.task_id === 'string' ? data.task_id : undefined;
    if (!taskId) {
      return;
    }
    const projectId = typeof data.project_id === 'string' ? data.project_id : undefined;

    if (eventType === 'task_user_message') {
      await this.ensureSession(taskId, projectId);
      await this.sessions.addMessage(taskId, {
        messageId: this.resolveMessageId(data),
        role: this.coerceRole(data.role, 'user'),
        content: this.coerceContent(data.content),
        ackToken: data.ack_token ? String(data.ack_token) : null,
        metadata: this.coerceMetadata(data.metadata),
        attachments: this.coerceAttachments(data.attachments),
      });
      await this.notify(taskId);
    } else if (eventType === 'task_action') {
      await this.ensureSession(taskId, projectId);
      await this.sessions.addMessage(taskId, {
        messageId: this.resolveMessageId(data),
        role: this.coerceRole(data.role, 'action'),
        content: this.formatActionContent(data),
        ackToken: data.ack_token ? String(data.ack_token) : null,
        metadata: this.coerceMetadata(data.metadata),
        attachments: this.coerceAttachments(data.attachments),
      });
      await this.notify(taskId);
    } else if (eventType === 'task_status_update') {
      const session = await this.sessions.getSession(taskId);
      if (session && typeof data.status === 'string') {
        session.status = data.status;
      }
    }
  }

  async sendToBackend(payload: BackendPayload): Promise<void> {
    for (const handler of this.outboundHandlers) {
      const result = handler(payload);
      if (result && typeof (result as Promise<void>).then === 'function') {
        await result;
      }
    }
  }

  private async notify(taskId: string): Promise<void> {
    if (!this.notifier) {
      return;
    }
    await this.notifier.notifyNewMessage(taskId);
  }

  private resolveMessageId(data: Record<string, any>): string {
    const candidates = [data.message_id, data.action_id, data.id, data.request_id];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate;
      }
      if (typeof candidate === 'number') {
        return String(candidate);
      }
    }
    return RANDOM_UUID();
  }

  private coerceRole(role: any, fallback: string): string {
    if (typeof role === 'string' && role.trim()) {
      return role;
    }
    return fallback;
  }

  private coerceContent(content: any): string {
    if (typeof content === 'string') {
      return content;
    }
    if (content === undefined || content === null) {
      return '';
    }
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }

  private coerceMetadata(metadata: unknown): Record<string, unknown> | null {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      return null;
    }
    return { ...(metadata as Record<string, unknown>) };
  }

  private coerceAttachments(attachments: unknown): Array<Record<string, unknown>> {
    if (!Array.isArray(attachments)) {
      return [];
    }
    return attachments
      .filter(
        (entry): entry is Record<string, unknown> =>
          Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry),
      )
      .map((entry) => ({ ...entry }));
  }

  private formatActionContent(data: Record<string, any>): string {
    if (typeof data.content === 'string' && data.content.trim()) {
      return data.content;
    }
    const action = typeof data.action === 'string' && data.action.trim() ? data.action : 'action';
    const args = data.args;
    if (args && typeof args === 'object') {
      const command = args.command;
      if (typeof command === 'string' && command.trim()) {
        return `${action}: ${command.trim()}`;
      }
      try {
        return `${action}: ${JSON.stringify(args)}`;
      } catch {
        return `${action}: ${String(args)}`;
      }
    }
    return action;
  }

  private async ensureSession(taskId: string, projectId?: string): Promise<void> {
    const session = await this.sessions.getSession(taskId);
    if (session || !projectId) {
      return;
    }
    await this.sessions.addSession(taskId, taskId, projectId);
  }
}
