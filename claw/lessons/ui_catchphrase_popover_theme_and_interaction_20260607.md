# Catchphrase Popover Theme and Interaction Regression

## Symptom

The chat composer catchphrase popover could render as a dark/black panel with unreadable text instead of matching the active theme. The intended behavior is light theme with a light surface and dark text, and dark theme with a dark surface and light text.

Follow-up review also found that row double-click could be interpreted as a single-click fill first, failed edit saves could discard the draft, and hydrate failures could show an empty state instead of a retryable error.

## Root Cause

The popover initially mixed Tailwind fixed color classes, `dark:` variants, inline CSS variables, and button defaults. In this app, project theme state is driven by the global `.dark` token set, so relying on Tailwind dark variants and inherited button color was fragile.

The row interaction also bound single-click and double-click to the same element without delaying/canceling the single-click action. Browser double-clicks include click events before `dblclick`, so the first click could close the popover before the send path ran.

The catchphrase store treated hydrate failures as hydrated and returned no success signal from update, which made UI failure states look like valid empty/success states.

## Fix

Added dedicated catchphrase popover CSS classes backed by the existing theme tokens, with explicit surface, border, muted, link, and row colors.

Changed row single-click to run through a cancelable delay and cancel that delay on double-click before sending.

Changed hydrate failure to leave `hydrated=false` so the popover can show an error and retry. Changed `update()` to return a boolean so the settings editor only closes after a confirmed save.

## Avoid Next Time

For theme-sensitive UI in the app shell, prefer the project semantic CSS tokens over Tailwind `dark:` variants unless the rendered browser style is verified under both themes.

For controls that support both single-click and double-click, test the real browser event sequence (`click`, `click`, `dblclick`) and include a timing edge case.

For optimistic mutations, return an explicit success/failure signal when the caller needs to preserve local draft state.
