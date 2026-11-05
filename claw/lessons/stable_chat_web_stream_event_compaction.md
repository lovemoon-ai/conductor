# Long replies must not fail because of the number of text updates

## Symptom

A response could hit the 2000-event limit before the five-minute send timeout,
become uncertain and require manual recovery even though its text was small.

## Root cause

The runtime treated incremental event count as a reply-size limit. Each poll
could append a new event, so a healthy long-running stream eventually failed.

## Fix

Keep the text-size limit, but compact text history periodically into a complete
message_snapshot. Replacements immediately supersede older text events.
Allocate sequence numbers from the last sequence rather than array length.
Validate RPC replay cursors against the last sequence, not the compacted count.
Already-published sequences never change; sequence gaps are expected.

## Validation and prevention

Drive 2600 local progress updates, reconstruct live and replayed text, replay
from a cursor larger than retained history, reject a future cursor and repeat
replay after restart. Repeated large replacements retain one snapshot. Verify
the one-million-character reply limit still fails oversized text. No live
provider requests are needed for event-history tests.
