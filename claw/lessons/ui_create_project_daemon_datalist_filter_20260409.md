# ui: create project dialog hides online daemons because of datalist filter (2026-04-09)

## Symptom

- On the production web app, when a user opened "Create Project", the Daemon Host dropdown could not select a daemon named `4090`.
- The same `4090` daemon was visible and online on the Settings page.
- The user saw only the first daemon (or a subset) in the create-project dropdown, even though the agents store contained every online daemon.

## Root cause

- `web/src/features/projects/components/CreateProjectDialog.tsx` rendered the daemon picker as an `<input list="daemon-host-options">` bound to a `<datalist>`.
- A `useEffect` auto-filled the input with `daemons[0].host` as soon as the dialog opened.
- HTML `<datalist>` in Chrome/Safari filters its options by the current input value as a substring match. Because the input was already pre-filled with an exact daemon host (e.g. `mac-mini`), the dropdown only showed options containing that substring, hiding every other daemon including `4090`.
- Both the Settings page and the dialog read from the same `useAgentsStore`, and the client-side filter (`!host.startsWith('conductor-fire-')`) was identical, so the data was correct — the bug was purely in the picker widget.

## Fix

- Replaced the `<datalist>` with a real `<select>` for the default online-daemon path. `<select>` never hides options and always shows the full list.
- Added a `manualMode` toggle ("Enter host manually" / "Pick from online daemons") so users can still type an offline daemon host. This preserves the existing `bindingCandidate` flow that saves the project and binds later when the daemon reconnects.
- The auto-prefill `useEffect` now skips manual mode so typed input is never overwritten. Switching back to select mode snaps the value to the first online daemon if the current value is not in the list, so the `<select>` does not fall into an empty-value state.
- `InlineNotice` text branches on `{noDaemons, manual+online, manual+offline, select}` so users understand whether the project will be created immediately or saved as a binding candidate.
- Reset `manualMode` on successful submit together with the other form fields.

## How to avoid next time

- Do not use `<datalist>` for picking from a finite, known set where every option must always be visible. `<datalist>` is a type-ahead hint, not a dropdown — browsers are allowed to filter it by the current input text, and a pre-filled input will hide most options.
- When an input must display every option regardless of current value, use `<select>` (or a custom listbox). Reserve `<input list>` for search-style affordances where hiding non-matching suggestions is the desired behavior.
- Any widget that auto-prefills a value should be audited for filter side effects — prefill + filtered dropdown is a common way to lock a user into the prefilled choice.
- When the same data is rendered in two UIs and one "works" while the other "doesn't", suspect the widget, not the data source. Verify the store/api parity first, then focus on the picker.
