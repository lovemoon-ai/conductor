# Issue Card Owner Badge Always Rendered "Unassigned"

## Symptom

On any shared issue board (collaboration project), every issue card's owner
avatar rendered the placeholder `UN` glyph with `aria-label="Issue owner
Unassigned"` and `title="Unassigned"`, regardless of which member created
the issue or which member it was reassigned to. A's issues and B's issues
both showed the same `UN` badge for both viewers.

The product spec is: the badge shows the **last two digits** of the owner's
phone number (e.g. `25` for `+86 18707151525`, `26` for `+86 18707151526`)
for phone-based accounts, or the first two letters of an email's local
part for email-based accounts.

The bug was visible to every user on every collaboration board, on every
reload, and not gated by feature flag.

## Root Cause

`normalizeIssue` in `web/src/features/issues/store.ts` was missing four
fields when shaping API responses into the in-memory `Issue` model:

- `ownerUserId`
- `creatorUserId`
- `owner` (`{ id, label }`)
- `creator` (`{ id, label }`)

The API at `GET /api/issues` (and the PATCH / POST companions) returns all
four. The `Issue` TypeScript interface in `web/src/shared/types/index.ts`
declares all four as valid fields. But the normalizer simply did not copy
them, so the store always held `ownerUserId === undefined` and
`owner === undefined` for every issue, regardless of the wire payload.

Downstream, `IssueOwnerBadge` in
`web/src/features/issues/components/IssueCard.tsx` falls back through:

```ts
const owner = ownerOptions.find((option) => option.userId === issue.ownerUserId) ?? null;
const ownerLabel = owner?.label ?? issue.owner?.label ?? issue.ownerUserId ?? 'Unassigned';
```

With `ownerUserId` and `owner` both `undefined`, every branch except the
final `'Unassigned'` literal was nullish, producing the `UN` initials via
`getOwnerInitials('Unassigned')`.

Why the bug only showed up on the issue board (and not the create/details
dialog): the create + reassign flows speak directly to the API and use
`issue.ownerUserId` from the *immediate* response — at the moment the
operation succeeds. But the issue *list* the board renders comes from the
zustand store, which had to go through `normalizeIssue` and lose the
owner data on the way in.

## Fix

`web/src/features/issues/store.ts`:
- Add a `normalizeMemberRef` helper that accepts an API-shaped
  `{ id, label }` object and returns the same shape (with an optional
  label) or `null` if `id` is missing.
- In `normalizeIssue`, pick `ownerUserId` / `creatorUserId` from either
  camelCase or snake_case spellings (`record.owner_user_id`,
  `record.creator_user_id`) and copy them into the returned `Issue`.
- Likewise normalize `record.owner` and `record.creator` and include them
  in the returned `Issue`.

No card or component change needed — the card already had the correct
fallback logic; it just never saw the data.

## How to Avoid This Next Time

- **Treat shared types as the contract, not the implementation.** When
  `web/src/shared/types/index.ts` declares a field on an entity (in
  particular optional-but-meaningful fields like `owner`, `creator`,
  `ownerUserId`), every normalizer / serializer between the API and the
  store must explicitly carry that field. A field declared on the type but
  not copied by the normalizer is silently `undefined` at runtime, which
  is much harder to spot than a type error.
- **Cross-check the API response with the store before debugging
  components.** This bug looked like a card render bug, but the card was
  blameless — the data was already stripped one layer up. Whenever a card
  shows an "empty" fallback while the API clearly carries the data, check
  the store's normalize function before opening DevTools on the
  component.
- **Add a normalizer-level test that asserts owner/creator fields
  round-trip.** A single fixture-based unit test in `store.test.ts` that
  feeds a representative API payload through `normalizeIssue` and asserts
  the owner/creator fields are preserved would have caught this at
  build/PR time. The QA round caught it only because the bug was visible
  enough to notice in a UI screenshot.

## Discovery

Found in QA Round 2 (2026-05-12) for the Project Collaboration feature.
Catalogued as `BUG-PCOLLAB-002` in
`claw/issues/tmp_project-collaboration-20260512/tmp_test_report_round_2.md`.

API showed `owner: {id, label: "+8618707151525"}`, card showed `UN`. The
gap between the two pointed straight at the normalizer.
