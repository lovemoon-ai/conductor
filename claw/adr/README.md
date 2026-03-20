# ADR Guide

ADRs capture accepted architecture decisions after discussion converges.

Use an ADR when:

- an RFC has been accepted and the final decision should be recorded
- a smaller architecture decision does not need a full RFC but should remain
  discoverable

File naming:

- `ADR-0001-short-title.md`
- increment the number sequentially

Start from `claw/adr/template.md`.

Recommended flow:

1. Record context, decision, and consequences.
2. Link the related RFC or PR when one exists.
3. Mark old ADRs as superseded instead of rewriting history.
