# Git remote host alias blocks cross-daemon project merge

## Symptom

Two online `robotcloud` projects with the same project name and different
daemon hosts did not merge into one project card. Both rows had
`mergeOptOut=false`, but one daemon reported the remote as
`github-duinodu/lovemoon-ai/robotcloud` while the other reported
`github.com/lovemoon-ai/robotcloud`.

## Root cause

Project grouping compares `gitRemoteUrl` after basic trim/lowercase
normalization. The SDK normalizes SSH scp-style remotes such as
`github-duinodu:lovemoon-ai/robotcloud.git` into
`github-duinodu/lovemoon-ai/robotcloud`, but the web grouping layer did not
know that `github-duinodu` is a local SSH config alias for `github.com`.

That made two remotes for the same GitHub repository look like different
upstreams, so the safety guard correctly refused to merge them.

## Fix

- Canonicalize the `github-duinodu` host alias to `github.com` in the web
  project-group comparison, while preserving the owner/repo path.
- Canonicalize the same alias in the SDK remote URL normalizer so future daemon
  snapshots write the stable `github.com/...` form.
- Add tests that confirm `github-duinodu/lovemoon-ai/robotcloud` matches
  `github.com/lovemoon-ai/robotcloud`, while
  `github-duinodu/duinodu/robotcloud` still does not match
  `github.com/lovemoon-ai/robotcloud`.

## How to avoid next time

When merge or identity logic depends on normalized external identifiers, keep
the canonicalization rules in both the data producer and the data consumer. For
git remotes, host aliases should be resolved before comparison, but only at the
host boundary; owner/repo paths must remain strict to avoid merging unrelated
repositories.

---

## Follow-up (2026-07-07): the hardcoded alias allowlist did not scale

### Recurrence

The exact same symptom came back for the **M2 daemon**. Two projects on the
`m2` host would not merge with their same-name siblings:

- `robotcloud`: `m2` stored `github-dang217/lovemoon-ai/robotcloud`, while `m1`
  stored `github-duinodu/...` and `windows` stored `github.com/...`.
- `operator`: `m2` stored `github.com/lovemoon-ai/operator`, while `4090`/`m1`
  stored `github-dang217/lovemoon-ai/operator`.

The M2 machine uses a **new** SSH config alias `github-dang217` (a second
GitHub account). The 2026-07-01 fix only hardcoded `github-duinodu`, so
`github-dang217` fell through and blocked the merge again.

### Real root cause

The original "resolve only known aliases at the host boundary" principle was
wrong: it required editing code for every new SSH alias any user ever adds.
GitHub identifies a repository purely by its `owner/repo` path; the local SSH
alias prefix carries no identity at all.

### Corrected fix

Generalize `canonicalGitRemoteHost` in both the SDK
(`modules/conductor-sdk/src/context/project_context.ts`) and the web grouping
layer (`web/src/lib/projects/grouping.ts`): collapse **any** GitHub alias
(`github.com`, `github-*`, `github.com-*`) to `github.com`, then compare by
`owner/repo`. Non-GitHub hosts (gitlab.com, self-hosted, GitHub Enterprise like
`github.mycompany.com`) are left untouched so unrelated repos never merge. The
web change re-normalizes stored values at read time, so existing rows merge on
deploy without a DB backfill.

Note: `operator` also needs `mergeOptOut` cleared on the `4090`/`m1` rows — that
is an independent, user-set flag, not part of this bug.

### How to avoid next time

Prefer a **rule** over an **allowlist** when canonicalizing external identifiers.
If you find yourself adding another literal value to a hardcoded map to fix "the
same bug for a new input", the real fix is to encode the underlying rule (here:
"all GitHub SSH aliases are github.com; identity is owner/repo") so the next new
input is handled automatically.
