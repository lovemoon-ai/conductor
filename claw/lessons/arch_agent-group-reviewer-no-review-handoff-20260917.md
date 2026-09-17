# Agent group reviewer starts too early and never hears the worker is done

## Symptom

In a feature-dev + reviewer task group, the reviewer started working as soon as
the group was created: it explored the code, sent an early "heads-up" and set up
a background poller before the worker had written any code. When the worker
finished, it only reported to the user; the user had to tell the reviewer
"那边开发完了，你评审吧" by hand. After the worker fixed the review findings,
nobody asked for a re-review.

## Root cause

The agent docs had no handoff protocol. `claw/agents/code-reviewer.md` told the
reviewer to self-schedule periodic reviews from its first turn, and
`claw/agents/feature-dev.md` said "you do not need to seek the reviewer out", so
there was no worker → reviewer channel at all. Conductor's group bootstrap also
hard-coded reviewer-only text ("set your own review cadence…").

## Fix

The protocol now lives in the agent docs. Conductor's bootstrap
(`buildAgentBootstrap`) is now identical for every role: who you are, your doc,
and that `conductor task group` lists your group.

- `code-reviewer.md`: no schedule, no polling. Before a `[review-request]`,
  reply with one line and end the turn. On each request, review the shared
  working directory against `claw/sop/04_review-code.md` and send exactly one
  `[review:<agent>] approved | changes requested` reply to the worker.
- `feature-dev.md`: once the work is complete and verified, run
  `conductor task group` and send each reviewer a `[review-request]` that
  includes the reply command. Re-request only from reviewers that asked for
  changes, and stop when all approve or after 3 rounds.
- The live group paired `feature-dev` with the plain `review` SOP, which has no
  protocol and still reviews on its first turn; its registry description now
  says it is standalone and group use should pick `code-reviewer`.

A first attempt put this protocol into Conductor's group bootstrap
(`buildAgentBootstrap`). That was rejected: it couples agent business rules to
the router, so every new agent type would need a Conductor change.

## Prevention

Every multi-agent design needs an explicit trigger for each hop ("who wakes
whom, and on what event"), not just a discovery mechanism. Keep that protocol
in the agent docs; Conductor only provides generic primitives
(`conductor task group|send`).
