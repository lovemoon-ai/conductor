---
"@love-moon/conductor-cli": minor
---

Add `conductor remote cp` for copying a single file to or from another daemon's
host, and fold the existing `remote-exec` command into a `conductor remote`
umbrella alongside it.

- `conductor remote exec ...` replaces `conductor remote-exec ...`. Behaviour is
  unchanged; only the command path moved.
- `conductor remote cp <src> <dst>` follows scp: exactly one side is written as
  `<daemon>:<path>`, and that decides the direction. Contents are verified end
  to end with SHA-256 and written via a temporary file plus rename, so an
  interrupted copy never truncates an existing file.
- `conductor remote cp -r` copies a directory, matching scp's destination
  rules. It packs with `tar`, moves the one tarball through the ordinary
  transfer and unpacks on the other side, so permissions and symlinks survive
  and the wire protocol is unchanged. Needs `tar` and `remote_exec` on the
  target; the limit applies to the compressed size.
- New `remote_file` daemon capability, declinable with `remote_file: false` in
  the config or `CONDUCTOR_REMOTE_FILE=0`, kept separate from `remote_exec` so
  version skew fails with a clean 409 instead of a timeout.
- Transfers are chunked at 32 MiB with `Content-Range` and resume automatically
  after a network blip, from the server's offset going up and from the local
  partial file coming down. Chunking is also what keeps the server safe at the
  raised limit: no single request is large or long-lived.
- The per-file limit is now 1 GiB, bounded by a global staged-bytes budget
  (8 GiB), a per-user budget (2 GiB), a free-disk floor, and reservation by
  declared size at creation.
- Bytes travel over HTTP through the backend rather than the agent WebSocket.
  The socket only carries a small control message. See RFC 0037.

Deploying this needs the updated `web/nginx_conf`: the file-transfer routes set
`client_max_body_size` to 64m — a per-chunk cap, not a per-file one — and turn
off `proxy_request_buffering`.
