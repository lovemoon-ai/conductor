# Web login state split causes Settings to misjudge not logged in

## Symptoms
- 2026-03
- 13 In the production environment, after the user completes the login and enters the `Settings` page, he may still see the prompt related to not logging in.
- At the same time, the main body of the page is not automatically redirected back to `/login`, which shows that the page has entered the application area, but some interfaces are treated as not logged in.
- The typical phenomenon is that the `Settings` page displays an abnormality in the token area or "Please log in to view connected daemons." appears in the daemon area.

## Root Cause
- The Web side maintains two sets of authentication statuses at the same time: `conductor.jwt` and `zustand persist`'s `conductor-auth` session.
- After the login page is successful, only `conductor.jwt` is written, and the `conductor-auth` session is not established simultaneously.
- When the `/app` zone is initialized, it will give priority to the old persisted session and write the old JWT back to the local storage, causing the old and new login states to overwrite each other.
- Logging out of the home page only cleans the JWT, but not the persisted session. When the user subsequently enters `/app/*`, the residual session may be allowed to pass.
- The daemon request in the `Settings` page relies on back-end authentication. When the front-end residual session is inconsistent with the real JWT, the split-brain state of "page released but interface 401" will appear.

## Fix
- Converge web login state into a single path:
  - After successful login, the session is established through the auth store.
  - `initFromStorage` always restores the session from the current `conductor.jwt` and no longer blindly trusts persisted session data.
  - When the JWT is missing or invalid, persisted session state and related local tokens are cleared together.
- When logging out on the home page, use the auth store's `logout` to ensure that JWT, persisted session, and userToken are cleared together.

## Prevention
- Any new login, logout, OAuth bounce, and automatic recovery logic must reuse the same auth store entry and cannot bypass the session establishment process.
- Make design constraints on the front-end authentication status: clarify who is the source of truth, and prohibit multiple localStorage keys from expressing the same login status in parallel.
- Supplement automated coverage for critical regression paths, including at least:
- Enter `/app/settings` after logging in
- Log out and open `/app/settings` directly
- The persisted session must not overwrite the new token when JWT is updated
