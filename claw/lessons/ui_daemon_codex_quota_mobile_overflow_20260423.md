# Symptom

- On the daemon settings page, the Codex section of the Quota card did not
  adapt to narrow viewports.
- On mobile, a Codex account card with a long email (e.g.
  `longish.name+tag@subdomain.example.com`) overflowed both the viewport edge
  and the rounded card border — horizontal content bled outside the outer
  `SectionCard`.

# Root Cause

- The account card rendered the email inside a flex row
  (`<div class="flex items-center gap-2">`) as `<span class="truncate">`,
  but did not set `min-w-0` on the truncate span or the inner flex wrapper.
- Flex items default to `min-width: auto`, which resolves to the child's
  intrinsic content width. With `truncate` applying `white-space: nowrap`,
  a long email became one unbreakable line that forced the flex row wider
  than its parent — propagating overflow up through the column, the grid
  cell, and eventually the `SectionCard`.
- The same `min-width: auto` behavior applies to CSS Grid tracks, so the
  Quota card's `grid` items (which collapse to a single column below the
  `md` breakpoint) also needed `min-w-0` to prevent child width from
  expanding the column.
- `QuotaBar`'s right-hand label (`剩 X% · reset MM-DD HH:MM`) had the same
  latent issue for very narrow viewports.

# Fix

- `CodexAccountSwitcher.tsx`: added `min-w-0` to the email truncate span
  and its inner flex wrapper; added `shrink-0` to the plan badge and the
  `Use / Active` button so only the email (the unbounded content) shrinks.
  The outer text column now also carries `flex-1` for explicit horizontal
  budget sharing with the button.
- `AiManagerPanel.tsx`: added `min-w-0` to the Codex grid-item wrapper so
  the grid cell can shrink below its content's intrinsic width on mobile.
- `QuotaBar.tsx`: added `gap-2` to the header row, `shrink-0` to the left
  label, and `min-w-0 truncate text-right` to the right "remaining + reset"
  label — so it clips gracefully instead of pushing the row wide.

# How To Avoid Next Time

- Whenever a flex (or grid) container holds a `truncate` text child, set
  `min-w-0` on that child. `truncate` alone is insufficient inside a flex
  parent because `min-width: auto` defeats the overflow constraint.
- Pair `min-w-0` with `shrink-0` on any sibling that should stay intact
  (badges, buttons, fixed icons). This makes the shrink allocation
  explicit and deterministic.
- For responsive layouts using `md:grid-cols-N` that collapse to a single
  column on mobile, still apply `min-w-0` to every grid cell that can hold
  wide content — grid items have the same `min-width: auto` trap as flex
  items, and it surfaces only at the narrowest viewport width.
- Sanity-check new mobile UI with a visibly long value (long email, long
  account name) before marking UI work done; trivial viewport resize at
  375 px during review would have caught this.
