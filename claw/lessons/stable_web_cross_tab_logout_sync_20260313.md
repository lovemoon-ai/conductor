# Web multi-tab page logout and login are not synchronized

## Symptoms
- 2026-03
- 13 After the user logs out of one browser tab, the other tab that is still at `/app/*` will not log out immediately.
- The current tab page still appears to remain logged in, and it is not possible to return to the login page until the page is refreshed or subsequent requests fail.
- This will make users mistakenly think that the current tab is still valid, causing inconsistent login status.

## Root Cause
- Authentication recovery for the `/app` zone is only performed once when the page is mounted `initFromStorage`.
- Although the authentication data in `localStorage` will be cleared when logging out, other tabs do not monitor `storage` events related to authentication.
- Therefore, the memory state `session` in other tabs will continue to be retained, and the logout action of external tabs cannot be detected in time.

## Fix
- Added `useAuthStorageSync` to monitor the `storage` event of `localStorage` key related to authentication in the `/app` layout layer.
- When other tabs modify `conductor.jwt` or `conductor-auth`, the current tab re-executes `initFromStorage`.
- If it is detected that the JWT has been cleared, the current tab page will clear the memory session synchronously and use the existing logic to jump back to `/login`.

## Prevention
- All authentication statuses that rely on `localStorage` should specify whether they need to be synchronized across tabs, and by default will evaluate `storage` events or `BroadcastChannel`.
- For three types of state transitions: login, logout, and token invalidation, regression testing covering multi-tab scenarios is supplemented.
- When designing the front-end authentication scheme, in addition to state consistency within a single page, cross-tab consistency should also be used as a default acceptance item.