# Codex Weekly quota used the model response bucket

## Symptom

After removing the obsolete Codex 5h bar, AI Manager still showed a Weekly percentage that disagreed with Codex's own account usage display. Accounts with a model-specific limit, such as GPT-5.3-Codex-Spark, could see that model bucket instead of their main Codex account quota.

## Root cause

The quota implementation sent a synthetic prompt to `https://chatgpt.com/backend-api/codex/responses` and inferred account quota from that response's `x-codex-*` headers. Those headers describe the limit selected for that model response; they are not the authoritative account quota interface. Relabeling the header's primary window as Weekly fixed the duration label but did not fix the data source.

Codex 0.144 exposes the authoritative, read-only `account/rateLimits/read` app-server RPC. Its top-level `rateLimits` field is the backward-compatible account bucket, while `rateLimitsByLimitId` can contain different model-specific percentages.

## Fix

- Replace the synthetic model request with `codex app-server` and `account/rateLimits/read`.
- Read only the top-level account `rateLimits` bucket for the main Weekly bar.
- Identify Weekly by its 10080-minute duration, whether it appears in `primary` on current Codex or `secondary` on older two-window responses.
- Do not label a shorter or duration-less window as Weekly.
- Store app-server results under a new cache namespace so response-header snapshots cannot survive the upgrade.

## Prevention

Use provider-owned account/status APIs for account quota. Do not derive account-wide quota from a model execution response. Protocol fixtures should include both the top-level account bucket and a conflicting model-specific bucket, and assert that the UI uses the account value.
