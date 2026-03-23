# Issue: PTY task re-entry history replay causes terminal jank

## Problem / Context

When a user re-enters a `pty_task`, the terminal may become very slow if there is a lot of prior terminal output.

Current behavior is:
- `TerminalView` reads the browser-side output snapshot and sends `terminal_attach` with `last_seq`, see [web/src/components/conductor/terminal/TerminalView.tsx](/Users/duino/ws/conductor/web/src/components/conductor/terminal/TerminalView.tsx#L191)
- app gateway forwards that `last_seq` to the daemon unchanged, see [web/src/lib/realtime/app-gateway.ts](/Users/duino/ws/conductor/web/src/lib/realtime/app-gateway.ts#L322)
- daemon replays every buffered `terminal_output` chunk with `seq > last_seq`, see [cli/src/daemon.js](/Users/duino/ws/conductor/cli/src/daemon.js#L2286)
- browser appends each replayed chunk into xterm with `terminal.write(...)`, see [web/src/components/conductor/terminal/TerminalView.tsx](/Users/duino/ws/conductor/web/src/components/conductor/terminal/TerminalView.tsx#L373)

This is acceptable for same-tab remount/reconnect when the browser still holds a recent local snapshot. It is not acceptable for fresh re-entry after page reload, new tab, browser memory release, or a later reopen.

Important detail: the daemon is not replaying the full terminal history. It is replaying the buffered tail, but that tail is still large enough to cause visible jank because both browser and daemon buffers allow up to `2MB`, see [web/src/lib/conductor/stores/terminal.ts](/Users/duino/ws/conductor/web/src/lib/conductor/stores/terminal.ts#L107) and [cli/src/daemon.js](/Users/duino/ws/conductor/cli/src/daemon.js#L140).

## Root Cause

The slowdown comes from three design choices working together:

1. Resume cursor is only stored in browser memory
- Browser output history lives in `terminalOutputSnapshots`, an in-memory map, see [web/src/lib/conductor/stores/terminal.ts](/Users/duino/ws/conductor/web/src/lib/conductor/stores/terminal.ts#L111)
- On fresh re-entry, that snapshot is gone, so `last_seq` falls back to `0`, see [web/src/components/conductor/terminal/TerminalView.tsx](/Users/duino/ws/conductor/web/src/components/conductor/terminal/TerminalView.tsx#L200)

2. Fresh attach degenerates into full tail replay
- When `last_seq=0`, daemon loops the whole `ringBuffer` and emits each chunk one by one, see [cli/src/daemon.js](/Users/duino/ws/conductor/cli/src/daemon.js#L2286)
- This turns re-entry into an O(buffer size) websocket replay

3. UI resume path reuses live-stream rendering
- The replayed chunks are rendered through repeated `terminal.write(...)`, see [web/src/components/conductor/terminal/TerminalView.tsx](/Users/duino/ws/conductor/web/src/components/conductor/terminal/TerminalView.tsx#L381)
- For large ANSI-heavy output, this is expensive on the main thread and produces visible freezing

The core mismatch is:
- transport replay wants correctness for transient reconnect
- UI re-entry wants a small, fast resume snapshot

Right now both use the same `ringBuffer` mechanism.

## Goal

Make PTY re-entry fast without losing live terminal continuity.

Specifically:
- same-session reconnect should still support incremental replay by `last_seq`
- fresh re-entry should first prefer browser-side persisted resume snapshot
- fresh re-entry should not replay the whole buffered tail chunk-by-chunk
- user should still see a recent terminal context instead of a blank terminal

## Acceptance Criteria

- [ ] Browser can keep a fixed-length PTY resume snapshot per `taskId` across page remount and page reload
- [ ] Re-entering a PTY without a local browser snapshot does not trigger chunk-by-chunk replay of the full daemon ring buffer
- [ ] Fresh attach initial paint is bounded by a dedicated resume snapshot limit, not by the `2MB` relay buffer limit
- [ ] Same-session reconnect with a valid `last_seq` still replays only the missing incremental output
- [ ] Attach / live output / resize / detach / exit behavior has no regression
- [ ] Recent terminal context is still visible on fresh re-entry, but explicitly truncated to a smaller bounded tail

## Proposed Solution

Separate `transport replay` from `UI resume snapshot`.

### Phase 1: Persist a bounded browser-side resume snapshot

Browser already keeps an in-memory tail buffer in `terminalOutputSnapshots`, but that state is lost on page reload / new tab / later reopen, see [web/src/lib/conductor/stores/terminal.ts](/Users/duino/ws/conductor/web/src/lib/conductor/stores/terminal.ts#L111).

Add a second, smaller persisted snapshot layer for PTY re-entry:
- key by `taskId`
- persist `lastSeq`, bounded `data`, `updatedAt`, `truncated`
- persist only a much smaller tail than the current `2MB` in-memory relay buffer

Recommended limits:
- `64KB` to `256KB`, or
- last `200-500` lines after ANSI-preserving trim

Recommended storage choice:
- `sessionStorage` is the simplest option if we only want same-browser-session persistence
- `IndexedDB` is safer if snapshot size may exceed `sessionStorage` comfort and if we want better control over eviction
- `localStorage` is less suitable because writes are synchronous on the main thread

UI behavior:
- if in-memory snapshot exists: keep current fast path
- else if persisted browser snapshot exists: render it once, set `renderedSeq`/`last_seq`, then attach incrementally
- only if both are missing, fall back to daemon-side snapshot path

This solves the common case where the user refreshes the page or reopens the task shortly after.

### Phase 2: Add a dedicated resume snapshot path for fresh re-entry fallback

When the browser has no local snapshot:
- keep sending `terminal_attach`
- but do not treat `last_seq=0` as a request to replay the whole ring buffer chunk-by-chunk
- daemon should instead return a single bounded `terminal_snapshot` payload for initial paint

Suggested payload:

```ts
{
  type: "terminal_snapshot",
  payload: {
    task_id: string,
    pty_session_id: string,
    last_seq: number,
    data: string,
    truncated: boolean,
  }
}
```

Recommended limits:
- keep current relay ring buffer for transient reconnect correctness
- add a much smaller resume snapshot limit for fresh attach, e.g. `64KB` to `256KB` or last `200-500` lines

UI behavior:
- if local snapshot exists: keep current `last_seq` incremental attach path
- if no browser snapshot exists: render `terminal_snapshot.data` once, set `renderedSeq` to `terminal_snapshot.last_seq`, then continue with live `terminal_output`

### Phase 3: Keep live replay logic only for real incremental catch-up

Daemon attach logic should branch:
- `last_seq > 0`: keep replaying only missing output after `last_seq`
- `last_seq === 0`: send one bounded snapshot instead of replaying all buffered chunks

This keeps reconnect correctness while removing the expensive cold-start replay path.

### Phase 4: Optional follow-up

If fresh re-entry still needs stronger continuity:
- persist a compact resume snapshot per PTY session on the daemon or server side
- do not persist the full raw stream
- store only a bounded tail suitable for initial paint

## Scope

- In scope
- PTY attach protocol and daemon attach behavior
- Browser terminal initial render behavior on fresh entry
- Browser persisted resume snapshot
- New bounded resume snapshot size/line policy

- Out of scope
- Full terminal history persistence
- Searchable terminal history
- Replacing xterm or redesigning PTY transport end to end

## Plan / Tasks

- [ ] Add browser-side persisted PTY resume snapshot keyed by `taskId`
- [ ] Define bounded snapshot trim policy for persisted browser snapshot
- [ ] Add a fresh-attach code path that distinguishes `in-memory snapshot`, `persisted snapshot`, and `no snapshot`
- [ ] Introduce a bounded `terminal_snapshot` event for PTY initial paint fallback
- [ ] Add daemon-side snapshot generation from the current ring buffer tail
- [ ] Keep `terminal_output` replay only for `last_seq > 0`
- [ ] Update `TerminalView` to hydrate from `terminal_snapshot` before consuming live output
- [ ] Add tests for:
  - same-tab remount with local snapshot
  - page reload / fresh reopen with persisted browser snapshot
  - fresh re-entry without local snapshot
  - large buffered output does not produce chunk replay storm

## Risks / Dependencies

- Persisted browser snapshot needs explicit eviction policy to avoid unlimited per-task growth
- If we persist raw ANSI text, we should verify that truncation does not produce obviously broken terminal state too often
- Need to avoid race conditions between initial snapshot and live output delivery
- Need a clear ordering rule so `terminal_snapshot.last_seq` and subsequent `terminal_output.seq` do not double-render or drop output
- Snapshot truncation should be explicit in UI or diagnostics so users know they are seeing recent tail only

## Links

- [web/src/components/conductor/terminal/TerminalView.tsx](/Users/duino/ws/conductor/web/src/components/conductor/terminal/TerminalView.tsx#L191)
- [web/src/components/conductor/terminal/TerminalView.tsx](/Users/duino/ws/conductor/web/src/components/conductor/terminal/TerminalView.tsx#L373)
- [web/src/lib/conductor/stores/terminal.ts](/Users/duino/ws/conductor/web/src/lib/conductor/stores/terminal.ts#L107)
- [web/src/lib/conductor/stores/terminal.ts](/Users/duino/ws/conductor/web/src/lib/conductor/stores/terminal.ts#L283)
- [web/src/lib/realtime/app-gateway.ts](/Users/duino/ws/conductor/web/src/lib/realtime/app-gateway.ts#L322)
- [cli/src/daemon.js](/Users/duino/ws/conductor/cli/src/daemon.js#L2286)
- [web/src/components/conductor/terminal/TerminalView.test.tsx](/Users/duino/ws/conductor/web/src/components/conductor/terminal/TerminalView.test.tsx#L170)
