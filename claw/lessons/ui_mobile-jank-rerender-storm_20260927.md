# ui: mobile web app janky on tab switch, task list, and chat (2026-09-27)

## Symptom

- On phones, every interaction felt slow: switching bottom-nav tabs, showing the Task List, opening a task's chat.
- Stress DB (401 tasks, 600 messages), 390px viewport, 4x CPU throttle: task list ready in ~824ms; DOM held 847 `<dialog>` elements and ~23.5k nodes.
- Nav highlight painted 100–540ms after the tap (6x throttle).

## Root cause

No single bug. Several render-amplifiers stacked up:

- **Idle per-card dialogs.** Each `TaskItem` always mounted a closed `RestartTaskControls` dialog and a Share `Dialog`. They portal into `<body>`, render their children, and each registers 3 `visualViewport` listeners. So a list of N cards carried 2N hidden dialogs, and the 15s agents poll re-rendered every restart form.
- **Whole-store subscriptions.** `TaskList` and `TaskDetailPane` called `useTasksStore()` with no selector. Every WebSocket message rebuilt and re-sorted `tasks`, and `markTaskUnread` always allocated a new `Set`. Together these re-rendered the list and the whole chat for traffic on *any* task. `ChatView` selected the whole runtime object, which is rebuilt on every status frame.
- **Refetch loops.** The tasks page's filter effect depended on `currentGroupMemberIds`, an array rebuilt on every `fetchProjects()`. This defeated its own `projectScopeKey` guard, so each tab switch or WS reconnect refetched the full task list. `fetchTasks` also replaced every task object, so `React.memo(TaskItem)` never hit.
- **Per-frame work.**
  - Swipe progress re-rendered the page, the un-memoized `TaskList`, and all chat messages.
  - The chat scroll handler wrote `sessionStorage` synchronously on every scroll event.
  - `MessageInput` tore down and re-added its resize/viewport listeners and `ResizeObserver` on every keystroke.
  - `will-change` permanently promoted the full-height list/chat containers.
  - `backdrop-blur` on the fixed bottom nav and the sticky Issues header over scrolling content.
- **Nav feedback waited for the route commit.** The active tab only changed after Next.js finished navigating.

## Fix

- Mount the card dialogs only while open.
- Narrow zustand selectors in `TaskList`, `TaskDetailPane`, and `ChatView` (primitive runtime fields).
- `markTaskUnread`/`markTaskRead`/runtime `clearTask` are no-ops when nothing changes.
- The tasks-page filter effect is keyed on the scope string. `TaskList` gets a key-derived stable `projectFilter` and is `memo`ized. The detail pane passes a stable `ChatView` element.
- `fetchTasks` reuses unchanged task objects, and the unchanged array.
- Debounce the scroll-position write (flushed on unmount). Set up `MessageInput` listeners once, and re-measure per keystroke.
- Hoist markdown plugins/components to module constants.
- `will-change` only while dragging. Drop the two `backdrop-blur`s.
- `MobileNav` highlights the tapped tab immediately (optimistic, cleared on path change) and switches colors without a transition.

Measured A/B on production builds (median of 3):
- List ready: 824→523ms.
- `<dialog>`s: 847→1. DOM nodes: 23.5k→10k.
- Chat-scroll storage writes: 89→0. Per-keystroke listener re-registrations: 53→0.
- Tap-to-highlight: 537→12ms.

Rejected: `content-visibility: auto` on `.task-card`. It saved only ~110ms on load but raised scroll main-thread time ~7.5x: a relayout every frame, and a jittering scrollbar from the 96px placeholder vs the real 101px height.

## How to avoid next time

- Never mount closed dialogs per list row. Mount on open.
- Never call a zustand store hook without a selector in list- or chat-level components. Selectors should return stable references or primitives.
- Store setters must return early when state is unchanged, especially ones driven by WebSocket traffic.
- Effect dependencies must be stable values: key strings, not arrays rebuilt from refreshed data.
- Anything bound to scroll, pointermove, or keystroke must not touch storage, re-register listeners, or re-render large subtrees.
- Measure perf changes on a throttled production build before keeping them. `content-visibility` looked like a win on paper and was a regression in practice.
