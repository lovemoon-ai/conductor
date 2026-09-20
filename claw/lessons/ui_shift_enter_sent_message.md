# Shift+Enter sent the draft instead of inserting a newline

## Symptom and root cause

The chat composer handled Ctrl+Enter and Command+Enter as newline shortcuts,
but omitted Shift+Enter. It therefore submitted the draft when users tried to
insert a line break.

## Fix

Include Shift in the existing newline branch. Keep selection replacement,
caret placement and plain Enter submission unchanged.

## Prevention

The regression test replaces selected text with a newline using Shift+Enter,
checks that nothing was sent and the caret moved after the newline, then sends
the complete multiline draft with plain Enter. It fails on the previous code
because the first keypress calls the send handler. Test editing shortcuts
against both draft contents and unintended sends.
