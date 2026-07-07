---
"@love-moon/conductor-sdk": patch
---

Canonicalize every GitHub SSH host alias (`github.com`, `github-*`,
`github.com-*`) to `github.com` when normalizing git remote URLs. GitHub
identifies a repository solely by its `owner/repo` path, so the same repo cloned
through different SSH aliases (e.g. `github-dang217` vs `github-duinodu`) now
merges across daemons by owner/repo instead of being blocked by a hardcoded
per-alias allowlist. Non-GitHub hosts (gitlab.com, self-hosted, GitHub
Enterprise) are left untouched so unrelated repos never merge.
