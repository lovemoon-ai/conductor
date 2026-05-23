# QA — Issue daemon UI restricted to multi-daemon contexts

Topic: behavior shipped in commit `6eaf618` (merged into main as `344f405`).

Three product rules to satisfy:

1. **Single-daemon non-merge project** (or merged group / default project with
   only one daemon online) → no daemon UI anywhere on the issue.
2. **Multi-daemon context (todo)** → issue card hides the daemon attribution
   (it "may run on any daemon" until committed).
3. **Multi-daemon context (todo → doing)** → popup shows the daemon picker;
   after pick, the issue card shows a daemon chip.

## Chrome E2E

Environment: dev server on `:6152` running the merged code, two real daemons
online (`debug`, `qa-daemon-2`), three projects:

- `Default Project` (no daemonHost, but 2 non-fire daemons online) → multi-daemon
- `conductor` on `debug` + `conductor` on `qa-daemon-2` (same name, same git
  remote) → cross-daemon merged group

### Rule ② — Merged project (`conductor`)

| Screenshot | What it proves |
| --- | --- |
| `02-board-todo-no-daemon-doing-has-chip.png` | Same board, two columns: todo card `picker-demo` carries **no** daemon text; doing card `1+1=` shows the emerald `debug` chip. |
| `01-merged-doing-chip.png` | Close-up of the doing card chip: `title="debug"`, palette `bg-emerald-500/15 text-emerald-700 …`. |
| `03-picker-dialog-multi-daemon.png` | `Move Issue To Doing` dialog. Daemon dropdown lists `debug` (default, matches issue's current project) and `qa-daemon-2`. Backend dropdown shows debug's supported set (`codex, claude, kimi, copilot, web-chatgpt, web-gemini`). Switching the daemon to `qa-daemon-2` (verified in-session) re-filters the backend list to `codex, claude, kimi, copilot, aiden, mira` — `web-*` drop, `aiden`/`mira` appear. |

Server-side: `issue.metadata.daemonHost` is set to whatever the resolver
actually picked (the dialog's choice when the project is unbound; the
project's bound daemon otherwise) — verified via `/api/issues` response
`{"backendType":"codex","daemonHost":"debug"}`.

### Rule ② — Default Project (multi-daemon default)

- New issue `default-project-multi-daemon-test`: todo card has no daemon text.
- Move to doing → picker lists both daemons.
- Picking `debug` lands the spawn on `debug` (verified through
  `task.metadata.daemonName === "debug"` and `issue.metadata.daemonHost ===
  "debug"`). The default project is **not** re-parented (projectId stays
  `92d3c4e8-…`) — only the spawn target is set by the picker.

### Rule ① — Single-daemon scenario

The destructive option (disconnect `qa-daemon-2`) was not exercised in
Chrome to avoid interrupting the user's session. The unit tests guard the
case:

- `web/src/features/issues/components/IssueCard.test.tsx`
  - `hides the chip on a single-daemon project even after the issue has moved to doing`
  - `hides the chip on a todo issue even when the project is multi-daemon`
- `web/src/features/issues/components/MoveIssueToDoingDialog.test.tsx`
  - `hides the daemon picker when only one daemon is available so the dialog stays focused on backend selection`

`cd web && pnpm test` → 1036/1036 passing on the merge commit.

## Outcome

All three rules pass. Ship.
