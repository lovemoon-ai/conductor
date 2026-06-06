# 0031 SSO Protocol — Standard OIDC Trade-offs and Security Roadmap

## Status

Proposed (parking document — not yet committed to any work).

## Owner

TBD

## Date

2026-06-06

## Summary

Captures a one-session deep-dive on whether Conductor's custom OAuth-style
SSO ([RFC 0030](./0030-feature-sso-authorization-entrypoint.md)) should be
upgraded to standard OIDC, and which security-hardening tasks have the
best ROI at current scale. **The recommended next steps are small,
non-protocol-level fixes; a full OIDC migration is not justified unless
external (non-Conductor-team) clients become a real requirement within
12 months.** Filing this so the analysis isn't lost; reopen when a
concrete trigger (external integration, compliance ask, incident)
appears.

## Context

- Current state: Conductor SSO is a static-registration, server-to-server
  authorization-code flow returning `{ access_token, user, conductor_base_url }`
  in JSON. Spec lives in RFC 0030; integration guide in
  [`claw/developer/add-new-sso-client.md`](../developer/add-new-sso-client.md).
- Existing clients: `arxiv-radar` (prod) and `operator` (added 2026-06-06,
  see [operator deploy story](https://github.com/lovemoon-ai/operator)).
- Trigger for this conversation: while bringing up `operator` we found two
  bugs and asked whether the protocol shape itself should change.
  - Bug 1: operator was wired with a standard OIDC client
    (`openid-client`), which fails fast at `Issuer.discover()` because
    Conductor has no `/.well-known/openid-configuration`. Fixed by
    replacing OIDC client with a 70-line Conductor-specific adapter
    (operator's `lib/auth/conductor.ts`).
  - Bug 2: a stale `/opt/conductor/conductor/web/.env` on the volc box
    silently shadowed `web/.env.production.local` because Next.js's
    `loadEnvConfig` and our explicit `dotenv.config()` disagree on
    precedence. Fixed by deleting the stale file + adding a deploy
    guard (commit `6d7c07d` on this repo).

## Goals

- Provide a single reference for "what would full OIDC cost and what
  do we get?"
- Provide a single reference for "what hardening is worth doing
  regardless of the OIDC question?"
- Avoid relitigating these decisions in chat next time the topic comes
  up.

## Non-Goals

- Committing to any of the listed work. This RFC is a parking document.
- Designing the OIDC migration in detail. If/when we decide to do it,
  open a new RFC that picks one of the paths below and fleshes it out.
- Discussing client-side library choices (next-auth, openid-client,
  oidc-client-ts, etc.).

## Standard OIDC vs Conductor's Current Custom Flow

| Dimension | Standard OIDC | Conductor today |
| --- | --- | --- |
| Discovery (`/.well-known/openid-configuration`) | required | ❌ none — clients hard-code endpoints |
| JWKS endpoint (`/.well-known/jwks.json`) | required (id_token verification) | ❌ none — no signed tokens |
| Token response | `{ access_token, id_token, refresh_token?, token_type, expires_in, scope }` | `{ access_token, token_type, user: { id, email, phone, name }, conductor_base_url }` |
| `id_token` (signed JWT) | required; RS256/ES256 signature, claims include `iss`/`sub`/`aud`/`exp`/`nonce` | ❌ none — `user` is plain JSON, must trust transport |
| Userinfo endpoint (`/userinfo`) | standard | ❌ folded into token response |
| PKCE (`code_challenge` / `code_verifier`) | required for public clients, recommended for confidential | ❌ relies on `client_secret` only |
| `scope` parameter | granular: `openid profile email phone offline_access roles ...` | ❌ all-or-nothing per `(user, client_id)` token |
| `nonce` (id_token replay defense) | required | ❌ not applicable (no id_token) |
| Refresh tokens | optional, widely supported | ❌ tokens are long-lived, manual revoke |
| Client authentication | multiple methods (`client_secret_basic`, `client_secret_post`, `private_key_jwt`, `tls_client_auth`) | only JSON body with `client_secret` |
| End-session / RP-initiated logout | `end_session_endpoint` | ❌ each RP manages its own cookie |
| Dynamic client registration | optional | ❌ static, env-driven only |
| Authorization code lifetime | typically 10 min | 5 min (single-use) |

The functional gap that matters most for downstream apps is the
`id_token`: every Conductor API call from an RP today requires a
network round-trip back to Conductor to validate the user. With an
`id_token`, RPs would verify the signature locally and cache identity
for the token's lifetime.

## Three Hypothetical Migration Paths

Cost estimates assume one experienced web engineer, full-time, including
review and rollout. Numbers double if shared across multiple part-time
contributors.

### Path A — Minimal OIDC-ish (5 days)

Add what standard OIDC libraries need to interoperate, keep everything
else as-is.

Adds to Conductor:
1. `/.well-known/openid-configuration` (static-ish JSON)
2. `/.well-known/jwks.json` (public side of one signing key)
3. RSA-2048 or EdDSA signing key — generated, encrypted-at-rest, loaded
   at boot
4. `/api/oauth/token` returns `id_token` alongside the current
   `user` object (both, for back-compat)
5. Tests: unit (claim construction, signature) + integration (one OIDC
   library hits the full flow)

Operator-side change: swap `lib/auth/conductor.ts` for `openid-client`
initialization (~70 → ~80 lines, roughly equivalent).

Existing clients (arxiv-radar, operator's adapter) continue to work
unchanged.

### Path B — Full OIDC Core (~3-4 weeks)

Path A plus:
- PKCE enforced
- `scope` system (`openid profile email phone offline_access`)
- `/userinfo` endpoint, `nonce` propagation, refresh-token rotation
  with family revocation
- Multi-key JWKS + rotation procedure
- `end-session` endpoint, `prompt` parameter handling
- OpenID Connect Conformance Profile (BASIC OP at minimum)

Ongoing cost: key rotation SOP (every ~90 days), conformance re-run
after schema changes, refresh-token cleanup cron, abuse monitoring.

### Path C — Production-grade IdP (~3-6 months, 2-3 people)

Path B plus multi-tenant isolation, admin UI for clients/scopes,
HSM/KMS integration, HA signing, federation (Conductor as RP to other
IdPs), SAML compatibility, device authorization grant, SOC2/ISO27001
audit logging.

In practice this is "stop building it; deploy Auth0 / Keycloak /
Authentik instead and connect to it for user storage."

## Where the Cost Concentrates (Path A or B)

```
Cryptography + JWT signing/verification     ~15%
DB schema migration + data backfill         ~10%
PKCE / scope / nonce business logic         ~20%
Tests (single largest item)                 ~30%
Key + token lifecycle management            ~15%
Documentation + rollout + compat window     ~10%
```

≥60% of the work is server-side (Conductor). RP-side migration is
small — replacing the 70-line custom adapter with a standard library
config is roughly the same code volume.

## Threat Model — What Conductor SSO Actually Faces Today

| Threat | Likelihood | Impact | Current defense | Gap |
| --- | --- | --- | --- | --- |
| `client_secret` leak (repo, env backup, departed staff) | medium | high | code single-use + manual revocation | **no audit log** → can't tell if leaked secret was used |
| Brute-force secret enumeration on `/api/oauth/token` | medium | high | none | no rate limit; a script box can try 1k QPS |
| Loose-mode redirect_uri turning the authorize page into an open redirector | medium | medium | doc warning + `console.warn` | loose mode still default-allowed; warnings drown |
| Drifted env files (e.g. the `.env` shadow we hit on 2026-06-06) | high | medium-high | the new deploy guard | doesn't address env-at-rest exposure |
| `access_token` leaked from an RP backend | low-medium | medium | manual revoke | no expiry; leak-to-detect window can be months |
| Authorization code in referer / log | low | low | 5 min + single-use + HTTPS | PKCE would close it; confidential clients only today |
| Wrong-issuer / RP confusion | very low | medium | RP env hard-codes Conductor URL | needs id_token's `iss`/`aud` to close protocol-level |
| Server compromise + env-file read | low | very high | file mode 0600 | OIDC doesn't help here either |

**Insight**: the highest-impact gaps cluster around **visibility, endpoint
hardening, and default settings — not the protocol shape**. Most of the
useful security wins do not require any OIDC migration.

## Recommended Roadmap (Security ROI Order)

### Must-Do — High impact, ≤2 days each, no protocol changes (~1 week)

| # | Item | Effort | Defends against | Notes |
| --- | --- | --- | --- | --- |
| 1 | Audit log every `/oauth/authorize` and `/api/oauth/token` event (ts, client_id, ip, ua, outcome, code prefix, reason) | 1 d | post-leak forensics, abuse detection, compliance | **largest observability gap today**. DB table or JSON line log both fine. |
| 2 | Rate limit `/api/oauth/token` per `(client_id, ip)` (e.g. 30/min) | 1 d | secret brute force | reuse existing rate-limit middleware; 429 + alert |
| 3 | Reject loose mode by default — require non-empty `redirect_uris` | 0.5 d | open-redirector phishing | change `clients.ts` to `console.error + skip` instead of `console.warn`. Backfill `arxiv-radar`'s real list before flipping. |
| 4 | Default `client_secret_hash + salt`; refuse plaintext secrets when `NODE_ENV=production` | 1 d | env-at-rest leak | ~30 LOC + a CLI to migrate existing plaintext entries |
| 5 | Two-slot client secrets (accept `current` and `next` during rotation) | 1 d | rotation without coordinated downtime | adds `nextClientSecretHash/Salt` to `SsoClientConfig`; token endpoint tries both |
| 6 | Expired authorization-code cleanup cron | 0.5 d | DB growth, expired-code exposure surface | reuse existing outbox cron |
| Total | | **~5 d** | | net-add only; no client changes required |

### Optional — Open only if a specific trigger fires

| # | Item | Effort | Trigger to start work |
| --- | --- | --- | --- |
| 7 | `id_token` + JWKS + `/.well-known/openid-configuration` (Path A above) | 3 d | "we want to use `openid-client` / `next-auth`" or "RPs need offline identity verification to survive Conductor outages" |
| 8 | `access_token` TTL + refresh-token rotation | 5 d | "we have a half-trusted RP (e.g. customer-controlled deployment) and need short blast radius after a leak" |
| 9 | PKCE (without making it mandatory) | 2 d | "any non-backend client appears" (SPA / mobile / CLI). Cheap; bundle with #7 if you're touching that code anyway. |

### Don't-Do — Cost > benefit at current scale

- **`scope` system**: all current clients are full-trust; the consent
  screen + claim filter + per-scope token columns are 10+ days plus
  permanent cognitive overhead.
- **`/userinfo` endpoint**: information already in the token response;
  saving one RTT isn't worth a new public endpoint.
- **End-session / single-sign-out**: each RP managing its own cookie is
  fine; multi-RP coordinated logout is a "best-effort broadcast" at
  best, even in standard OIDC.
- **Dynamic client registration**: env-driven static registration is a
  feature, not a limitation — it forces ops review of each new client.
- **OIDC conformance certification**: no compliance ask justifies the
  fee/effort.

## Decision Triggers (Re-open This RFC When …)

- A non-Conductor-team app (customer, partner, open-source contributor)
  asks to integrate Conductor SSO.
- A compliance or audit requirement (SOC2, ISO 27001, internal sec
  review) demands signed assertions or scope-based access.
- An incident traces back to one of the gaps the recommended hardening
  would have closed (in which case bump that item to "must, this week").
- The number of internal RPs crosses ~5 — at that point the
  observability + rotation work in items #1, #2, #5 starts paying
  rent compounded across clients.

## Risks of Doing Nothing

- The Must-Do list above represents real risk: every additional client
  raises the secret-leak surface area, and we currently have no
  detection. Even if we never touch OIDC, items #1, #2, #4 should be
  treated as non-optional within the next quarter.
- The custom protocol is a hiring-friction signal: new engineers expect
  OIDC and need orientation to understand why this isn't it. Path A
  (5 days) buys a future where "we're OIDC-shaped" is true even if the
  full feature set isn't implemented.

## Acceptance

This RFC is **accepted** when we either:
- complete the Must-Do list (1 week), and explicitly defer items
  #7-#9 until a trigger fires; or
- decide to commit to Path A or B with a separate RFC that owns that
  scope.

Either outcome closes the open question of "should we switch to OIDC?"
for the next 12 months.

## References

- [RFC 0030 — SSO Authorization Entrypoint](./0030-feature-sso-authorization-entrypoint.md)
- [`claw/developer/add-new-sso-client.md`](../developer/add-new-sso-client.md)
- 2026-06-06 operator-deploy incident
  - operator commit `ff85c8e` — replace `openid-client` with custom adapter
  - conductor commit `6f92511` — scope `pkill` to conductor's path (don't kill sibling apps)
  - conductor commit `6d7c07d` — reject dual env files
