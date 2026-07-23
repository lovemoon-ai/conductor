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
 * - iOS Safari ignores programmatic selection on a `readonly` control, which is
 *   what makes the usual `textarea.select()` recipe silently copy nothing there.
 *
 * Never throws — returns whether the value actually made it to the clipboard so
 * callers can decide what feedback to show.
 */

const copyWithExecCommand = (value: string): boolean => {
  const textarea = document.createElement('textarea');
  textarea.value = value;
  // iOS only honours programmatic selection on an editable control, so the
  // element must stay editable. `readonly` would suppress the on-screen
  // keyboard but also blocks the selection, and the element is removed within
  // the same tick anyway, so the keyboard never gets a chance to appear.
  textarea.contentEditable = 'true';
  textarea.readOnly = false;
  // Kept on-screen but invisible: a negative offset makes iOS scroll the page
  // when focus moves to the textarea.
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '0';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);

  try {
    // Note: selecting a Range over the textarea's *contents* does nothing —
    // assigning `.value` does not create child nodes, so the range comes back
    // collapsed. The control's own selection is what execCommand copies.
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(0, value.length);
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
