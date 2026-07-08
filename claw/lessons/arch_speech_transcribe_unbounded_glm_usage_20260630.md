# Speech Transcribe Unbounded GLM Usage

## Symptom

The speech transcription backend accepted authenticated uploads and forwarded
them to GLM without a per-user usage guard.

## Root Cause

The route authenticated the bearer token but did not attach any request or byte
quota to the authenticated user before calling the paid upstream ASR service.

## Fix

Added per-user request and byte-window limits for `/api/speech/transcribe`, with
configurable defaults and tests covering both request-count and byte quota
rejections.

## Prevention

Any route that proxies to a metered third-party AI provider must include an
abuse control before the upstream call, plus tests that prove the provider is
not called after quota rejection.
