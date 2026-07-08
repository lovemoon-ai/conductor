# Share popup copy and link reuse

## Symptom

After creating a task share link, the share popup stayed open when the user clicked one of the copy buttons. Reopening the share action could also go through the create-share flow again instead of showing the still-valid link the user already had.

## Root cause

The popup copy handler only copied the selected URL and showed a toast; it did not clear the popup state. The task share API always used the upsert path for user-facing shares, so it refreshed or rotated share state instead of first returning an existing unexpired share record.

## Fix

The share popup now closes after the copy action runs. Task cards cache the last valid share response during the current UI session, and the share API returns an existing unexpired share token before creating or rotating a token.

## Prevention

For share or invite flows, treat "create" actions as idempotent while a token is still valid. Cover both UI state transitions and server reuse behavior in tests so copy, reopen, expired, and missing-token paths stay explicit.
