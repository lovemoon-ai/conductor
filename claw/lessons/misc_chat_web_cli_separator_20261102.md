# Consume the wrapper separator before the packaged CLI command

## Symptom

conductor chat-web -- runtime status forwarded the wrapper separator as the packaged command.

## Root cause

The wrapper copied args.slice(i), including its own delimiter.

## Fix

Consume a leading wrapper delimiter. Retain the inner chat send delimiter, which the runtime needs to preserve literal message text beginning with --.

## Validation and prevention

Check forwarded command arguments omit the wrapper delimiter and still preserve literal --config-file message text after chat send's own delimiter.
