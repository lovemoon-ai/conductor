# ui: merged project defaults to an offline daemon, hiding the AI picker

## Symptom
`humanoid-deploy` exists on two daemons (ubuntu, apex) and shows as one merged
project. With ubuntu offline and apex online (advertising `kimi`), Create New
Task showed "apex" in Device but no AI backend dropdown — only the
"does not advertise any AI backends" warning — so no task could be started.

## Root cause
For a merged group the dialog kept the group's primary member (ubuntu) as the
target project whenever it was a member at all, online or not. The Device
dropdown lists only online members, so the browser displayed apex while the
form state still pointed at ubuntu: no daemon → no backends. Re-picking apex
fired no change event because it already looked selected.

## Fix
`CreateTaskDialog`: a merged group only keeps the requested member if its
daemon is online; otherwise it defaults to the first online member.

## Avoid next time
A `<select>` whose `value` matches none of its options silently displays the
first option. Derive the default from the same list the dropdown renders.
