# Web OAuth bounce authentication establishment pollutes the global login state

## Symptoms
- When the user has logged in to account A and switches to account B through the homepage OAuth bounce or login with mobile phone number, if subsequent requests during the session establishment process fail briefly, the page may enter a mixed account state.
- Specifically, the session in the front-end store is still account A or empty, but the global JWT, attachment authentication cookie, and subsequent API requests have been switched to account B.
- The home page will also directly use the old session from rehydrate to send user mode requests before the authentication verification is completed, causing the first screen to send the wrong request.
- When OAuth bootstrap encounters a non
- `Unauthorized` transient failure, the homepage will stop in a state that looks like you are not logged in, without a clear prompt or recovery path.
## Root Cause
- `buildSession` wrote the new JWT into global storage before the session was actually established successfully.
- The global API client reads the JWT in `localStorage` instead of the current session of the auth store, so once it is placed in advance, it will affect the request identity of the entire page.
- After the homepage was changed to directly read the persisted session, it started to send user-mode requests such as token, subscription, and invite without waiting for `initFromStorage` to converge.
- The OAuth bounce link only handles the final state for `Unauthorized`. For other errors, it neither exits nor completes bootstrap, causing the page to be stuck in a half-state.

## Fix
- `buildSession` changed to use the temporary API client with explicit JWT binding to establish the session. Only after `/auth/me` and user token are successful, they will be written to the global storage.
- Add `isAuthReady` and OAuth bootstrap state machines to the homepage, and do not release any requests that rely on the login state before the authentication verification is completed.
- OAuth bootstrap adds automatic retry and explicit failure prompts for non
- `Unauthorized` errors, and retains the manual retry entry.
- Supplementary regression testing, covering:
- Existing JWT must not be overwritten when session establishment fails
- User mode requests must not be sent before homepage authentication converges
- OAuth bootstrap should automatically retry when it fails transiently and provide manual retry

## Prevention
- All authentication establishment processes must adhere to the principle of "verify first, submit later", and it is prohibited to modify the global authentication source before the transaction is completed.
- Any front-end page that uses persisted auth state must complete recovery verification before allowing requests that rely on login state.
- The main paths of OAuth callback, login, logout, and cross-tab synchronization must have page-level automated tests, especially covering the failure and retry branches.