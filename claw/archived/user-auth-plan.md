# Conductor User Auth Plan

## 1. Requirements understanding
- Introducing an account system for Conductor, supporting registration/login with mobile phone number or email address.
- After logging in, users can create their own API token and generate a configuration file in `~/.conductor/config.yaml` format for download.
- The CLI tool accesses the backend through the token in the configuration file, and can only see the user's own sessions and messages.
- Both App and backend homepage require registration/login; users who are not logged in cannot use App.
- After logging in, the App can only obtain its own session and communicate with its own conductor-daemon/fire/chrome.

## 2. Overview of current situation
- Backend's existing Project/Task/Message has no user concept; API and WS are not authenticated.
- SDK/CLI has included `Authorization: Bearer <token>` in HTTP/WS requests, and the configuration file field is `agent_token`.
- The HTTP client of the App will come with a bearer token, but currently the token only comes from env and there is no login persistence.

## 3. Design goals
- Add user boundaries to Project/Task/Message to prevent cross-user access.
- Introducing user authentication and long-term API tokens.
- Compatible with the `agent_token` field of existing SDK/CLI, reducing user upgrade costs.

## 4. Data model changes
- `UserEntity`
  - `id` UUID
  - `email` (nullable, unique)
  - `phone` (nullable, unique)
  - `passwordHash`, `passwordSalt`
  - `createdAt`, `updatedAt`
- `UserTokenEntity`
  - `id` UUID
  - `userId` (FK)
  - `name` (optional)
  - `tokenHash`, `tokenSalt`, `tokenPrefix`
  - `lastUsedAt`, `createdAt`, `revokedAt`
- `ProjectEntity` adds `userId` foreign key
  - Task/Message is associated to the user through Project

## 5. Authentication and Authentication
- Login token(JWT)
  - For App/Web login sessions.
  - The backend verifies the JWT and injects `userId` into the request.
- API token (random long token)
  - Generated after login, used for CLI/SDK.
  - The server stores hash+salt and does not save plain text.
  - Obtain `userId` after passing the verification.
- Authentication strategy
  - `/auth/register`, `/auth/login`, `/` (homepage) does not require authentication.
  - Other APIs/WS must be authenticated.

## 6. API Planning
- `POST /auth/register`
  - body: `{ email?, phone?, password }`
- `POST /auth/login`
  - body: `{ emailOrPhone, password }`
  - response: `{ token, user }` (token is JWT)
- `GET /auth/me`
  - response: currently logged in user
- `POST /auth/tokens`
  - Create API token, return `{ token, name, created_at }`
- `GET /auth/tokens`
  - list (returns only prefix/created_at)
- `DELETE /auth/tokens/:id`
  - revoke token
- `GET /auth/config`
  - Generate and download config.yaml
  - content:
    ```yaml
    agent_token: "<api_token>"
    backend_url: "http://localhost:6152"
    websocket_url: "ws://localhost:6152/ws/agent"
    log_level: info
    ```

## 7. WS authentication and routing
- App WS (`/ws/app`)
  - The browser cannot set header, use `?token=<jwt|api_token>`.
  - Verify token when establishing connection and record `userId`.
- Agent WS (`/ws/agent`)
  - Keep using `Authorization: Bearer <token>`.
  - Verify token and record `userId`.
- `RealtimeHub` adds `userId` dimension to ensure messages are only routed within the same user scope.

## 8. Business logic adjustment
- Project/Task/Message query and creation need to add `userId` filter.
- `TaskService.findOrCreateProject` requires userId as parameter.
- Set `userId` when automatically creating a project.

## 9. Homepage and App UI
- Homepage: Add a new registration/login form, and display token management + config download after logging in.
- App: Add a new login/registration page, save the token (persistence) and unlock the function after success.
- App's API/WS uses login token.

## 10. Testing recommendations (TDD)
- Backend: User registration/login/token generation API spec.
- Backend: User A cannot access user B's projects/tasks/messages.
- Realtime: WS broadcasts only to the same user.
- App: Login status access control and token come with logic.
- SDK/CLI: token headers can still be covered by existing tests.

## 11. Questions that require confirmation
- Is the token allowed to be valid for a long time, or does it require an expiration policy?
  - Confirmed: There is no expiration policy for API tokens.
-Do database changes require migration?
  - Confirmed: Currently using SQLite, migration still needs to be used to update the table structure.
- How to constrain App login policy?
  - Confirmed: Only mobile phone number/email no password login is supported, password login is not supported yet.
