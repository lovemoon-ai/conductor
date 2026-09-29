# "New task from this" handoff link 404s after the apex stopped redirecting

## Symptom
After `conductor-ai.top` (the retired apex) was switched from a 301 to a flat
404, the successor AI in a "New task from this" task replied that it couldn't
load the previous conversation: `https://conductor-ai.top/share/<token>/plain`
returned 404. The same token on `conductor.conductor-ai.top` returned 200.

## Root Cause
The restart route builds `resume_context_url` from `resolvePublicBackendUrl()`,
which reads `NEXT_PUBLIC_URL` / `PUBLIC_BACKEND_URL` / `BACKEND_URL`. The prod
`web/.env.production.local` still had `NEXT_PUBLIC_URL` and `API_BASE_URL` set
to the apex. The 301 had been hiding the stale value, so the domain-change commit
(which only touched docs and nginx) didn't notice it.

## Fix
- Prod: changed both env lines to `https://conductor.conductor-ai.top` (backup
  `web/.env.production.local.bak-apex-domain-20260929`) and redeployed.
- Code: `resolvePublicBackendUrl` now rewrites the retired apex to the canonical
  host (logic moved from `resolveDeviceAuthorizationBaseUrl`, which now wraps
  it). A stale env value can no longer mint dead share or config URLs.

## How To Avoid This Next Time
When you retire a host or remove a redirect, grep the **live** env files on
the box for it (`grep -n <host> web/.env.production.local`), not just the repo.
A redirect hides stale config, so removing one is a behaviour change for every
URL generated from env. Also note that `deploy-prod.sh` copies the box
checkout's `web/nginx_conf`: if that checkout is older than the nginx change,
a redeploy silently restores the old config.
