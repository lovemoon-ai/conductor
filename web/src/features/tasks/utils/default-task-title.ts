// Display-width budget (CJK/full-width/emoji = 2, others = 1): ~10 CJK or ~20 Latin
// characters fit the 18px task header on a 375px-wide phone without truncation.
const MAX_TITLE_WIDTH = 20;
// Full-width punctuation and newlines always end a clause; ASCII punctuation only when
// followed by whitespace, so `app.ts` or `1,000` stay intact.
const CLAUSE_BREAK = /[，。！？；\n]|[,.!?;](?=\s|$)/;

export function deriveDefaultTaskTitle(content: string): string {
  const text = content.trim();
  const breakIndex = text.search(CLAUSE_BREAK);
  const clause = (breakIndex > 0 ? text.slice(0, breakIndex) : text).replace(/\s+/g, ' ');
  let title = '';
  let width = 0;
  for (const char of clause) {
    width += char.codePointAt(0)! >= 0x2e80 ? 2 : 1;
    if (width > MAX_TITLE_WIDTH) {
      // Never cut an English word in half; drop the partial word unless it is the only one.
      if (/\w$/.test(title) && /\w/.test(char)) title = title.replace(/\s*\w+$/, '') || title;
      break;
    }
    title += char;
  }
  return title.trim();
}
