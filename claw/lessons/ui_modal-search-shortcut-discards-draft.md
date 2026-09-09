# Search shortcut discarded an open task draft

## Symptom

Pressing Cmd/Ctrl+K while writing in the new-task dialog navigated to search and lost the unsaved form.

## Root cause

The workspace keydown handler navigated without checking whether a modal was open or a child had consumed the event.

## Fix

Respect defaultPrevented and composition events, and consume the search shortcut without navigation while a native dialog or ARIA modal is open. Restore normal search behavior after closing the modal.

## Prevention and verification

Exercise global shortcuts with a populated modal, including both modifier keys and child controls that prevent default. The layout regression tests and browser checks cover draft preservation and shortcut recovery.
