# Symptom

- `make debug-cli` could fail to load external AI SDK providers when `AISDK_PROVIDER_PATH` contained multiple module paths separated by commas.
- On macOS and Linux, the whole comma-joined string was treated as one module path, so backend discovery and AI session creation both failed to load the external provider modules.

# Root Cause

- The provider path parsing logic only split `AISDK_PROVIDER_PATH` by the platform path delimiter.
- That works for `:`-delimited values on Unix-like systems, but not for the comma-delimited values some local configs and shells were already using.
- The CLI backend discovery path and the ai-sdk external provider registry each had the same assumption, so the bug appeared in both code paths.

# Fix

- Added shared parsing behavior in both the CLI and ai-sdk code paths to detect comma-delimited provider module lists.
- Kept the normal platform-delimiter parsing as the default, and only fall back to comma splitting when the input looks like a list of module paths.
- Added regression tests in the CLI and ai-sdk test suites to verify comma-delimited `AISDK_PROVIDER_PATH` values load external providers correctly.

# How To Avoid Next Time

- Treat environment variable parsing as an input-compatibility surface, especially for developer-facing configuration.
- When the same env var is consumed in multiple layers, keep their parsing rules aligned and add regression coverage in both places.
- Add tests for the configuration formats already used in local setup docs, shell exports, and debug workflows before changing loader logic.
