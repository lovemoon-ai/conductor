# Symptom

Opening a task in the web app could trigger a server-side `PATCH /api/tasks/[taskId]` crash with `Unexpected end of JSON input` when the request arrived without a JSON body.

# Root Cause

The task PATCH route unconditionally called `request.json()`. An empty request body is valid at the HTTP layer, but `request.json()` throws on empty input before the route can apply default no-op patch semantics.

# Fix

Read the raw request body first. Treat an empty body as `{}`, and only return `400` when the body is present but malformed JSON.

# Avoid Next Time

For mutation routes where an empty payload can plausibly arrive from older clients, retries, or manual calls, parse `request.text()` first and distinguish between:
- empty body
- valid JSON body
- malformed JSON body
