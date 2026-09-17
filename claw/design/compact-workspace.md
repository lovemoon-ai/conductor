# Compact project workspace

## Theme
A quiet, dense project workspace for sustained technical conversations. Existing issue board and task graph retain their roles.

## Palette
Use existing paper, panel, ink, muted and orange accent tokens in both themes. Selected tasks use the existing accent surface.

## Typography
Reading text defaults to 14px on desktop and 16px on mobile, with a 1.5 line height. The reading menu changes body text, Markdown, code, tables and composer together (12–22px). Mobile input stays at least 16px. Browser zoom remains supported.

## Components
Small role avatars replace message labels. Message timestamps are omitted. Actions remain available on demand. Synthetic session activity stays collapsed. Task title and status always remain visible; optional metadata columns are configurable.

## Layout
The same resizable task pane becomes a compact list or an aligned table as space permits. Full-screen conversation hides navigation and the list without remounting the detail, composer or terminal. Body and composer use the available width.

## Depth
Flat rows and fine separators; only temporary settings popovers use shadows.

## Do / don't
Preserve project filters, selected task, drafts, scrolling, task groups, pinning, terminal and message actions. Do not reconnect a session merely to change its layout. Escape closes a settings popover before leaving full screen.

## Responsive
Mobile uses list → full-page conversation with no desktop columns. Desktop column choices do not hide mobile metadata. Reading size and desktop columns are device-local preferences; no schema or API changes are required.

## Future changes
Extend the existing task rows and Markdown surface. Avoid separate desktop/mobile data models, repeated sender labels or timestamps, and fixed narrow chat widths.
