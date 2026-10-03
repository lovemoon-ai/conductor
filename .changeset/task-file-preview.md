---
"@love-moon/conductor-cli": patch
---

Add `conductor task preview <id> <path>`: open a temporary link to a file on the
task's daemon (HTML with its CSS/JS/images, Markdown, images, video), the same
preview the chat opens when you click a file link in an AI reply or shows in
place for `![](picture.png)` / `![](recording.mp4)`. The link expires after
5 idle minutes (30 minutes at most) and only reaches the file's own directory.

The daemon advertises a new `remote_file_preview` capability; previews need a
daemon of this version or later. `conductor config` now writes
`remote_file: true` explicitly into a new config file (the default was already
on; set it to `false` to decline file transfers and previews).
