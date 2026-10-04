import type { Message } from '@/shared/types';

export const MAX_SPOKEN_CHARS = 600;

/** An AI text reply (same rule as reply-latency's first-text-reply check). */
export const isSpeakableReply = (message: Message): boolean =>
  (message.role === 'sdk' || message.role === 'assistant') &&
  typeof message.metadata?.reply_to === 'string' &&
  message.metadata.reply_to !== '' &&
  message.metadata?.synthetic !== true &&
  message.content.trim() !== '';

/**
 * Turn an agent's markdown reply into something worth reading aloud: drop code
 * blocks, tables and URLs, keep link/inline-code text, strip markup, and cut
 * at a sentence boundary so a long report doesn't monologue for minutes.
 */
export const toSpeakableText = (markdown: string, maxChars = MAX_SPOKEN_CHARS): string => {
  const text = markdown
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .split('\n')
    .filter((line) => !/^\s*\|/.test(line))
    .join('\n')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__|~~|\*|_)(?=\S)([^\n]*?\S)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= maxChars) return text;
  const head = text.slice(0, maxChars);
  const cut = Math.max(...['。', '！', '？', '. ', '! ', '? ', '；'].map((mark) => head.lastIndexOf(mark)));
  return `${cut > maxChars / 2 ? head.slice(0, cut + 1) : head}……`;
};
