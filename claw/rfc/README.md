# RFC Guide

RFCs are for large, cross-cutting, or workflow-shaping changes.

Use an RFC when:

- more than one package is affected
- architecture or protocol changes are involved
- the impact should last beyond one sprint
- the development process itself is changing

File naming:

- prefer `RFC-0001-short-title.md` for new RFCs
- existing historical descriptive names can remain as-is

Start from `claw/rfc/template.md`.

Recommended flow:

1. Draft the RFC before implementation starts.
2. Link the discussion from the related Linear project or issue.
3. Mark the RFC as accepted, rejected, or superseded once the decision is clear.
4. Create or update an ADR if the RFC becomes a lasting architecture decision.
