# Daemon page scroll persistence across navigation (mobile)

## Symptom
On mobile, scrolling the `/app/ai-manager?agentHost=…` (Daemon) page down to
reveal the token-balance section, navigating to Tasks/Issues/Projects via
MobileNav, and returning to the Daemon via MobileNav.Settings reset the scroll
position to the top. Two consecutive fix attempts landed before a robust one.

## Root cause
There was not a single root cause — the bug sat at the intersection of several
platform quirks that only showed up on mobile:

1. **iOS Safari viewport vs `h-screen`.** The app root uses `h-screen` (i.e.
   `100vh`), which on iOS Safari disagrees with the visual viewport as the URL
   bar shows/retracts. Under some states the *document* element becomes the
   actual scroller instead of the inner `<div overflow-y-auto>` we attached
   the `scroll` listener to. A div-only listener silently misses all scroll
   events.
2. **AI Manager content height grows across renders.** Status/quota/accounts
   each populate the store on separate fetches. A one-shot
   `useLayoutEffect` that runs on the first render will set `scrollTop = 500`
   against a container that's still only ~200px tall — the browser silently
   clamps to the current max, and the position is never re-attempted.
3. **Late scroll resets from Next.js / history.** App Router's scroll
   restoration and browser back/forward can reset scroll *after* our layout
   effect runs, overriding any earlier restore.
4. **Storage durability.** In-memory zustand state is sufficient for
   `<Link>`-driven soft navigation, but any code path that causes a harder
   remount (e.g. module re-eval, logout reset, future code paths) loses it.

## Fix
`web/src/app/app/ai-manager/page.tsx` now stacks three layers of defense:

1. **Storage — both in-memory + durable.** `sessionStorage` under
   `conductor-daemon-scroll:<host>` is the authoritative store (matches the
   already-proven chat view pattern). Zustand `scrollByHost` remains as an
   in-memory fast path; restore reads `max(storage, zustand)`.
2. **Listen + restore on both div AND window.** On save we write
   `max(div.scrollTop, window.scrollY || documentElement.scrollTop)` and
   attach `scroll` listeners to both. On restore we apply `scrollTop` to both
   the div and `window.scrollTo(...)` — whichever isn't a scroller no-ops.
3. **Three-layer restore.**
   - Synchronous `useLayoutEffect` keyed on `[agentHost, selectedHost, hostState]`
     — retries whenever the per-host store slice changes (data arriving grows
     content height).
   - `requestAnimationFrame` retry loop (~1s cap) that re-applies the saved
     position until we land within 2px of target. This overrides any late
     scroll reset from outside our layout effects.
   - `pagehide` + `visibilitychange` listeners flush the saved position before
     mobile browsers freeze the tab.

`reset()` on `useSettingsNavStore` clears the zustand slice at logout;
sessionStorage is per-tab anyway so there's no cross-account leak risk.

## Why two earlier attempts failed
- **Attempt 1:** Save & restore on div only, single-shot restore, gated on
  `hostContentReady` (a single boolean transition). Missed iOS-document-scroll
  case entirely; restore couldn't retry after the single transition.
- **Attempt 2:** Added window listeners, rAF retry-across-renders via
  `hostState` dep. Better but still leaked against Next.js-side scroll reset,
  and still trusted zustand as the sole store.

The lesson: **for scroll restoration on mobile, assume every platform
assumption will break.** Listen on both scroll containers, persist to
durable storage, retry on an rAF loop after paint, and derive the target from
a store slice that re-fires on content-growth events.

## How to avoid next time
- When persisting scroll across navigation, default to the ChatView pattern:
  `sessionStorage` + `useLayoutEffect` keyed on a changing content signal +
  `clampScrollTop` + rAF-based retry.
- Never assume your styled `overflow-y-auto` element is the sole scroller on
  mobile — always also read/write `document.documentElement.scrollTop` /
  `window.scrollTo`.
- Save listeners go on *both* the inner container and `window`; the browser
  only fires `scroll` on the element that actually moved.
- Add `pagehide` + `visibilitychange` save handlers to survive mobile
  tab-switch freezes that skip the `scroll` event flush.
