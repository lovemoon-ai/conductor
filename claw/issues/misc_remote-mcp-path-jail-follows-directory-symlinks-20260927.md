# `conductor remote mcp`: path jail follows directory symlinks inside `--root`

- Severity: P2 (minor)
- Found: 2026-09-27, release QA for the version after v0.14.0 (build `e6f0dca`)
- Component: CLI `conductor remote mcp` (RFC 0040), `remote_read` / `remote_write` / `remote_edit`
- Status: open

## Symptom

RFC 0040 says the target directory is fixed at start-up and any path outside the bound
root is rejected. The check is lexical: `/etc/hosts` and `../../../etc/passwd` are
refused, but a path that goes **through a directory symlink inside the root** is
accepted and reads or writes outside it.

## Reproduction (two daemons on one account, local web)

```sh
# on the target daemon (qa-dev-daemon-b)
ln -s /etc               /tmp/tmp_qa_workspace_b/gb0927/etclink
ln -s /tmp/tmp_qa_outside /tmp/tmp_qa_workspace_b/gb0927/outlink
conductor remote mcp --host qa-dev-daemon-b --root /tmp/tmp_qa_workspace_b/gb0927
```

| call | observed | expected |
|---|---|---|
| `remote_read {file_path:"/etc/hosts"}` | rejected: outside the remote workspace | same |
| `remote_read {file_path:"etclink/hosts"}` | **returns `/etc/hosts`** | rejected |
| `remote_write {file_path:"outlink/escaped.txt"}` | **creates `/tmp/tmp_qa_outside/escaped.txt`** | rejected |
| `remote_write` / `remote_edit` on a *file* symlink | rejected ("is a symlink … edit the target instead") | same |

## Impact

- Low. This is not a security boundary: `remote_bash` runs arbitrary commands under
  the same account, and cross-account access is still refused. The jail exists to stop
  the AI from accidentally touching files outside the worktree.
- A realistic trigger: remote-worktree setup symlinks shared directories (the
  `.conductor/settings.yaml` `symlink:` list) into the worktree. An edit through one of
  them lands in the base checkout, even though the tool reports a path inside the root.

## Suggested fix

Resolve the real path on the target (`realpath -m` of the parent directory) and compare
that against the root's realpath before reading or writing. Alternatively, document
that directory symlinks are followed on purpose.

## Evidence

`claw/issues/tmp_release-qa-20260927/tmp_evidence/C7_remote_mcp_symlink.log`,
`C7_remote_mcp_dirsymlink_write.log` (local-only).
