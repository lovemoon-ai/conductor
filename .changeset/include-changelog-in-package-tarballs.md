---
"@love-moon/conductor-cli": patch
"@love-moon/conductor-sdk": patch
"@love-moon/ai-sdk": patch
"@love-moon/ai-manager": patch
---

Include `CHANGELOG.md` in published npm tarballs.

The `files` array in each package's `package.json` previously only
listed the build output (`bin`/`src` for the CLI, `dist` for the
modules). npm's `files` whitelist replaces the default include set,
and CHANGELOG is not one of the auto-included files (only
`package.json`, `README*`, `LICENSE*`, and `main` are unconditional).

As a result, every release through 0.3.0 published tarballs with no
CHANGELOG, so a consumer running `npm install` or unpacking the brew
artifact had no way to see what changed in the version they just
installed. The repo `cli/CHANGELOG.md` and the GitHub Release body
remain the canonical source until 0.3.1 ships with this fix.
