# ui: task move menu shows the move-back entry as "← 移回conductor" in an otherwise English UI

- Date: 2026-09-13 (QA round for the v0.12.0..2970043 release delta; feature F5 `80ab13e` "allow moving any task to any project")
- Severity: P2 (minor, cosmetic) — the entry works and names the home project as specified
- Layer: web UI (task card move-to-project popover)

## Symptom
Desktop 1440×900, English locale. Reveal the task card action strip (drag the card right) on a task that is filed into another project, click the folder icon ("Move task back to its own project"). The popover lists the projects in English (`Default Project`, `tmp-qa-c5-project (qa-dev-daemon)`, …, current one greyed with ✓) but the first entry reads **`← 移回conductor`** (Chinese "移回" = move back) — the only non-English string on the page.

## Expected
The entry should follow the UI language, e.g. `← Move back to conductor` (the strip button's own tooltip already says "Move back").

## Reproduction
1. Move any task to another project via the card strip (this works and is verified in the same round).
2. Reveal the strip again → click the folder icon → observe the first popover entry.

## Evidence
`claw/issues/tmp_release-qa-20260913/tmp_evidence/c4-move-back-menu.png` (+ `.console.log` / `.network.log`); DOM dump in the QA report, case C4.

## Suspected component
Task card move popover label for the "move back" entry (`web/src/components/...` task list / task card), hard-coded Chinese string.
