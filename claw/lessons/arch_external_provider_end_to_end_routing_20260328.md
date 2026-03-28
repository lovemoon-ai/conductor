# External provider end-to-end routing bug

## Symptom
- External AI SDK backends could be created in some flows but then disappeared in others.
- Daemon, `conductor fire`, manual `--resume`, and web restart/new-task flows did not agree on which backends were actually supported.
- Users could create an external-backend task and then immediately lose restart or resume paths for that task.

## Root cause
- Built-in backend assumptions were still duplicated across CLI, daemon, fire resume logic, and the web restart flow.
- External backend discovery, alias normalization, and validation were only partially centralized.
- Restart and resume code paths were still validating against hardcoded built-in backend lists instead of runtime-discovered backends.

## Fix
- Centralize runtime external backend discovery and validation in the CLI runtime backend catalog.
- Make fire resume resolve external backends through runtime discovery, provider descriptors, conductor session records, and cwd fallback.
- Let daemon-hosted external backends advertise and launch without requiring a built-in CLI command mapping.
- Update web restart compatibility rules so same-backend external tasks remain restartable when the daemon advertises support.
- Add regression tests across CLI, daemon, fire resume, API restart routing, and restart UI.

## How to avoid next time
- When adding a new backend class, map every lifecycle path up front: create, advertise, restart, resume, reconnect, and UI affordances.
- Keep backend normalization and support checks in one shared layer instead of re-encoding them per surface.
- For backend features, require cross-surface regression coverage before merge, not only creation-path coverage.
