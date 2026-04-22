# UI: Issue backend selection and move placement

## Symptom
- Moving a `todo` issue to `doing` needed an AI backend selection before spawning work.
- Review found two follow-up risks: stale board positions while the backend dialog was open, and mixed-version daemons without `supportedBackends` being rejected.

## Root Cause
- The UI cached an absolute target `position` before the backend dialog was confirmed.
- The issue spawn route trusted a single selected daemon compatibility check instead of preserving legacy empty-backend behavior.
- Dragging to the end of a column initially lost its anchor intent by turning into a generic append.

## Fix
- Store move placement intent as append or neighboring issue anchors, then recompute position from the latest issue list when the backend is confirmed.
- Preserve trailing and leading anchors by using current neighboring issues to compute midpoints and avoid duplicate positions.
- Validate requested backends server-side while allowing legacy daemons with no advertised backend list.

## Avoid Next Time
- For delayed UI confirmations, cache user intent rather than derived positions.
- Treat empty capability lists from mixed-version daemons as unknown capability unless the protocol explicitly makes them authoritative.
- Add regression tests for concurrent ordering changes, especially first/last item placements.
