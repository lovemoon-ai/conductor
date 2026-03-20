# RFC: `conductor config` Device Code Login

## Status

Proposed

## Owner

TBD

## Date

2026-03-19

## Summary

This RFC proposes adding a **device code flow** to `conductor config`, replacing the current startup path where a user logs in on the web, manually copies an API token, and pastes it back into the terminal.

The target experience is:

1. The user installs the CLI and runs `conductor config`
2. The CLI displays a short device code and an authorization link
3. The user only needs to open one web page, log in, and approve the device
4. The CLI polls the server for the authorization result and the `agent_token`
5. The CLI writes `~/.conductor/config.yaml` automatically
6. The user can immediately continue with `conductor fire` or `conductor daemon`

This approach keeps long-lived tokens out of browser JavaScript and uses a safer model where the CLI initiates device authorization, the web page only approves it, and the CLI retrieves the result from the server.

## Context

The current onboarding flow for new users is:

1. Open the web login page and complete phone-code login or registration
2. Return to the home page `/`
3. Find the CLI install command and API token on the home page
4. Manually copy the token
5. Run `conductor config` in the terminal
6. Paste the token so the CLI can write `~/.conductor/config.yaml`
7. Then run `conductor fire` or `conductor daemon`

This path is implemented across several places:

- Web login form: `web/src/components/auth/LoginForm.tsx`
- Login/registration and token issuance: `web/src/lib/auth/service.ts`
- Home page token and install command display: `web/src/app/page.tsx`
- Getting started docs: `web/content/en/getting-started.mdx`
- CLI config entry point: `cli/bin/conductor-config.js`

Even though it works, there are obvious problems:

1. Manual copy step
   - The user has to switch between the web app and the terminal and copy/paste the token manually.

2. Easy to make mistakes
   - The wrong token may be copied
   - The token may be pasted into the wrong environment
   - The flow can end in a half-finished state where the user is logged in but the terminal is still not configured

3. The mental model is unnatural
   - What users really want is to connect this machine to Conductor
   - The current experience exposes the implementation detail of finding a token first

4. The home page carries too much onboarding responsibility
   - The current `/` page is both the post-login workspace and the CLI onboarding surface
   - Users have to understand the token instead of completing a device authorization action

5. Hard to extend
   - If we later want IDE support, desktop support, multi-device authorization management, or device revocation, the manual token copy flow will not scale well

## Goals

- Make `conductor config` the default one-step entry point on the CLI side
- Eliminate the manual token copy/paste step during first-time setup
- Preserve the security boundary so the web page does not expose a long-lived token string directly to browser code
- Write the local `config.yaml` automatically after authorization completes
- Stay compatible with the existing account system, token issuance flow, and web login system
- Keep `--token` as a fallback for no-browser and automation scenarios

## Non-Goals

- Reworking the entire web onboarding information architecture
- Replacing the existing `--token` or environment-variable-based configuration flow
- Introducing multiple scopes or permission levels in the first version
- Building a complete authorized-device management page in the first version
- Supporting QR codes, automatic browser opening, or other enhanced UX in the first version
- Converting the CLI login state into a long-lived OAuth refresh token model

## Options Considered

### Option A: Keep the manual token copy flow

**Approach**

- The user logs in on the web as usual
- Copies the API token from the home page
- Runs `conductor config`
- Pastes the token manually

**Pros**

- No new protocol or data model
- Smallest possible change

**Cons**

- Worst UX, and the main onboarding friction today
- Forces users to understand the token implementation detail
- Hard to support future device authorization and device management features

Conclusion: rejected. This is the current state and does not improve onboarding.

### Option B: Show the token on the web page and ask the CLI user to type it in

**Approach**

- Keep the token display on the home page
- Change the copy to something like "open this page to view your token"

**Pros**

- Smaller server-side change

**Cons**

- Still manual copy/paste in practice
- Does not truly combine "web login" and "device authorization" into one flow

Conclusion: rejected. This is only a presentation change and does not solve the core problem.

### Option C: localhost callback login

**Approach**

- `conductor config` starts a temporary local HTTP server
- The browser redirects back to `http://localhost:<port>` after login
- The CLI reads the token from the local callback

**Pros**

- Closer to a traditional OAuth browser login experience

**Cons**

- Requires a local open port
- Fragile in SSH, remote machine, WSL, container, or cloud-hosted environments
- The browser and CLI may not be on the same machine
- Operational and error-handling complexity increases

Conclusion: rejected. Conductor CLI usage does not always assume a local browser plus local CLI.

### Option D: Device code flow

**Approach**

- The CLI starts an authorization request and receives `device_code + user_code + verification_uri`
- The user logs in on any browser and approves the device
- The CLI polls the server for the final result

**Pros**

- Fits CLI, SSH, and cross-device workflows well
- The user only needs to open one page
- The browser never directly passes a long-lived token to the CLI
- Compatible with future authorized-device management features

**Cons**

- Requires a new device authorization session data model and API
- The CLI needs polling logic and a state machine

Conclusion: choose this option.

## Proposed Design

### 1. User Experience

#### 1.1 Default path

The user runs:

```bash
conductor config
```

The CLI prints:

- A short, user-friendly explanation
- `user_code`, for example `ABCD-EFGH`
- `verification_uri`
- `verification_uri_complete`
- A waiting message such as "Waiting for web authorization..."

Example:

```text
Open this link in your browser to authorize this device:
https://conductor-ai.top/activate

Device code: ABCD-EFGH
Direct link: https://conductor-ai.top/activate?user_code=ABCD-EFGH

Waiting for authorization...
```

#### 1.2 Web side

When the user opens the authorization page:

- If they are not logged in, they must log in first
- After login, the page shows the pending device details:
  - device code
  - request source (`Conductor CLI`)
  - hostname / daemon_name candidate
  - CLI version
  - backend URL
- The user clicks "Authorize this device"
- The success state says:
  - `Authorized device, you may close this page`

#### 1.3 After successful authorization

The CLI polls the server and receives:

- `agent_token`
- `backend_url`
- optional `websocket_url`

Then it:

1. Continues using the existing logic to detect locally installed coding CLIs
2. Writes `~/.conductor/config.yaml`
3. Prints the next steps:

```text
✓ Device authorized
✓ Wrote Conductor config to ~/.conductor/config.yaml

Next:
  conductor fire --backend codex -- "hi"
  conductor daemon
```

### 2. Security Model

The key principles are:

- The browser page does not directly display the long-lived `agent_token`
- The CLI does not rely on a browser redirect back to a local port
- The web page only performs the approval action
- The CLI exchanges a high-entropy `device_code` with the server for the final result

The flow is therefore:

1. The CLI creates a device authorization session
2. The server stores the session state
3. The user logs in on the web and approves the device
4. The CLI polls the server for the current state
5. Only when the state is `approved` does the server return a token

### 3. Data Model

Add a new device authorization session table, suggested name: `DeviceAuthSession`.

Suggested fields:

- `id`
- `deviceCodeHash`
- `userCode`
- `status`
  - `pending`
  - `approved`
  - `denied`
  - `expired`
  - `consumed`
- `requestedByIp`
- `cliVersion`
- `hostname`
- `platform`
- `backendUrl`
- `expiresAt`
- `approvedAt`
- `deniedAt`
- `consumedAt`
- `approvedByUserId`
- `issuedUserTokenId`
- `createdAt`
- `updatedAt`

Notes:

- `device_code` should be a high-entropy secret and stored only as a hash
- `user_code` is a short human-readable code and can be stored in plain text with an index
- `issuedUserTokenId` points to an existing `UserToken` record so the token can be audited and later revoked

### 4. State Machine

Device authorization session state machine:

`pending -> approved -> consumed`

and the exception branches:

- `pending -> denied`
- `pending -> expired`

Constraints:

- `approved` may only be consumed once
- Once the CLI successfully receives the token, the session becomes `consumed`
- Expired sessions are moved to `expired`
- `denied` and `expired` are terminal states and can only be restarted by creating a new authorization session

### 5. API Design

#### 5.1 CLI starts authorization

`POST /api/auth/device/start`

Request body:

```json
{
  "cli_version": "x.y.z",
  "hostname": "mac-studio",
  "platform": "darwin",
  "backend_url": "https://conductor-ai.top"
}
```

Response:

```json
{
  "device_code": "high-entropy-secret",
  "user_code": "ABCD-EFGH",
  "verification_uri": "https://conductor-ai.top/activate",
  "verification_uri_complete": "https://conductor-ai.top/activate?user_code=ABCD-EFGH",
  "expires_in": 600,
  "interval": 3
}
```

Notes:

- `device_code` is stored by the CLI only
- `user_code` is shown to the user
- `interval` controls the polling frequency

#### 5.2 CLI polls for the authorization result

`POST /api/auth/device/poll`

Request body:

```json
{
  "device_code": "high-entropy-secret"
}
```

Pending:

```json
{
  "status": "pending"
}
```

Approved:

```json
{
  "status": "approved",
  "agent_token": "token-value",
  "backend_url": "https://conductor-ai.top",
  "websocket_url": "wss://conductor-ai.top/ws/agent"
}
```

Denied:

```json
{
  "status": "denied",
  "message": "Authorization denied"
}
```

Expired:

```json
{
  "status": "expired",
  "message": "Authorization expired"
}
```

Notes:

- When the response is `approved`, the server should immediately mark the session as `consumed`
- This prevents the same `device_code` from being exchanged for a token more than once

#### 5.3 Web page queries the pending authorization

`GET /api/auth/device/session?user_code=ABCD-EFGH`

The response can be rendered on the page:

```json
{
  "status": "pending",
  "user_code": "ABCD-EFGH",
  "cli_version": "x.y.z",
  "hostname": "mac-studio",
  "platform": "darwin",
  "expires_at": "2026-03-19T12:34:56.000Z"
}
```

#### 5.4 Web page approves the authorization

`POST /api/auth/device/approve`

Authentication requirement:

- The user must be logged in

Request body:

```json
{
  "user_code": "ABCD-EFGH"
}
```

Server actions:

1. Find the session in `pending` state
2. Get or create a `UserToken` for the current user
3. Set `approvedByUserId` / `issuedUserTokenId` / `approvedAt`
4. Update the state to `approved`

Response:

```json
{
  "ok": true
}
```

#### 5.5 Web page rejects the authorization, optional

`POST /api/auth/device/deny`

Request body:

```json
{
  "user_code": "ABCD-EFGH"
}
```

The first version can skip a dedicated deny button and rely on approve + timeout only.

### 6. Web Page Design

Add a new page: `/activate`

Page logic:

1. Read `user_code` from the query string
2. If the user is not logged in, redirect them to the login page and then back to this page
3. Call `GET /api/auth/device/session`
4. Show device information and the remaining lifetime
5. After the user approves, show a success state

Suggested page states:

- `missing_code`
- `invalid_code`
- `expired`
- `pending`
- `approved`
- `denied`

Success state copy:

- Title: `Device authorized`
- Description: `Authorized device, you may close this page`

### 7. CLI Changes

`cli/bin/conductor-config.js` should become a two-path flow:

#### Path A: Device code authorization, default

- If the user does not explicitly pass `--token`
- Enter the device code flow by default

Flow:

1. Call `POST /api/auth/device/start`
2. Print the device code and link
3. Poll `POST /api/auth/device/poll`
4. Receive `agent_token` on success
5. Continue using the existing logic to detect installed CLIs
6. Write the local `config.yaml`

#### Path B: Manual token, fallback

Keep support for:

- `conductor config --token <token>`
- `conductor config --manual`
- CI or no-browser environments
- private deployments that do not yet have the device-code page wired up

### 8. Token Strategy

Re-use the existing `UserToken` model instead of introducing another device-specific token system.

When the server approves the device authorization:

1. Try to reuse the user's most recent non-revoked token
2. If none exists, mint a new token
3. Return that token to the CLI

For better auditability later, the token can be named, for example:

- `config-device`
- `config-mac-studio`

This makes it easier to distinguish the origin of the token in the backend.

### 9. Config Writing Strategy

The CLI should continue generating its own local config instead of downloading the entire server-side YAML.

Reason:

- The server does not know which coding CLIs are installed on the local machine
- The server does not know the user's preferred `daemon_name`
- The server should not decide the local `workspace` or `envs`

Therefore:

- The server returns:
  - `agent_token`
  - `backend_url`
  - `websocket_url`
- The CLI fills in locally:
  - `daemon_name`
  - `allow_cli_list`
  - `workspace`
  - `envs`

### 10. Relationship to the existing onboarding flow

After launch, the onboarding copy should be updated to:

1. Install the CLI
2. Run `conductor config`
3. Approve the device in the browser
4. Run `conductor fire` or `conductor daemon`

This replaces the current docs that say:

- "Copy the token from the web home page"
- "Go back to the CLI and paste the token manually"

Keeping the token display as an advanced-user and debugging fallback is still reasonable.

## Risks

1. Polling endpoint abuse
   - Enforce a minimum polling interval
   - Rate-limit each session

2. Short device code guessing
   - `user_code` must only be used for human confirmation and not as the real credential for minting a token
   - The real credential should be the high-entropy `device_code`

3. Authorizing the wrong device
   - The page should display hostname, platform, and CLI version
   - Make it obvious which request is being approved

4. Cross-environment confusion
   - Dev, staging, and prod must generate the correct domain-specific `verification_uri`
   - A production CLI must never point to a development authorization page

5. Slow cleanup of expired sessions
   - Expired sessions need background cleanup
   - Consumed sessions should not accumulate indefinitely

6. Backward compatibility with older CLIs
   - Keep `--token`
   - Clearly distinguish the old and new paths in the docs

## Rollout

### Phase 1: Backend and page closure

- Add the `DeviceAuthSession` table
- Implement:
  - `POST /api/auth/device/start`
  - `POST /api/auth/device/poll`
  - `GET /api/auth/device/session`
  - `POST /api/auth/device/approve`
- Add the `/activate` page

### Phase 2: CLI default flow

- Make `conductor config` default to device code authorization
- Keep `--token`
- Print clearer next-step guidance

### Phase 3: Docs and home page updates

- Update `web/content/en/getting-started.mdx`
- Update the English getting started content
- Change the home page narrative from token-copy driven to `conductor config` driven

### Phase 4: Optional enhancements

- Automatic browser opening
- QR code
- Deny button
- Authorized device management page
- Device revocation

## Acceptance

This RFC is considered complete when all of the following are true:

- A user can complete `conductor config` with only one browser hop after installing the CLI
- The user no longer needs to manually copy a home-page token into the terminal
- The CLI successfully writes `agent_token` into `~/.conductor/config.yaml`
- The CLI can still detect and write the local coding CLI configuration
- After authorization, the user can run `conductor fire` or `conductor daemon` immediately
- `conductor config --token` still works as a fallback
- The success state clearly tells the user that the device is authorized and the page can be closed
- The server never displays a long-lived token directly on the authorization page

## Open Questions

- Should the first version include an explicit deny button, or should approve + timeout be enough?
- When minting a token, should we prefer reusing an existing token or always create a new named token?
- Should we ship an authorized-device list and revocation flow in the first version?
- Should the CLI automatically open the browser to `verification_uri_complete` by default?
- Should `daemon_name` be shown on the authorization page and editable by the user, or should it continue to default to the machine hostname?
