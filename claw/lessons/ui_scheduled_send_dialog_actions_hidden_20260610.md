# Scheduled send dialog actions must remain visible and contrasted

## Symptom

In the Schedule Send dialog, selecting one of the four schedule modes made that
mode button appear to disappear in dark theme. The dialog also left users with a
Cancel button but no obvious confirmation action next to it, especially on
longer schedule forms.

## Root Cause

The selected mode button and submit button used `bg-ink text-white`. In light
theme this produced enough contrast, but in dark theme `--ink` is a light color,
so the selected control rendered as nearly white text on a nearly white
background.

The dialog placed all content and actions in one normal document flow. Longer
modes, such as repeat and idle interval, could push the submit action away from
the visible bottom of the dialog, making the confirmation path unclear.

## Fix

Selected schedule mode buttons and the submit button now use the app accent
gradient with white text, avoiding theme-dependent `ink` contrast. The form was
split into a scrollable content body and a fixed action footer, keeping Cancel
and Confirm Schedule visible together.

Component tests cover the fixed footer structure and guard against reintroducing
`bg-ink` on the active mode or confirmation button. The flow was also verified
manually in a local browser across all four schedule modes in dark theme.

## Prevention

Avoid using semantic text colors such as `ink` as filled button backgrounds
unless the light and dark theme contrast pair is explicitly checked. For dialogs
with variable-height forms, keep primary actions in a non-scrolling footer so
users always have a clear confirmation path.
