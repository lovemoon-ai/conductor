# RFC: Self-Hosted Bootstrap Login Without SMS Verification

## Status

Proposed

## Owner

TBD

## Date

2026-03-23

## Summary

This RFC proposes a minimal self-hosted bootstrap login flow that lets self-hosted users skip phone SMS verification during initial setup.

Instead of requiring SMS providers, fixed development codes, or OAuth setup, the server operator runs a one-time bootstrap script:

```bash
cd web
pnpm bootstrap:self-host --phone +8613800138000 --base-url https://your-domain.com
```

The script creates or reuses the user identified by the phone number, issues a long-lived API token, and prints a login URL:

```text
https://your-domain.com/?token=<token>
```

The user opens that link once in the browser and the existing web auth bootstrap logic establishes the session automatically.

This design deliberately avoids adding a production bypass to the SMS verification code path and does not require any bootstrap-specific `.env` switch.

## Context

Current login and registration on the web side are centered around phone verification codes:

- Login form: `web/src/components/auth/LoginForm.tsx`
- Code request and registration flow: `web/src/lib/auth/service.ts`
- Login routes: `web/src/app/api/auth/request-code/route.ts`, `web/src/app/api/auth/register/route.ts`

There is already a development-only shortcut:

- `AUTH_DEV_CODE` in `web/src/lib/auth/service.ts`
- documented in `web/.env.example`

However, that shortcut is explicitly intended for local development only and is not appropriate for production self-hosted deployments.

At the same time, the existing system already contains two capabilities that make a self-host bootstrap flow cheap to implement:

1. `authenticateToken()` already accepts bearer tokens and user tokens  
   - `web/src/lib/auth/service.ts`
2. The home page already supports URL-token auth bootstrap with `?token=` and clears the query string after session establishment  
   - `web/src/app/page.tsx`

This means self-host bootstrap can be implemented by reusing the current token system rather than by extending the SMS system.

## Goals

- Let self-hosted operators complete first login without configuring SMS
- Avoid adding a production backdoor to the verification-code flow
- Reuse existing token issuance and session bootstrap logic
- Keep the implementation minimal and operationally simple
- Support bootstrap by phone number, not email
- Avoid bootstrap-specific environment variables as the primary control surface

## Non-Goals

- Replacing the normal SMS login flow for hosted deployments
- Introducing a new password-based auth system
- Introducing a new OAuth provider for self-host bootstrap
- Designing a full admin/user management console in the first version
- Solving multi-user invitation and organization provisioning in this RFC
- Hardening the bootstrap link into a one-time short-lived token in the first version

## Options Considered

### Option A: Reuse `AUTH_DEV_CODE` in production self-host

**Approach**

- Allow self-hosted deployments to set a fixed verification code in production
- Keep the existing phone-code UI unchanged

**Pros**

- Smallest implementation change
- Reuses current login form and request-code flow

**Cons**

- Converts a development-only escape hatch into a production auth bypass
- Anyone who knows the code can register or log in as long as they can guess a target phone number
- Operationally easy to forget and unsafe to leave enabled

Conclusion: rejected.

### Option B: Add a bootstrap-specific `.env` flag and auto-create user on startup

**Approach**

- Add environment variables such as:
  - `SELF_HOST_BOOTSTRAP_ENABLED=true`
  - `SELF_HOST_BOOTSTRAP_PHONE=...`
- On server startup, auto-create the user and print a login link

**Pros**

- Low-friction for operators
- No extra command required after deployment

**Cons**

- Leaves sensitive bootstrap behavior coupled to long-lived deployment config
- Easy to forget to disable
- Startup behavior becomes less explicit and harder to reason about
- More likely to become an accidental persistent backdoor

Conclusion: rejected as the default design.

### Option C: Bootstrap script that creates/reuses a user and prints a token login URL

**Approach**

- Add a one-time operator command:

```bash
pnpm bootstrap:self-host --phone +8613800138000 --base-url https://your-domain.com
```

- The script:
  - normalizes the phone number
  - creates the user if needed
  - creates the default project if needed
  - issues an API token
  - prints a login URL using the existing `?token=` bootstrap path

**Pros**

- Minimal code change
- No SMS provider required
- No bootstrap backdoor in normal login APIs
- Explicit operator action
- Reuses existing auth/token/session logic

**Cons**

- The token appears in a URL
- Requires one extra command after deployment
- The first version relies on existing token semantics, not a one-time bootstrap token

Conclusion: choose this option.

## Proposed Design

### 1. Operator Command

Add a new script entry under `web/package.json`:

```bash
pnpm bootstrap:self-host --phone +8613800138000 --base-url https://your-domain.com
```

Required arguments:

- `--phone`: full international phone number in normalized form, preferably E.164-like, for example `+8613800138000`

Optional arguments:

- `--base-url`: public web URL used to print the final login link

Validation rules:

- phone must start with `+`
- phone may only contain `+` and digits after normalization
- whitespace may be stripped before validation

This command is intended to be run by the self-host operator on the server, not by normal end users.

### 2. Bootstrap Script Behavior

The script should:

1. Normalize the provided phone number
2. Look up `User.phone` using the normalized value
3. If the user does not exist:
   - create the user
   - generate placeholder `passwordHash` and `passwordSalt`, consistent with existing user creation logic
   - start the default access/trial path if required by current system behavior
   - create the default project if missing
4. If the user already exists:
   - reuse the user
   - ensure the default project exists if needed
5. Issue a new API token using the existing token issuance path
6. Print:
   - normalized phone
   - user id
   - raw API token
   - login URL: `<base-url>/?token=<token>`

Suggested output:

```text
Bootstrap user ready
Phone: +8613800138000
User ID: <uuid>
API Token: <token>
Login URL: https://your-domain.com/?token=<token>
```

### 3. Reused Existing Logic

The implementation should reuse existing auth building blocks as much as possible:

- user token issuance: `issueApiToken()` in `web/src/lib/auth/service.ts`
- session bootstrap from `?token=`: `web/src/app/page.tsx`
- token authentication: `authenticateToken()` in `web/src/lib/auth/service.ts`

This keeps the feature small and avoids introducing parallel auth mechanisms.

### 4. Why Phone Instead of Email

The current user-facing auth model is already centered around phone login.

Even though the backend supports email in some code paths, the current public login form is phone-first. For self-host bootstrap, using phone as the explicit identity keeps the mental model aligned with the existing product and avoids inventing a second onboarding identity convention.

The chosen operator experience is therefore:

```bash
pnpm bootstrap:self-host --phone +8613800138000
```

not:

```bash
pnpm bootstrap:self-host --email owner@example.com
```

### 5. Why Not `.env`

This RFC intentionally avoids using bootstrap-specific environment variables as the primary design.

Reasoning:

- bootstrap is a one-time operator action, not a persistent server mode
- long-lived secrets or bypass toggles in deployment config are easy to forget
- command-based execution is more explicit and easier to audit operationally

Normal deployment environment variables such as `NEXT_PUBLIC_URL` may still be read as optional defaults, but bootstrap enablement itself should not depend on `.env`.

## Risks

- **Token in URL**
  - The bootstrap URL contains a long-lived token and may appear in browser history, reverse proxy logs, screenshots, or analytics tooling.
- **Operator mishandling**
  - The printed login URL or raw token could be shared with the wrong person.
- **Repeated issuance**
  - Running the script many times for the same phone can create multiple long-lived tokens.
- **Identity ambiguity**
  - If operators enter poorly formatted phone numbers, they may accidentally create duplicate users for the same person.

## Mitigations

- Document that the bootstrap link is sensitive and should be treated like a secret
- Normalize phone numbers strictly before lookup and creation
- Print a warning that operators should rotate or revoke extra tokens if they accidentally over-issue them
- Keep the implementation scoped to self-host operator usage only
- Consider a future follow-up to replace the raw long-lived URL token with a short-lived one-time bootstrap token

## Rollout

1. Add the bootstrap script
2. Add a package.json command for it
3. Document the self-host bootstrap workflow in `README.md` and/or `web/README.md`
4. Keep the normal SMS login flow unchanged
5. Do not add any production behavior change to `AUTH_DEV_CODE`

## Acceptance

This RFC is considered implemented when all of the following are true:

- A self-host operator can run:

```bash
cd web
pnpm bootstrap:self-host --phone +8613800138000 --base-url https://your-domain.com
```

- The command creates or reuses the user identified by that phone number
- The command issues a usable API token
- The command prints a login URL using `?token=`
- Opening that URL in the browser establishes a valid web session
- No SMS provider is required for this bootstrap flow
- No production use of `AUTH_DEV_CODE` is introduced

## Open Questions

- Should the first version print the raw API token at all, or only the login URL?
- Should repeated runs for the same user always issue a new token, or should they optionally reuse/reveal the latest active token?
- Should the script require `--base-url`, or may it fall back to `NEXT_PUBLIC_URL` when present?
- Should a later RFC convert the `?token=` bootstrap link into a one-time or short-lived bootstrap credential?
