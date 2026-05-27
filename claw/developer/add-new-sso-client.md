# Add a New SSO Client to Conductor

This document describes how a third-party application integrates with Conductor SSO and how to test the integration end to end.

Conductor SSO is a server-side OAuth-style authorization-code flow for **trusted, pre-registered** apps. It is **not** a public OAuth/OIDC provider. The full spec is in [`claw/rfc/0030-feature-sso-authorization-entrypoint.md`](../rfc/0030-feature-sso-authorization-entrypoint.md).

The first reference integration is `arxiv-radar`. Use it as the template when wiring a new app.

## 1. What you get

After integration, your app's login button can:

1. Redirect the user to Conductor (`/oauth/authorize`).
2. Conductor signs the user in (or reuses an existing session) and sends a one-time `code` back to your callback.
3. Your app's backend exchanges the `code` for a Conductor `access_token` plus user identity.
4. Your backend uses that `access_token` as a regular Conductor API/App SDK token (`Authorization: Bearer …`).

The browser never sees the `access_token`, and the user never has to copy a token by hand.

## 2. Endpoints

| Endpoint | Caller | Purpose |
| --- | --- | --- |
| `GET /oauth/authorize` | User's browser | Authorization entry page; produces a `code` after the user is signed in. |
| `POST /api/oauth/authorizations` | Conductor's own `/oauth/authorize` page (client-side, with the user's JWT) | Internal — creates the code. Not called by third-party apps. |
| `POST /api/oauth/token` | Third-party app **backend** | Exchanges `code` for `access_token` (server-to-server). |

Your app only needs to know `GET /oauth/authorize` and `POST /api/oauth/token`.

## 3. Register your client

Client registration is **config-driven**, not UI-driven. Conductor reads the registry from the `CONDUCTOR_SSO_CLIENTS_JSON` environment variable.

### 3.1 Minimal configuration

The smallest possible client entry needs three fields:

```bash
CONDUCTOR_SSO_CLIENTS_JSON='[
  {
    "client_id": "your-app",
    "display_name": "Your App",
    "client_secret": "<a long random string>"
  }
]'
```

The value **must be a single-line JSON string** — `dotenv` does not parse multi-line values.

| Field | Required | Notes |
| --- | --- | --- |
| `client_id` | yes | Public identifier. Appears in URLs. Must be unique. |
| `display_name` | yes (recommended) | Human-readable name. Falls back to `client_id` if omitted. |
| `client_secret` | yes¹ | Plaintext shared secret used only server-to-server. |
| `client_secret_hash` + `client_secret_salt` | yes¹ | Alternative to plaintext. PBKDF2 hash, produced by `hashSecret()` in `web/src/lib/auth/service.ts`. Use this if you do not want plaintext in env. |
| `redirect_uris` | optional | Exact-match allowlist. If omitted, Conductor accepts any `http(s)://` redirect URI presented by the client (loose mode). |
| `trusted` | optional | Reserved; not enforced in v1. |

¹ You must supply either `client_secret` or both `client_secret_hash` and `client_secret_salt`. A client with no secret will be skipped at load time with a `console.error`.

### 3.2 When to use `redirect_uris`

| Mode | What you write | Security posture |
| --- | --- | --- |
| **Strict (recommended for production)** | `"redirect_uris": ["https://your-app.example.com/api/auth/callback", "http://localhost:3000/api/auth/callback"]` | Conductor checks `redirect_uri` with **exact** string match. No prefix matching, no `?query=` tolerance. |
| **Loose (minimal config)** | Omit `redirect_uris` entirely | Conductor accepts any well-formed `http(s)://` URL. `code` is still bound to the URI in the DB (token exchange must replay the same value). Conductor will log a `console.warn` on every config load. |

Loose mode means Conductor's `/oauth/authorize` becomes an open redirector. The remaining defense is the `client_secret` (attacker cannot exchange a leaked code). Only use loose mode if you understand the trade-off and own both ends.

### 3.3 Where to place the env var

`web/server.ts` loads dotenv as follows:

| Environment | File |
| --- | --- |
| Local dev (`pnpm dev` / `make run-dev`) | `web/.env` (or `web/.env.local` for gitignored overrides) |
| Production (`NODE_ENV=production`) | `web/.env.production.local` |
| Containers / hosted platforms | Set the env var directly (K8s Secret, Vercel env, Render env, etc.) |

After changing the env, restart the Next.js server so the registry is reloaded.

### 3.4 Optional companion env

```bash
CONDUCTOR_PUBLIC_BASE_URL=https://conductor-ai.top
```

Only used by `/api/oauth/token` to populate the `conductor_base_url` field in its response. If omitted, Conductor derives it from `x-forwarded-proto` + `host` of the incoming request.

## 4. Implement the third-party side

The third-party app needs **two HTTP handlers**, both on the backend (not in browser JS). Pseudocode below uses a Node/Express-like style; the protocol is framework-agnostic.

### 4.1 Login entry: `GET /api/auth/login`

```ts
// your-app: /api/auth/login
import { randomBytes } from "node:crypto";

export async function GET(req: Request, res: Response) {
  // 1. Generate a CSRF state and store it in your own HttpOnly cookie.
  const state = randomBytes(16).toString("hex");
  res.setHeader(
    "Set-Cookie",
    `your_app_oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${
      process.env.NODE_ENV === "production" ? "; Secure" : ""
    }`,
  );

  // 2. Build the Conductor authorize URL.
  const url = new URL(`${process.env.CONDUCTOR_BASE_URL}/oauth/authorize`);
  url.searchParams.set("client_id", process.env.CONDUCTOR_CLIENT_ID!);
  url.searchParams.set("redirect_uri", `${process.env.YOUR_APP_BASE_URL}/api/auth/callback`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);

  // 3. 302 to Conductor.
  res.redirect(302, url.toString());
}
```

### 4.2 Callback: `GET /api/auth/callback`

```ts
// your-app: /api/auth/callback
export async function GET(req: Request, res: Response) {
  const url = new URL(req.url, `${process.env.YOUR_APP_BASE_URL}`);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieState = parseCookie(req.headers.cookie, "your_app_oauth_state");

  // 1. Validate state to defend against CSRF.
  if (!code || !state || !cookieState || state !== cookieState) {
    return res.status(400).send("Invalid state");
  }

  // 2. Server-to-server: exchange code for token.
  const resp = await fetch(`${process.env.CONDUCTOR_BASE_URL}/api/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: process.env.CONDUCTOR_CLIENT_ID,
      client_secret: process.env.CONDUCTOR_CLIENT_SECRET,
      code,
      redirect_uri: `${process.env.YOUR_APP_BASE_URL}/api/auth/callback`,
    }),
  });

  if (!resp.ok) {
    const detail = await resp.text();
    console.error("conductor token exchange failed", resp.status, detail);
    return res.status(401).send("Token exchange failed");
  }

  const { access_token, user, conductor_base_url } = await resp.json();

  // 3. Establish your own app's session. The Conductor access_token must
  //    stay server-side — encrypt it before persisting, never send it to
  //    the browser.
  const session = await createAppSession({
    conductorUserId: user.id,
    displayName: user.email ?? user.phone,
    encryptedConductorToken: encrypt(access_token),
    conductorBaseUrl: conductor_base_url,
  });

  // 4. Set your own session cookie and redirect to the app home.
  res.setHeader(
    "Set-Cookie",
    [
      `your_app_session=${session.id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 7}${
        process.env.NODE_ENV === "production" ? "; Secure" : ""
      }`,
      `your_app_oauth_state=; Path=/; HttpOnly; Max-Age=0`,
    ],
  );
  res.redirect(302, "/");
}
```

### 4.3 Calling Conductor APIs later

```ts
const ctx = await loadAppSession(req);
const access = decrypt(ctx.encryptedConductorToken);

await fetch(`${ctx.conductorBaseUrl}/api/auth/me`, {
  headers: { Authorization: `Bearer ${access}` },
});
```

The same token works with the Conductor App SDK / BFF.

## 5. Conductor's contract

### 5.1 `POST /api/oauth/token`

Request:

```json
{
  "grant_type": "authorization_code",
  "client_id": "your-app",
  "client_secret": "<the secret you registered>",
  "code": "<value returned to your callback>",
  "redirect_uri": "<must equal the one used at /oauth/authorize>"
}
```

Successful response (200):

```json
{
  "access_token": "raw-conductor-user-token",
  "token_type": "Bearer",
  "user": {
    "id": "user-id",
    "email": "user@example.com",
    "phone": "+8613800138000",
    "name": null
  },
  "conductor_base_url": "https://conductor-ai.top"
}
```

Error responses:

| HTTP | `error` | Cause |
| --- | --- | --- |
| 400 | `invalid_request` | Missing fields or unparseable JSON. |
| 400 | `unsupported_grant_type` | `grant_type` ≠ `authorization_code`. |
| 400 | `invalid_grant` | Code missing, expired, already consumed, or `redirect_uri` mismatch. |
| 401 | `invalid_client` | Unknown `client_id` or wrong `client_secret`. |

### 5.2 Token lifecycle

- A new `access_token` is created per `(user, client_id)` pair, with name `connected-app:<client_id>`.
- Subsequent token exchanges for the same user + client **reuse the existing token** instead of rotating it. This means the user's earlier login still works after a re-auth.
- No refresh token. The token is long-lived until manually revoked (e.g. via the `web` token management UI or `revokeToken()` service call).

### 5.3 Authorization code lifecycle

- 32-byte URL-safe random value (`base64url`).
- Stored only as PBKDF2 hash + salt + 8-char prefix. The plaintext only exists in the redirect URL (one round trip) and your callback handler.
- TTL: 5 minutes.
- Single-use: `consumedAt` is set atomically; replay returns 400 `invalid_grant`.

## 6. Test it locally

### 6.1 Smoke test in 10 minutes (no third-party app needed)

The flow below uses `httpbin.org/get` as a stand-in for your callback. It echoes the redirect URL's query string so you can copy the `code` by hand.

1. Register a throw-away client in `web/.env`:

   ```bash
   CONDUCTOR_SSO_CLIENTS_JSON='[{"client_id":"test-app","display_name":"Test App","client_secret":"test-secret-12345"}]'
   ```

2. Start the dev server:

   ```bash
   make run-dev
   ```

3. In a browser already signed in to Conductor at `http://localhost:6152/`, open:

   ```
   http://localhost:6152/oauth/authorize?client_id=test-app&redirect_uri=https%3A%2F%2Fhttpbin.org%2Fget&state=hello-state-123&response_type=code
   ```

   You should be redirected to `httpbin.org/get?code=…&state=hello-state-123`. Copy the `code` value.

4. Exchange the code:

   ```bash
   CODE="<paste here>"
   curl -s -X POST http://localhost:6152/api/oauth/token \
     -H 'Content-Type: application/json' \
     -d "{
       \"grant_type\": \"authorization_code\",
       \"client_id\": \"test-app\",
       \"client_secret\": \"test-secret-12345\",
       \"code\": \"$CODE\",
       \"redirect_uri\": \"https://httpbin.org/get\"
     }" | jq
   ```

   Expect a JSON response containing `access_token`, `user.id`, `user.email|phone`.

5. Verify the token works:

   ```bash
   TOKEN="<access_token from previous step>"
   curl -s http://localhost:6152/api/auth/me -H "Authorization: Bearer $TOKEN" | jq
   ```

6. Verify single-use enforcement — replay the same exchange:

   ```bash
   curl -s -X POST http://localhost:6152/api/oauth/token ... # same body as step 4
   # Expect: {"error":"invalid_grant","message":"Invalid or expired authorization code"}
   ```

### 6.2 Error-path checks

| Test | How | Expected |
| --- | --- | --- |
| Wrong `client_secret` | Replace with garbage in step 4 | HTTP 401, `error: invalid_client` |
| Unknown `client_id` | Same | HTTP 401, `error: invalid_client` |
| Wrong `grant_type` | `"grant_type": "password"` | HTTP 400, `error: unsupported_grant_type` |
| Missing fields | Empty body | HTTP 400, `error: invalid_request` |
| `/api/oauth/authorizations` without Bearer | Direct POST | HTTP 401, `error: Unauthorized` |
| Unknown `client_id` on the authorize page | Open `/oauth/authorize?client_id=does-not-exist&...` | Page renders `This app is not allowed to sign in with Conductor.` and never redirects |
| Unauthenticated user opens authorize page | Logout in another tab, then revisit | Page redirects to `/login?next=/oauth/authorize?...` (a relative path; not an external redirect) |

### 6.3 With a real callback server

If you want to test your own callback handler end to end before deploying, the lightest option is a Python one-liner:

```bash
python3 -c "
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
import json
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        q = parse_qs(urlparse(self.path).query)
        self.send_response(200); self.end_headers()
        self.wfile.write(json.dumps(q).encode())
HTTPServer(('localhost', 8765), H).serve_forever()
"
```

Then point the authorize URL at `http://localhost:8765/cb`:

```
http://localhost:6152/oauth/authorize?client_id=test-app&redirect_uri=http%3A%2F%2Flocalhost%3A8765%2Fcb&state=hello&response_type=code
```

This works with **loose mode** out of the box. If you have configured strict `redirect_uris`, add `"http://localhost:8765/cb"` to the allowlist first.

### 6.4 Automated tests in this repo

Unit and route tests covering the SSO flow live next to the source:

```
web/src/lib/sso/clients.test.ts
web/src/lib/sso/service.test.ts
web/src/app/api/oauth/authorizations/route.test.ts
web/src/app/api/oauth/token/route.test.ts
web/src/app/oauth/authorize/page.test.tsx
```

Run them with:

```bash
cd web && pnpm test:run src/lib/sso src/app/api/oauth src/app/oauth
```

Always add a regression case here when you change SSO behavior.

## 7. Rollout checklist

Before flipping a new client to production:

- [ ] Decide strict vs loose `redirect_uris`. Default to strict for any externally hosted client.
- [ ] Generate a high-entropy `client_secret` (≥ 32 random bytes). Use `client_secret_hash` + `client_secret_salt` if env-at-rest is a concern.
- [ ] Share `client_id` and `client_secret` with the third-party team over a secure channel (1Password, Vault, etc.). Never paste into chat history or commit to git.
- [ ] Add the new entry to `CONDUCTOR_SSO_CLIENTS_JSON` in **all** environments where login should work (staging, prod).
- [ ] Restart the Conductor web server so the registry reloads.
- [ ] Run the staging end-to-end flow (Section 6.1) against the new client.
- [ ] In production, monitor:
  - `4xx`/`5xx` rate on `/api/oauth/token`
  - Count of newly created rows in `sso_authorization_codes` vs. rows with `consumedAt IS NULL` (expired codes)
- [ ] Document the new client (purpose, owner, redirect URIs) in your team's internal registry.

## 8. Operational notes

### Rotating a `client_secret`

1. Generate a new secret.
2. Update `CONDUCTOR_SSO_CLIENTS_JSON` in Conductor's env. Listing two entries with the same `client_id` is **not** supported — duplicates are dropped at load time. Coordinate the cutover with the third-party app.
3. Push the new secret to the third-party app's env.
4. Restart both sides.
5. Existing user sessions are unaffected because they hold long-lived `access_token`s issued previously.

If you suspect the old secret leaked, also revoke all `UserToken` rows whose `name = 'connected-app:<client_id>'` to force every user to re-authenticate.

### Removing a client

1. Delete the entry from `CONDUCTOR_SSO_CLIENTS_JSON` and restart.
2. New `/oauth/authorize` requests for that `client_id` will fail with `unknown_client` (HTTP 403 on the authorization API, page renders the error UX).
3. Existing `access_token` rows continue to work until you revoke them. Run:

   ```sql
   UPDATE user_tokens
   SET revoked_at = CURRENT_TIMESTAMP
   WHERE name = 'connected-app:<client_id>'
     AND revoked_at IS NULL;
   ```

### Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `/oauth/authorize` keeps bouncing back to `/login` | The user's `conductor.jwt` in `localStorage` is missing or expired | Sign in again. The page reads `useAuthStore`, not a cookie. |
| `unknown_client` on a freshly added client | Server has not picked up the new env | Restart `pnpm dev` / `pnpm start`. The registry caches per env-string. |
| `invalid_grant` on a valid-looking code | `redirect_uri` differs from the one used at `/oauth/authorize` by even one byte | They must be byte-identical (case, trailing slash, query). |
| `invalid_client` on a valid-looking secret | Trailing whitespace in env. JSON parsed but secret string includes a newline. | Re-quote the env value on a single line. |
| Multiple users get the same `access_token` | Looks impossible — tokens are per `(user, client_id)`. Check that the third-party app is not caching `access_token` globally instead of per session. | Audit the app's session store. |

## 9. References

- RFC: [`claw/rfc/0030-feature-sso-authorization-entrypoint.md`](../rfc/0030-feature-sso-authorization-entrypoint.md)
- Server code:
  - Client registry: `web/src/lib/sso/clients.ts`
  - Service: `web/src/lib/sso/service.ts`
  - Authorize page: `web/src/app/oauth/authorize/page.tsx`
  - Authorization API: `web/src/app/api/oauth/authorizations/route.ts`
  - Token API: `web/src/app/api/oauth/token/route.ts`
- Schema: `web/prisma/schema.prisma` → model `SsoAuthorizationCode`; migration `web/prisma/migrations/20260527120000_sso_authorization_codes/`
