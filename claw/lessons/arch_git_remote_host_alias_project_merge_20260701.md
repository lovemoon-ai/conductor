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
