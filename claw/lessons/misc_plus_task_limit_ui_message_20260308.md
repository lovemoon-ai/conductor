# misc: Plus task limits were relaxed, but the frontend still shows Free-tier copy (2026-03-08)

## Symptoms
- The backend has expanded the task upper limit logic to differentiate by package: 1 per bucket for Free, 10 per bucket for Plus.
- But when the user creates a task on the web and triggers 403, the pop-up text is still fixed as:
- `Free can have at most 1 active app task`
- or `Free can have at most 1 active fire task`
- The result on the user side is:
- Plus users will see an incorrect Free prompt when they reach the 10 limit
- The package capabilities are inconsistent with the interface prompts, and it is easy to misjudge that the permissions are not effective.

## Root Cause
- `CreateTaskDialog` only determines the app/fire bucket based on `limit_type`, and the package name and quota are hard-coded as Free/1.
- Although the backend has returned the new `message`, the frontend does not use the returned content to distinguish Free from Plus.

## Fix
- The frontend is changed to combine the quota message returned by the backend to infer the current package, and generate corresponding Chinese prompts according to Free/1, Plus/10.
- Added `CreateTaskDialog` test to cover Free limit prompt and Plus limit prompt respectively.
- Local Chrome MCP actual measurement:
- Free user's second active app task is correctly intercepted
- Plus user's 11th active app task displays `Plus can have at most 10 active app tasks`

## Prevention
- For rules such as quotas, packages, and permissions that are jointly maintained by the front and backends, the front-end prompt copy should not hard-code constants and should prioritize consuming the structured information returned by the back-end.
- When the backend rules are expanded to multiple packages, all UI error prompts, empty state instructions and test fixtures must be checked simultaneously to see if they are still in the single package era.
- In addition to interface testing, this type of change also requires at least one real page interaction regression to avoid "correct interface, error prompt".
