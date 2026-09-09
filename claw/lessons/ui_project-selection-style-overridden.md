# Project selection was visually indistinguishable

## Symptom

A selected project lost its visible selection styling when the pointer moved away despite aria-pressed remaining true.

## Root cause

The workspace project-row CSS had higher specificity than the component's selected utility classes.

## Fix

Apply the selected background and inset accent directly to the workspace project row's aria-pressed state, including hover.

## Prevention and verification

Check computed styles and the rendered row after selection, pointer exit, and hover. The browser regression verifies that selected and unselected backgrounds differ and that the accent remains.
