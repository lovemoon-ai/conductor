# Shift/Ctrl/Cmd+Enter scrambled the message when you kept typing

## Symptom

In the chat composer, pressing Shift+Enter (or Ctrl/Cmd+Enter) and continuing to
type immediately moved the first character of the new line to the **end** of the
draft. `ALPHA` + newline + `BRAVOCHARLIE` came out as:

```
ALPHA
RAVOCHARLIEB
```

The scrambled text was then sent and persisted that way — the transcript and the
database both stored the corrupted message, so it was not a rendering artifact.
It reproduced non-deterministically at ordinary human typing speeds (6 of 16
runs at 30–200 ms per keystroke), which made it easy to dismiss as a typo.

## Root cause

The newline branch of the composer's keydown handler updated React state and
then restored the caret in a `setTimeout(..., 0)`:

```ts
const newContent = content.slice(0, start) + '\n' + content.slice(end);
updateContent(newContent);
setTimeout(() => {
  textarea.selectionStart = textarea.selectionEnd = start + 1;
}, 0);
```

React's re-render assigns `textarea.value`, and assigning the value of a
textarea moves the caret to the **end**. The caret therefore sat at the end of
the draft from the moment React committed until the `setTimeout` macrotask ran.
Any keystroke delivered inside that window was inserted at the end. Once the
timeout fired, the caret jumped back to `start + 1` and every later character
landed correctly — which is why exactly one character teleported.

## Fix

Perform the edit through the DOM and reapply the caret in a `useLayoutEffect`,
which runs synchronously after React's commit, before the browser can dispatch
another key event. There is no longer a window in which the caret is wrong:

```ts
textarea.setRangeText('\n', start, end, 'end');
pendingCaretRef.current = start + 1;
updateContent(textarea.value);
```

Note `setRangeText`'s `selectionMode` argument is **not** honoured by jsdom (it
leaves the caret at the end of the whole value), so the caret is computed
explicitly as `start + 1` rather than read back from the element.

## Why it was not caught

The pre-existing test asserted the caret inside `waitFor(...)`, which polls
until the assertion passes. That happily waited for the `setTimeout` to fire, so
it documented the final caret position but not the window before it — precisely
the defect. The regression test now asserts the caret **synchronously**
immediately after the keydown, and then simulates the keystroke that lands in
that window; it fails with `expected 12 to be 6` on the old code.

This race had existed for as long as Ctrl/Cmd+Enter inserted newlines, but those
are rarely used. Adding Shift+Enter (the natural key for a line break) moved the
latent bug onto the main path, so it surfaced during release QA for 0.13.3.

## Prevention

- When a handler mutates a controlled input's value and caret, set both in the
  same synchronous step, or restore the caret in `useLayoutEffect` — never in
  `setTimeout` / `requestAnimationFrame`. A controlled re-render resets the
  caret to the end, and user input can be delivered before a later task runs.
- Do not wrap caret/selection assertions in `waitFor`. It converts "eventually
  correct" into a pass and hides exactly this class of race. Assert
  synchronously, then simulate the input that would race with the update.
