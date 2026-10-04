import { describe, expect, it } from 'vitest';
import type { Message } from '@/shared/types';
import { isSpeakableReply, toSpeakableText } from './speakable-text';

const message = (overrides: Partial<Message>): Message => ({
  id: 'm1',
  taskId: 't1',
  role: 'sdk',
  content: '好的',
  metadata: { reply_to: 'u1' },
  ...overrides,
});

describe('voice speakable text', () => {
  it('only reads AI text replies', () => {
    expect(isSpeakableReply(message({}))).toBe(true);
    expect(isSpeakableReply(message({ role: 'user' }))).toBe(false);
    expect(isSpeakableReply(message({ metadata: { reply_to: 'u1', synthetic: true } }))).toBe(false);
    expect(isSpeakableReply(message({ metadata: null }))).toBe(false);
    expect(isSpeakableReply(message({ content: '  ' }))).toBe(false);
  });

  it('drops code, tables and urls and strips markdown', () => {
    const text = toSpeakableText([
      '## 结果',
      '已修复 **登录** 问题，见 [PR 12](https://github.com/x/y/pull/12)。',
      '```ts',
      'const a = 1;',
      '```',
      '| a | b |',
      '|---|---|',
      '- 改了 `auth.ts`',
      '详情 https://example.com/log',
    ].join('\n'));
    expect(text).toBe('结果 已修复 登录 问题，见 PR 12。 改了 auth.ts 详情');
  });

  it('cuts long replies at a sentence boundary', () => {
    const text = toSpeakableText(`${'这是一句话。'.repeat(20)}`, 40);
    expect(text.endsWith('。……')).toBe(true);
    expect(text.length).toBeLessThanOrEqual(42);
  });
});
