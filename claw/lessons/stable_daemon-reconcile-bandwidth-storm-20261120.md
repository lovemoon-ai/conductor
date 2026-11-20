# Daemon reconnect reconciliation saturated the production EIP

## Symptom

The web UI and agent WebSockets repeatedly stalled, especially after a server restart. Production showed sustained outbound bandwidth saturation, packet loss, TLS timeouts, and hundreds of full task-list responses during reconnect storms.

## Root cause

Every daemon startup and WebSocket reconnect downloaded the complete active task list for the user. The response included presentation data that reconciliation never reads. Concurrent reconnects and duplicate-host takeovers multiplied the large responses, while the 1 Mbps EIP amplified the resulting packet loss and retransmissions. An initial cooldown-only fix also risked dropping the final reconciliation request and bypassed the existing pre-migration schema fallback.

## Fix

- Added a daemon-scoped reconcile view that returns only the fields used by startup recovery and reconnect reconciliation, including the legacy schema fallback.
- Updated the CLI to use the lightweight view, coalesce in-flight and cooldown requests with a trailing run, retry failed reconciliations, and cancel pending work on shutdown.
- Limited agent gateway daemon reconnects to one accepted connection per user and host per minute, before duplicate-host takeover. Fire hosts and browser WebSockets are exempt.
- Added a per-user/IP safeguard for completely unfiltered full task-list requests after production traffic showed that per-host connection limiting alone could not suppress all legacy daemon recovery calls. Filtered browser and SDK reads and lightweight reconcile reads remain exempt.

## Prevention

- Keep recovery queries scoped to their caller and return only required fields at the database query layer.
- Test reconnect storms for both leading and trailing execution, request failure, shutdown cleanup, mixed-version behavior, and missing database columns.
- Track per-route response bytes and EIP bandwidth saturation in production alerts; a healthy local health check does not rule out network saturation.
