# Whitespace-only messages were accepted by the API

## Symptom
The API accepted a message whose content was only spaces or newlines and
delivered it to the AI. The web composer never sends one.

## Root cause
`POST /tasks/:id/messages` only checked `!body.content`.

## Fix
The route rejects trimmed-empty content with 400 `content required`.

## How to avoid next time
Validate on the server what the UI validates, and trim before you check.
