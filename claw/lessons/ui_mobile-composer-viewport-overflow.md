# Long mobile drafts pushed chat controls outside the viewport

## Symptom

Long drafts and viewport changes could consume the conversation area or place chat controls beyond the visible mobile region.

## Root cause

Textarea sizing used a large fraction of window.innerHeight and only recalculated for content changes, without accounting for keyboard height, container size, or attachment controls.

## Fix

Bound textarea height by the visual viewport and chat container, reserve space for controls and conversation, and remeasure on viewport/container changes. Keep the surrounding chat flex layout shrinkable where appropriate.

## Prevention and verification

Test long drafts with keyboard resizing, orientation changes, and attachments; confirm that existing text is preserved and send controls remain reachable. Keep observer and animation-frame cleanup covered in component behavior checks.
