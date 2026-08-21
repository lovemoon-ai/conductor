# Attachment binding and outbox transaction gap

## Symptom

An upload could become permanently bound to a saved message even though no command was available for the target Agent.

## Root cause

Message creation and attachment binding committed before the Agent outbox row was created.

## Fix

For attachment messages, message creation, attachment binding, task activity update, and Agent outbox creation now share one database transaction.

## Prevention

Persist domain state and the durable command that publishes it in the same transaction. Immediate network delivery must remain best-effort after that commit.
