# Mobile task-card merge drag needs delayed touch activation

## Symptom

Dragging one task card onto another worked with a mouse, but the same merge
gesture was unreliable or impossible on mobile browsers.

## Root cause

The original whole-card gesture used Pointer Events while the card declared
`touch-action: pan-y`. That preserved vertical scrolling, but it also allowed
the browser to claim a moving touch and emit `pointercancel` before merge drag
activation.

A permanent `touch-action: none` would make dragging work but break normal list
scrolling. A dedicated drag handle avoids that conflict technically, but does
not match the intended product interaction: the card itself should become
draggable only after a deliberate hold.

## Fix

- Keep mouse dragging on Pointer Events.
- Give touch input its own delayed activation path: hold the card for 450 ms to
  enter the visible drag state.
- Install a non-passive `touchmove` listener before the gesture begins. Before
  activation it leaves native scrolling alone; after activation it prevents
  scrolling and updates the drag ghost and drop target.
- Clear the TaskItem swipe state when the parent merge drag activates so a
  diagonal merge gesture cannot reveal action buttons at the same time.
- Cancel the pending hold when the finger moves beyond the tolerance, and treat
  `touchcancel` strictly as cancellation.
- Suppress the native context menu / WebKit touch callout while a touch drag is
  armed so it cannot cover the drag feedback.
- Do not render a separate drag handle.

## Prevention

Mobile drag interactions inside a scroll container must test the full gesture
contract:

1. Moving before the hold threshold remains an uncancelled native scroll.
2. Holding without movement visibly activates dragging.
3. Moving after activation is cancelled at the browser-default layer and can
   complete a drop.
4. `touchcancel` never completes a drop.

Do not rely on changing `touch-action` after a touch has started; browsers decide
gesture ownership at the beginning of the sequence.
