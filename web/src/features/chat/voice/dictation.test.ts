import { describe, expect, it, vi } from 'vitest';
import { joinDictation, sendDictation, type DictationDraft } from './dictation';

describe('joinDictation', () => {
  it('continues the draft with what was said', () => {
    expect(joinDictation('', '你好。')).toBe('你好。');
    expect(joinDictation('帮我看一下测试，', '然后提交。')).toBe('帮我看一下测试，然后提交。');
    expect(joinDictation('run the tests.', 'Then commit.')).toBe('run the tests. Then commit.');
    expect(joinDictation('改一下 ', '')).toBe('改一下');
  });
});

const composer = (draft: string, files: File[] = []) => {
  const state = { draft, files };
  const input: DictationDraft = {
    getDraft: () => state.draft,
    setDraft: (next) => {
      state.draft = next;
    },
    getFiles: () => state.files,
    clearFiles: () => {
      state.files = [];
    },
  };
  return { state, getInput: () => input };
};

describe('sendDictation', () => {
  const file = new File(['x'], 'shot.png');

  it('sends typed text + speech + attached files as one message, then clears them', async () => {
    const { state, getInput } = composer('看这张图，', [file]);
    const send = vi.fn(async () => {
      expect(state.draft).toBe(''); // emptied while sending
      return true;
    });
    await expect(sendDictation(getInput, '帮我分析一下', send)).resolves.toBe(true);
    expect(send).toHaveBeenCalledWith('看这张图，帮我分析一下', [file]);
    expect(state).toEqual({ draft: '', files: [] });
  });

  it('puts everything back when the send does not go through', async () => {
    const blocked = composer('看这张图，', [file]);
    await expect(sendDictation(blocked.getInput, '帮我分析', async () => false)).resolves.toBe(false);
    expect(blocked.state).toEqual({ draft: '看这张图，帮我分析', files: [file] });

    const failed = composer('看这张图，', [file]);
    await expect(sendDictation(failed.getInput, '帮我分析', async () => {
      throw new Error('Attachments cannot start a round');
    })).rejects.toThrow('Attachments cannot start a round');
    expect(failed.state).toEqual({ draft: '看这张图，帮我分析', files: [file] });
  });

  it('does not put the text back twice when the sender already restored it', async () => {
    const { state, getInput } = composer('改一下，');
    await expect(sendDictation(getInput, '提交', async (content) => {
      state.draft = content; // ChatView's handleSend restores the draft before throwing
      throw new Error('send failed');
    })).rejects.toThrow();
    expect(state.draft).toBe('改一下，提交');
  });
});
