/**
 * Shared clipboard helper.
 *
 * Copying is surprisingly easy to get subtly wrong, so every call site should go
 * through here instead of hand-rolling the dance again:
 *
 * - `navigator.clipboard` only exists in secure contexts. Conductor is commonly
 *   self-hosted and reached over plain http on a LAN address, so the legacy
 *   `execCommand` path is a real code path, not a legacy curiosity.
 * - WebKit rejects clipboard writes issued outside a synchronous user gesture
 *   (e.g. from a long-press timer), so a rejected `writeText` must fall through
 *   to the fallback rather than be reported as failure.
 * - `textarea.select()` alone is a no-op on iOS Safari; the fallback has to
 *   select an explicit range.
 *
 * Never throws — returns whether the value actually made it to the clipboard so
 * callers can decide what feedback to show.
 */

const copyWithExecCommand = (value: string): boolean => {
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.contentEditable = 'true';
  // Kept on-screen but invisible: a negative offset makes iOS scroll the page
  // when focus moves to the textarea.
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '0';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);

  try {
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(textarea);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    textarea.setSelectionRange?.(0, value.length);
    textarea.select?.();
    return document.execCommand('copy');
  } finally {
    document.body.removeChild(textarea);
  }
};

export const copyToClipboard = async (value: string): Promise<boolean> => {
  if (typeof document === 'undefined') {
    return false;
  }

  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Fall through to the legacy path instead of giving up.
    }
  }

  try {
    return copyWithExecCommand(value);
  } catch {
    return false;
  }
};
