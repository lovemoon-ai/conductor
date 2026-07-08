# Rokid App Dense Project, Task, And Chat Interaction

## Symptom

Rokid App reused the desktop-oriented project/task/chat presentation too directly. The HUD spent scarce viewport space on the Conductor title, realtime/WS status, global footer hints, project ids, and a seven-action chat prompt. Chat swipes changed voice/quick-reply focus instead of scrolling the conversation, so users could not review context naturally on glasses.

## Root Cause

The Android app had local presentation logic that did not mirror the web app's project/task semantics:

- Hidden projects and merged cross-daemon projects were not normalized before display.
- Merged project task lists still fetched a single `project_id`.
- Task pin metadata was ignored on Rokid.
- Chat scroll state was modeled as an offset from the newest messages and was reset on every entry/message.
- The chat input model overloaded swipe navigation with quick replies and voice candidate actions, which conflicted with the expected read-and-scroll interaction.

## Fix

Normalize Rokid project/task data at the API client boundary: filter hidden projects, group same-name projects across different daemons, fetch merged task scopes with `project_ids`, filter hidden tasks, and order pinned tasks first. Simplify the HUD to content-first lists and chat, show daemon labels instead of ids, and move voice status into chat only.

Chat selection now keeps a single meaning: tap starts speech or confirms the current recognition candidate. Chat swipes scroll messages. Default chat entry places the latest user-sent message at the top, manual scroll position is retained per task, and speech readout recenters the spoken message.

## Prevention

When adding a new compact client surface, first port the canonical web normalization rules for project grouping, hidden state, and task ordering into a tested pure helper. Avoid modeling wearable gestures as arbitrary action lists; reserve swipes for viewport navigation unless the screen has no scrollable content.
