# A global runtime socket must not disable Gemini

## Symptom

Setting CHAT_WEB_RUNTIME_SOCKET made web-gemini fail with unknown_chat_web_provider.

## Root cause

Socket selection replaced the provider allowlist with the isolated runtime's site list.

## Fix

Resolve the provider independently, then choose the isolated runtime only for implemented runtime sites. Gemini continues through its shared-profile transport for both global and explicit socket configuration.

## Validation and prevention

Run Gemini turns with both socket configurations and verify the legacy transport is used without connecting to the socket.
