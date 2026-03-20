# Goal

Implement "automatically set the system not to sleep when running daemon or fire on macOS"
## Inputs
1. Start the server locally: cd web && unset http_proxy && unset_https_proxy && unset_all_proxy && npm install && npm run dev
2. Local test method: Use chrome-devtools mcp to open http://localhost:6152/, use `env:CONDUCTOR_PHONE` to complete the login
3. Start conductor-daemon locally: conductor-daemon --config-file ~/.conductor/config-dev.yaml
## Non-goals
1. Do not modify user system-level permanent power settings
2. Does not cover Linux/Windows power policy
3. Do not implement complex GUI prompt pages in this issue
## Steps
1. Codemap understands the current code and only looks at the daemon/fire process life cycle and platform branch logic
2. macOS solution selection:
   - Start the `caffeinate` subprocess when daemon or fire is running.
   - Clean up `caffeinate` when the process exits
3. Implement guard logic:
   - Only Darwin enabled
   - Avoid repeatedly pulling up multiple caffeinates
   - Recover everything when exiting abnormally
4. Test:
   - Single test or integration test covers startup/exit behavior
   - Manual verification of `pmset -g assertions` visible assertion during run
## Rules
1. Enable anti-sleep only when daemon or fire is detected to be active
2. When testing locally, turn off all proxies and then test: unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy
3. It must be ensured that no anti-sleep assertions are left after the process exits.
## Implementation points
1. Recommended package `sleep_guard.ts`, unified management of caffeinate life cycle
2. Use the `-i -s` parameter to cover idle and system sleep
3. Add logs to facilitate troubleshooting of "not valid/not released" issues
## Acceptance criteria
1. The system does not automatically sleep when daemon/fire is running on macOS
2. Prevent hibernation from being automatically released after daemon/fire exits
3. Non-macOS environments are not affected
## Risks and rollback
1. Risk: caffeinate may be left behind when exiting abnormally
2. Rollback: turn off the sleep guard switch and terminate the daemon child process with one click
## Done
Local testing to realize the function of "automatically setting the system not to sleep when running daemon or fire on macOS"
Do not stop until the done condition is satisfied.