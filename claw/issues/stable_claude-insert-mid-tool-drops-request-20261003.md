# Claude: inserting a message mid-tool posts "处理失败" and the AI drops the original request

- Severity: P2 (pre-existing on 0.16.0; reproduces more consistently on 0.16.1)
- Layer: execution
- Found by: release QA 0.16.1, build `922b773`. A/B against system conductor 0.16.0 on the same dev server.

## Reproduction
1. Claude task: send "Run this Bash command in the foreground: python3 -c 'import time; time.sleep(40)' ; then reply exactly: X-DONE".
2. About 12 s later, while the command runs: `conductor task insert <id> "Also add the word MANGO at the end of your final reply."`

## Expected
The extra instruction is folded into the turn and the original work still finishes, ending with "X-DONE … MANGO". No error is shown to the user.

## Observed
- Both versions post a chat reply `claude 处理失败: Claude query ended without a result message` as soon as the insert interrupts the turn.
- After that, Claude treats the interrupted tool call as "rejected at the permission prompt", says it will not claim X-DONE, and only appends MANGO. The user has to resend the request.
- Results:
  - 0.16.1 (live Claude process): dropped in 5 of 5 runs, 4 of them on fresh tasks.
  - 0.16.0: dropped in 2 of 4 runs; it re-ran the command in the other two.
- Once (0.16.1), Claude described the inserted text as "arrived inside an automated background-task notification" and refused to act on it as untrusted.

## Evidence
`claw/issues/tmp_release-qa-0161-20261003/tmp_ins_{new,old}{1..5}.txt` (local, untracked)

## Note for the fixer
This is a user-facing bug, so add a lesson under `claw/lessons/` with the fix.
