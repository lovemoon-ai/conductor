# Npm Publish Visibility Retry

## Symptom

The package release workflow published `@love-moon/app-sdk@0.4.0`
successfully, but immediately marked the workflow as failed and skipped CLI
archive dispatch.

## Root Cause

After `changeset publish`, `scripts/release-packages.mjs` issued a single
exact-version request to npm to confirm publication. npm accepted the publish
and updated `latest`, but the version endpoint was briefly unavailable during
registry propagation, so the script classified an already published version
as missing.

## Fix

Post-publish confirmation now polls the exact package version for up to one
minute before failing. The initial pending-package detection remains a
single request, so only versions just submitted to npm receive eventual
consistency handling.

## Prevention

Treat external artifact registries as eventually consistent after a successful
write. Release automation should bound its confirmation retries and must not
fail downstream artifact creation on a transient read-after-write miss.
