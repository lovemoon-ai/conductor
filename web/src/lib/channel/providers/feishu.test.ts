import { describe, expect, it } from 'vitest';
import { normalizeFeishuRequest } from './feishu';

describe('normalizeFeishuRequest', () => {
  it('strips mention placeholder tokens from text messages', async () => {
    const events = await normalizeFeishuRequest({
      header: { event_id: 'evt_1' },
      event: {
        tenant_key: 'tenant_1',
        message: {
          message_id: 'om_1',
          chat_id: 'oc_1',
          chat_type: 'group',
          content: JSON.stringify({ text: '@_user_1 1+1=' }),
          mentions: [{ key: '@_user_1', name: 'bot' }],
        },
        sender: { sender_id: { open_id: 'ou_1' } },
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0].mentionsBot).toBe(true);
    expect(events[0].text).toBe('1+1=');
  });

  it('strips @ tags from rich post messages and keeps the actual text', async () => {
    const events = await normalizeFeishuRequest({
      header: { event_id: 'evt_2' },
      event: {
        tenant_key: 'tenant_1',
        message: {
          message_id: 'om_2',
          chat_id: 'oc_2',
          chat_type: 'group',
          message_type: 'post',
          content: JSON.stringify({
            title: '',
            content: [[
              { tag: 'at', user_id: 'ou_bot', user_name: 'Conductor Bot' },
              { tag: 'text', text: ' 1+1=' },
            ]],
          }),
        },
        sender: { sender_id: { open_id: 'ou_2' } },
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0].text).toBe('1+1=');
  });
});
