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

/** The parts of the composer a voice message continues (see `MessageInputHandle`). */
export type DictationDraft = {
  getDraft: () => string;
  setDraft: (content: string) => void;
  getFiles: () => File[];
  clearFiles: () => void;
};

/**
 * Send a voice message as the continuation of the composer: typed text +
 * what was said, with any attached files. The composer is emptied while it
 * sends; if the send does not go through, everything is put back (after
 * anything typed meanwhile) and the files stay attached.
 * `getInput` is read again after the send, since the composer re-renders.
 */
export const sendDictation = async (
  getInput: () => DictationDraft | null | undefined,
  spoken: string,
  send: (content: string, files: File[]) => Promise<boolean>,
): Promise<boolean> => {
  const input = getInput();
  const full = joinDictation(input?.getDraft() ?? '', spoken);
  const files = input?.getFiles() ?? [];
  input?.setDraft('');
  const putBack = () => {
    const current = getInput();
    if (!current) return;
    const draft = current.getDraft();
    // `send` may already have restored it (ChatView's handleSend does on failure).
    if (draft.replace(/\s+$/, '').endsWith(full)) return;
    current.setDraft(joinDictation(draft, full));
  };
  let sent: boolean;
  try {
    sent = await send(full, files);
  } catch (error) {
    putBack();
    throw error;
  }
  if (sent) {
    if (files.length) getInput()?.clearFiles();
  } else {
    putBack();
  }
  return sent;
};
