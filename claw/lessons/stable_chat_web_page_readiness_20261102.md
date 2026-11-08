# Slow page loading must not be reported as expired login

## Symptom

A composer that did not become visible within ten seconds caused a misleading login-renewal error.

## Root cause

The runtime interpreted every ready:false result as proof of missing authentication.

## Fix

Include authRequired evidence in worker readiness. Login routes or a visible composer missing its authenticated selector identify authentication failures; missing composers otherwise report PAGE_NOT_READY. Forward this distinction through engine execution and AI SDK boot.

## Validation and prevention

Use Chromium fixtures for a hidden composer and an explicit sign-in URL, verify neither sends a prompt, and assert the SDK emits no auth_required event for loading failures.
