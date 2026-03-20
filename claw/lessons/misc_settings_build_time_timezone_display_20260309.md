# misc: The Settings page Build Time does not display the review according to Beijing time (2026-03-09)

## Symptoms
- When the user views `Build Info` on the web settings page, `Build Time` directly displays the ISO time string written during the build.
- This string defaults to UTC semantics, and when users view it in the Chinese time zone, it will be 8 hours less than Beijing time.
- The result on the user side is:
- The build time you see is inconsistent with the actual release time
- When checking whether the online version has been updated, it is easy to misjudge the deployment time

## Root Cause
- `web/src/app/app/settings/page.tsx` directly renders the original value of `NEXT_PUBLIC_BUILD_TIME` without time zone formatting.
- The injection side of the build uses `new Date().toISOString()`, which is a reasonable standardized storage format, but the display layer does not convert the time zone as agreed by the user.

## Fix
- Add `formatBuildTimeInBeijing()` to the settings page, format `NEXT_PUBLIC_BUILD_TIME` as `Asia/Shanghai` and display them uniformly.
- The display results are changed to Beijing time format, and `GMT+8` is explicitly appended.
- Keep exception details:
- `unknown` continues to show `unknown`
- Illegal time strings continue to fall back and display the original value.

## Prevention
- When displaying time fields to users, do not directly render ISO original values; make it clear that "storage format" and "display time zone" are two-tiered responsibilities.
- For fields such as deployment information, log time, and billing time that are prone to misjudgment, the time zone should be clearly displayed when the requirements are implemented.
- For meta-information display on pages such as Settings / Diagnostics, a time zone display checklist should be added to avoid the recurrence of "data is correct, time zone is displayed incorrectly".