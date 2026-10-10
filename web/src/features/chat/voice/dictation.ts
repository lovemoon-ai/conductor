/**
 * Continue a draft with dictated text: Chinese runs straight on, Latin words
 * get a space between them.
 */
export const joinDictation = (draft: string, spoken: string): string => {
  const before = draft.replace(/\s+$/, '');
  const after = spoken.trim();
  if (!before) return after;
  if (!after) return before;
  const latinGap = /[\x21-\x7e]$/.test(before) && /^[A-Za-z0-9]/.test(after);
  return `${before}${latinGap ? ' ' : ''}${after}`;
};
