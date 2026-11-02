# Closed chats must retain unacknowledged uncertain results

## Symptom

Closing a chat released its browser but allowed retention to delete uncertain turn history before the user inspected it.

## Root cause

The closed-chat pruning loop protected active operations but omitted the needsReview check already used for idle open chats.

## Fix

Exclude closed chats with needsReview from profile/history collection until the user explicitly acknowledges the uncertainty.

## Validation and prevention

Seed an expired closed chat with an uncertain result alongside more than 32 other closed chats. Its profile and history survive pressure, restart and another close. After acknowledgement it becomes eligible for normal retention.
