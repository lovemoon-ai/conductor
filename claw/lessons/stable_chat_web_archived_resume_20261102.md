# Profile retention must preserve Conductor resume identity

## Symptom

Conductor releases a browser whenever fire exits, so pruning closed chats after 32 releases made otherwise valid task IDs fail with NOT_FOUND.

## Root cause

Browser release was treated as permission to delete the identity needed for future provider-side resume.

## Fix

Archive a small durable identity record before removing resident metadata, turns or profiles. Lookup and resume use that archive to reactivate the same local ID, provider, account, URL and resume guard. Profile deletion shares the worker-allocation queue so a concurrent restore cannot lose its replacement profile.

## Validation and prevention

Close 34 managed Kimi/DeepSeek sessions, restart, then resume the first task and recall the original provider context. Exercise fresh-profile recovery with real Chromium fixtures and block cleanup to test concurrent restoration.
