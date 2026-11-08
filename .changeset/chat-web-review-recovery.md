---
"@love-moon/chat-web": patch
"@love-moon/ai-sdk": patch
---

Show daemon-host inspection and acknowledgement commands on uncertain chat-web
errors and REVIEW_REQUIRED, including interrupted sends and timeouts. Keep
acknowledgement explicit: it does not replay a request, and the user sends the
next message after checking the provider conversation. The web error message
contains the commands; acknowledgement currently runs through the host CLI.

Compact streamed event history into full text snapshots instead of failing
after 2000 events. Sequence numbers remain monotonic across compaction and
restart; replay cursors may cross gaps and recover through a message_snapshot.
The one-million-character text limit remains enforced.

Return CHAT_CLOSED when closing a chat races a headed resume. Strip CONDUCTOR_*
identity variables from detached runtime and browser-worker environments while
preserving browser and proxy configuration.

Upgrade note: an already-running shared runtime continues executing its old
code. After active chats finish, run `conductor chat-web runtime stop` and retry
to launch the updated runtime. Older runtimes lacking required capabilities
report RUNTIME_UPGRADE_REQUIRED; unused managed runtimes exit after ten minutes
without requests or pinned login windows. No running chat is stopped
automatically during upgrade.
