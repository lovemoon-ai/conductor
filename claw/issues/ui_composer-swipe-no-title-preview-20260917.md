# ui: swiping the mobile composer switches tasks but shows no title preview while dragging

- Date: 2026-09-17 (QA round for the v0.13.0..278f970 release delta; feature F6 `ef7d5d0` "switch tasks by swiping the mobile composer")
- Severity: P2 (minor, cosmetic). The switch itself works in both directions and drafts are kept.
- Layer: web UI (mobile task detail gesture feedback)

## Symptom
The commit promises that swiping the composer switches tasks "like the header title … with the same title preview and content follow while dragging".

Measured at 390×844 with touch (CDP touch events, dragged 150 px, held mid-drag):

| gesture | header while dragging | content pane | on release |
|---|---|---|---|
| drag the header title left | current title shifted `translateX(-28px)` at opacity 0.64; the next task's title (`e2e heartbeat check 2`) previewed underneath | `translateX(-14px)` | switched to the next task |
| drag the composer left | only the current title, no transform, opacity 1, **no preview** | `translateX(-14px)` | switched to the next task |
| drag the composer right | same: no preview | `translateX(14px)` | switched to the previous task |

The UI-1 agent reproduced this 4/4 and the lead reproduced it 2/2 on a different project.

## Expected
Dragging the composer shows the same header title preview (next or previous task name sliding in) as dragging the title.

## Reproduction
1. Mobile viewport (~390 px), a project with at least 2 tasks; open one.
2. Touch inside the message input and drag about 150 px left without lifting.
3. Look at the header: the title does not move and no next-task title appears. Release and it still switches.

## Evidence
`claw/issues/tmp_release-qa-20260917/tmp_evidence/`:
- `c12-lead-p1-title-drag-left.png` vs `c12-lead-p3-composer-drag-left.png` (lead)
- `c12-p1-title-drag-left-header-crop.png` vs `c12-p3-composer-drag-left-header-crop.png` (UI-1 agent)
- all with `.console.log` / `.network.log` (0 console errors)

## Suspected component
`TaskDetailPane` composer swipe binding: it reuses the title swipe's release callbacks but not its drag-progress/preview state for the header title layer.

## Note for the fixer
This is a user-visible product bug. Per `CLAUDE.md`, add a lesson under `claw/lessons/` with the fix.
