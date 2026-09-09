# Mobile keyboard covered dialog actions

## Symptom

The new-task sheet remained the full layout viewport height after the keyboard reduced the visible area, leaving footer actions outside it.

## Root cause

The portal-mounted dialog used 100dvh and could not inherit the workspace's visual viewport height; viewport panning was also unaccounted for.

## Fix

Share visual viewport bounds between the workspace and dialogs. Use height and offsetTop to constrain and position the dialog, with a scrollable body and fixed footer. Ignore pinch zoom and clean up listeners.

## Prevention and verification

Check resize, viewport scroll, keyboard dismissal, and desktop centering. Dialog tests cover bounds updates and listener cleanup; Chromium checks verify footer containment at 360px visual height and 48px offset. Physical mobile keyboards still need device validation.
