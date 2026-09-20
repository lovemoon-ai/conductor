# Unrelated updates re-rendered the entire transcript

## Symptom

Long chats felt sluggish while background tasks produced messages or the
current task changed its working status.

## Root cause

ChatView subscribed to the whole chat store and task array. Every update could
re-render all message bubbles and parse their unchanged Markdown again.
Inline action callbacks also changed identity on every parent render.

## Fix

Select the visible task's messages, loading/history state and task object.
Pass stable action callbacks and memoize MessageBubble and MarkdownRenderer.
Runtime-dependent action props still update, while unchanged Markdown is reused.

## Verification and prevention

Tests use real stores, ChatView, message bubbles and Markdown rendering with
200 messages. Background message/loading/task-list updates and current runtime
updates now cause zero additional Markdown parses, compared with 200 before.
Appending one message parses only the new message (1 instead of 201); content
edits and task switching still render the correct text. Runtime and task status
changes also retain the correct restart/interrupt button states.

A three-run local Vitest/happy-dom probe measured median update time changing
from 83 ms to below 1 ms for background messages, and from 61 ms to 1 ms for
runtime updates. These are controlled component measurements, not browser FPS
or production end-to-end latency. Guard both render counts and visible behavior
so memoization cannot hide stale content or disabled actions.
