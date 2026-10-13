import type { Message } from '@/shared/types';

/** One synthesize request (the route accepts at most 2 000 characters). */
export const MAX_SEGMENT_CHARS = 1_500;

/** An AI text reply (same rule as reply-latency's first-text-reply check). */
export const isSpeakableReply = (message: Message): boolean =>
  (message.role === 'sdk' || message.role === 'assistant') &&
  typeof message.metadata?.reply_to === 'string' &&
  message.metadata.reply_to !== '' &&
  message.metadata?.synthetic !== true &&
  message.content.trim() !== '';

/**
 * Turn an agent's markdown reply into something worth reading aloud: drop code
 * blocks, tables and URLs, keep link/inline-code text, strip markup. The whole
 * reply is read (no length cap) unless `maxChars` asks to cut it at a sentence.
 */
export const toSpeakableText = (markdown: string, maxChars = Number.POSITIVE_INFINITY): string => {
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

const SENTENCE_END = /[。！？!?；;\n]|\.(?=\s)/g;

/**
 * Split speakable text into request-sized pieces, cutting at sentence ends
 * where possible, so a reply of any length can be read aloud piece by piece.
 */
export const splitForSpeech = (text: string, maxChars = MAX_SEGMENT_CHARS): string[] => {
  const segments: string[] = [];
  let rest = text.trim();
  while (rest.length > maxChars) {
    const head = rest.slice(0, maxChars);
    let cut = -1;
    for (const match of head.matchAll(SENTENCE_END)) cut = (match.index ?? 0) + match[0].length;
    if (cut < maxChars / 2) {
      const space = head.lastIndexOf(' ');
      cut = space > maxChars / 2 ? space + 1 : maxChars;
    }
    segments.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) segments.push(rest);
  return segments.filter(Boolean);
};
