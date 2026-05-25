# Hide quota cards for unsupported external backends

## Symptom

The quota panel displayed `web-chatgpt` and `web-gemini` cards with:

```text
No external model quota data yet.
```

Those browser-backed providers do not implement a quota endpoint, so the cards
suggested missing data rather than an unsupported capability.

## Root Cause

The panel rendered every advertised external backend. The daemon returns a
specific unavailable-hook result for providers without quota support, but the
UI did not distinguish it from a quota-capable provider returning no current
records.

## Fix

The quota panel filters external provider cards whose response explicitly
reports that the quota-list hook is unavailable. Quota-capable providers still
render when their list is empty or a fetch temporarily fails.

## Prevention

When UI lists are derived from runtime-discovered capabilities, test both
unsupported capability responses and supported-but-empty responses so absence
is not presented as missing data.
