# Backend alias runtime discovery coupling bug

## Symptom
- Configured backend aliases behaved differently across `conductor fire`, daemon startup, resume, restart, and web restart UI.
- Built-in aliases like `codex-gamma` could be blocked by unrelated external provider discovery failures.
- Configured external aliases could leak their raw runtime backend, causing routing to bypass alias-bound flags and profiles.
- Daemon and fire could disagree about which backends were actually launchable, especially when provider discovery failed.

## Root cause
- Backend support checks mixed together three different concepts: configured alias name, canonical runtime backend, and provider discovery status.
- Some paths normalized backend names before trying command-based inference, so broken external provider catalog loads could short-circuit built-in alias flows.
- Capability advertisement started from raw configured backends and only partially refined them later, which let failure cases fail open.
- Restart compatibility initially inferred backend families from string prefixes instead of using an explicit alias-to-runtime mapping from daemon.

## Fix
- Make configured backend resolution infer runtime backends from the launch command before consulting external provider discovery.
- Centralize advertised backend computation so daemon and fire share the same filtered, shadowed, canonical backend view.
- Fail closed on daemon startup when backend discovery cannot produce a safe advertised set.
- Publish daemon runtime backend maps and use them in web restart compatibility checks instead of prefix heuristics.
- Add regression coverage for alias resume, alias restart, wrapped commands, discovery failures, shadowed external backends, and `--list-backends` failure reporting.

## How to avoid next time
- Treat alias name, runtime backend, and launch command as separate fields in every backend lifecycle API.
- Make command-based inference the first-class path for configured aliases; external provider catalog lookup should be a fallback, not a prerequisite.
- For backend discovery failures, prefer fail-closed advertising and explicit error surfacing over best-effort defaults.
- Require end-to-end tests for create, advertise, resume, restart, and list/diagnostics flows whenever backend routing logic changes.
