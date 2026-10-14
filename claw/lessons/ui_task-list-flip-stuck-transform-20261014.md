# Task list rows overlap after rapid reorders

## Symptom
Sometimes the task list ended up misaligned: one card was drawn on top of the card above it, and a blank gap opened lower down in the list. Reloading the page fixed it.

## Root cause
The desktop list animates reorders with FLIP in `TaskList.tsx`. In the layout effect, each moved row gets an inline `transform: translate(dx, dy)` with `transition: none`, and a `requestAnimationFrame` callback later clears it to play the slide.

If a second reorder ran before that frame fired, the effect called `cancelAnimationFrame` on the pending frame and scheduled a new one. The new frame only cleared the rows that moved in the second reorder. Rows from the first batch whose measured delta came out under 1px (because the stale transform was baked into `getBoundingClientRect`) kept their translate permanently.

This happens easily in a background tab, where rAF is paused while websocket status updates keep reordering the list.

## Fix
Track every row holding a FLIP start transform in `pendingFlipNodesRef`. At the start of each layout effect, cancel the pending frame and clear those transforms *before* measuring. The rAF callback clears the whole pending set. No row can be left translated, and the measurements are no longer skewed by stale transforms.

Regression test: `TaskList.test.tsx` › "never leaves a row translated when a reorder interrupts a pending FLIP frame".

## How to avoid next time
- When a cancellable rAF/timeout undoes a temporary style, the undo list must belong to a ref that outlives the cancellation, not to the closure that gets cancelled.
- Clear temporary transforms before calling `getBoundingClientRect` for layout math.
- `TaskList` is `memo`'d. A test `rerender` with identical props will not re-read a mutated store mock, so pass a fresh prop.
