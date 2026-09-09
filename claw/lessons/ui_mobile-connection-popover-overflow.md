# Connection details overflowed narrow screens

## Symptom

The fixed-width connection-details popover could extend beyond the edges of a mobile viewport.

## Root cause

Desktop absolute positioning and a 22rem width were applied at mobile widths too.

## Fix

Use a fixed mobile popover with left/right gutters and a scrollable height limit, retaining the anchored layout on larger screens.

## Prevention and verification

Inspect the open popover on narrow portrait and landscape viewports, including long connection details. The mobile browser regression checks containment and scroll access.
