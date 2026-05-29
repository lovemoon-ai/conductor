import { createHash } from 'crypto';
import type { NormalizedInboundEvent } from '../types';
import type { FeishuProviderConfig } from '../provider-config';

export async function normalizeFeishuRequest(body: any): Promise<NormalizedInboundEvent[]> {
  const event = body?.event ?? {};
  const message = event?.message ?? {};
  const sender = event?.sender?.sender_id ?? event?.sender ?? {};
  const text = extractFeishuMessageText(message);
  const mentionsBot = detectFeishuBotMention(message);

  if (!message?.message_id) {
    return [];
  }

  return [{
    provider: 'FEISHU',
    externalUserId: sender?.open_id ?? '',
    externalTenantId: event?.tenant_key ?? null,
    externalChatId: message?.chat_id ?? '',
    externalThreadId: message?.thread_id ?? null,
    externalTopicId: message?.topic_id ?? null,
    externalRootMessageId: message?.parent_id ?? message?.root_id ?? message?.message_id ?? null,
    externalMessageId: message?.message_id,
    externalEventId: body?.header?.event_id ?? null,
    conversationType: message?.chat_type === 'p2p' ? 'dm' : 'group',
    text,
    mentionsBot,
    rawPayload: body,
  }];
}

export async function sendFeishuReply(input: {
  config: FeishuProviderConfig;
  chatId: string;
  replyMessageId?: string | null;
  text: string;
  uuid: string;
}): Promise<{ messageId: string | null }> {
  const baseUrl = process.env.FEISHU_API_BASE_URL || 'https://open.feishu.cn';
  const token = await fetchFeishuTenantAccessToken(input.config, baseUrl);
  const uuid = normalizeFeishuUuid(input.uuid);

  const response = await fetch(`${baseUrl}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      receive_id: input.chatId,
      content: JSON.stringify({ text: input.text }),
      msg_type: 'text',
      uuid,
    }),
  });

  if (!response.ok) {
    const details = await response.text().catch(() => '');
    throw new Error(`Feishu reply failed: ${response.status}${details ? ` ${details}` : ''}`);
  }
  const data = await response.json().catch(() => ({}));
  return { messageId: data?.data?.message_id ?? null };
}

function normalizeFeishuUuid(value: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (normalized && normalized.length <= 50) {
    return normalized;
  }

  const digest = createHash('sha1')
    .update(normalized || `feishu-${Date.now()}`)
    .digest('hex');
  return `feishu-${digest}`.slice(0, 50);
}

function extractFeishuMessageText(message: any): string {
  if (typeof message?.content !== 'string') {
    return '';
  }

  try {
    const parsed = JSON.parse(message.content);
    if (typeof parsed?.text === 'string') {
      return stripFeishuMentionTokens(parsed.text, message);
    }

    const richText = extractFeishuPostText(parsed);
    if (richText) {
      return stripFeishuMentionTokens(richText, message);
    }
  } catch {
    return stripFeishuMentionTokens(message.content, message);
  }

  return stripFeishuMentionTokens(message.content, message);
}

function extractFeishuPostText(parsedContent: any): string {
  const rows = Array.isArray(parsedContent?.content) ? parsedContent.content : null;
  if (!rows) return '';

  const lines = rows.flatMap((row: any) => {
    if (!Array.isArray(row)) return [];
    const line = row
      .map((item: any) => {
        if (!item || typeof item !== 'object') return '';
        if (item.tag === 'text') {
          return typeof item.text === 'string' ? item.text : '';
        }
        if (item.tag === 'a') {
          return typeof item.text === 'string' ? item.text : '';
        }
        if (item.tag === 'at') {
          return '';
        }
        return '';
      })
      .join('');
    return line.trim() ? [line] : [];
  });

  return lines.join('\n');
}

function stripFeishuMentionTokens(text: string, message: any): string {
  if (typeof text !== 'string' || !text.trim()) {
    return '';
  }

  let stripped = text;
  const mentionKeys = Array.isArray(message?.mentions)
    ? message.mentions.flatMap((mention: any) => {
        const key = typeof mention?.key === 'string' ? mention.key.trim() : '';
        return key ? [key] : [];
      })
    : [];

  for (const key of mentionKeys) {
    stripped = stripped.split(key).join(' ');
  }

  stripped = stripped.replace(/@_user_\d+/g, ' ');
  return stripped
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function detectFeishuBotMention(message: any): boolean {
  if (Array.isArray(message?.mentions) && message.mentions.length > 0) {
    return true;
  }
  if (/@_user_\d+/.test(typeof message?.content === 'string' ? message.content : '')) {
    return true;
  }
  return false;
}

async function fetchFeishuTenantAccessToken(config: FeishuProviderConfig, baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      app_id: config.appId,
      app_secret: config.appSecret,
    }),
  });

  if (!response.ok) {
    throw new Error(`Feishu tenant access token failed: ${response.status}`);
  }

  const data = await response.json().catch(() => ({}));
  const token = typeof data?.tenant_access_token === 'string' ? data.tenant_access_token.trim() : '';
  if (!token) {
    throw new Error('Feishu tenant access token missing in response');
  }
  return token;
}
