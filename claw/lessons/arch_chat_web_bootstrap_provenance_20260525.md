# Chat Web Bootstrap Provenance Override

## Symptom

The initial publication of `@love-moon/chat-web@0.3.2` failed locally with:

```text
Automatic provenance generation not supported for provider: null
```

## Root Cause

`modules/chat-web/package.json` enables provenance for normal GitHub Actions
releases through `publishConfig.provenance`. The bootstrap instructions tried
to disable it through `NPM_CONFIG_PROVENANCE=false`, but npm applies package
publish configuration during `npm publish`; that environment setting did not
override the package value.

## Fix

Use `npm publish --provenance=false` only for the first local package
publication. npm prioritizes the explicit CLI flag over `publishConfig`, while
subsequent CI releases retain provenance through GitHub OIDC.

## Prevention

When a package requires one manual bootstrap before trusted publishing exists,
dry-run the exact bootstrap command with the package's final publish metadata
and document any one-time CLI override explicitly.
