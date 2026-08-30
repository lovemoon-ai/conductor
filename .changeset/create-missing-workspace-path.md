---
"@love-moon/conductor-cli": minor
---

Allow creating a project whose workspace path does not exist yet.

The daemon now accepts `create_if_missing` on `validate_project_path` and will
`mkdir -p` the workspace before snapshotting it, advertising the new
`project_path_create` capability. In the web Create Project dialog a missing
path no longer dead-ends: it offers "Create this directory and continue", so a
typo still fails loudly instead of silently creating the wrong folder.
`conductor project create` gains `--create-workspace` for the same behavior.
