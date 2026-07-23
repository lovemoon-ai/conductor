import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyToClipboard } from './clipboard';

describe('copyToClipboard', () => {
  const writeText = vi.fn();
  let originalExecCommand: typeof document.execCommand;

  const setSecureContext = (value: boolean) => {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value });
  };

  beforeEach(() => {
    originalExecCommand = document.execCommand;
    writeText.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    setSecureContext(true);
    document.execCommand = vi.fn().mockReturnValue(true);
  });

  afterEach(() => {
    document.execCommand = originalExecCommand;
  });

  it('uses the async clipboard api in a secure context', async () => {
    await expect(copyToClipboard('task-123')).resolves.toBe(true);

    expect(writeText).toHaveBeenCalledWith('task-123');
    expect(document.execCommand).not.toHaveBeenCalled();
  });

  it('uses the execCommand fallback outside a secure context', async () => {
    // Self-hosted Conductor reached over plain http on a LAN address.
    setSecureContext(false);

    await expect(copyToClipboard('task-123')).resolves.toBe(true);

    expect(writeText).not.toHaveBeenCalled();
    expect(document.execCommand).toHaveBeenCalledWith('copy');
  });

  it('falls through to execCommand when the clipboard api rejects', async () => {
    // WebKit rejects writes issued outside a synchronous user gesture.
    writeText.mockRejectedValue(new Error('NotAllowedError'));

    await expect(copyToClipboard('task-123')).resolves.toBe(true);

    expect(writeText).toHaveBeenCalled();
    expect(document.execCommand).toHaveBeenCalledWith('copy');
  });

  it('hands execCommand a focused, fully selected, editable control', async () => {
    // iOS ignores programmatic selection on a readonly control, so assert the
    // actual state execCommand sees rather than that some helper was called.
    setSecureContext(false);
    let observed: Record<string, unknown> | null = null;
    document.execCommand = vi.fn().mockImplementation(() => {
      const active = document.activeElement as HTMLTextAreaElement | null;
      observed = {
        tag: active?.tagName,
        value: active?.value,
        selectionStart: active?.selectionStart,
        selectionEnd: active?.selectionEnd,
        readOnly: active?.readOnly,
      };
      return true;
    });

    await copyToClipboard('task-123');

    expect(observed).toEqual({
      tag: 'TEXTAREA',
      value: 'task-123',
      selectionStart: 0,
      selectionEnd: 'task-123'.length,
      readOnly: false,
    });
  });

  it('reports failure instead of throwing when every path fails', async () => {
    writeText.mockRejectedValue(new Error('NotAllowedError'));
    document.execCommand = vi.fn().mockReturnValue(false);

    await expect(copyToClipboard('task-123')).resolves.toBe(false);
  });

  it('reports failure instead of throwing when execCommand itself throws', async () => {
    setSecureContext(false);
    document.execCommand = vi.fn().mockImplementation(() => {
      throw new Error('boom');
    });

    await expect(copyToClipboard('task-123')).resolves.toBe(false);
  });

  it('never leaves the temporary textarea behind', async () => {
    setSecureContext(false);
    document.execCommand = vi.fn().mockImplementation(() => {
      throw new Error('boom');
    });

    await copyToClipboard('task-123');

    expect(document.querySelectorAll('textarea')).toHaveLength(0);
  });
});
