# Crash-abandoned open chats need an idle retention rule

## Symptom

A fire process killed before close left an open conversation occupying resident capacity indefinitely.

## Root cause

Retention considered only the closed flag and did not record useful activity independently of worker lifetime.

## Fix

Track activity at creation, resume, submission and completion; migrate old records from turn timestamps. Archive open chats idle for seven days only when they have no worker, pending turn, protected subscription or unresolved review requirement. Preserve their identity for later resume.

## Validation and prevention

Seed 256 abandoned open chats and verify capacity is reclaimed, their provider URLs remain resumable, and recently active or review-required chats remain resident.
