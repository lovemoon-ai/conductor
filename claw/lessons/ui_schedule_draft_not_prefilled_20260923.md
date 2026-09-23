# ui: scheduling the composer draft opened an empty form (2026-09-23)

## Symptom

- Type a message in the chat composer, then choose "Schedule" (previously the composer ⋯ menu, now the chat's top-right ⋯ menu).
- The Scheduled Messages dialog opened on its "New" form, but the Message Content box was empty, so the draft had to be retyped.

## Root cause

- `Dialog` is a native `<dialog>` that stays mounted while closed, so `ScheduledMessageForm` was already mounted with empty content before the first open.
- The form seeds its text once, through `useState(initialContent)`, and its React key was `new:${message.id}`.
- A composer draft is passed as a message with `id: ''`, so the key stayed `new:` when the dialog opened. The form was never remounted and kept its empty initial state.
- The dialog tests mocked `Dialog` as "render nothing while closed", which hid the mounted-while-closed behavior.

## Fix

- The form's key now includes the draft content (`new:${message.id}:${initialContent}`), so opening with a draft remounts and seeds the form.
- Regression test: render the dialog closed, reopen it with a draft, and assert the textarea holds the draft. The test uses a `Dialog` mock that keeps its children mounted, like the real one.

## How to avoid next time

- A component that seeds state from props with `useState(prop)` must be keyed on every prop that seeds it, or the parent must mount it only when it opens.
- Test mocks of containers (dialogs, sheets, tabs) must match the real mount lifecycle. A mock that unmounts while closed hides stale-state bugs.
