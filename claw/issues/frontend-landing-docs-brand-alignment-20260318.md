# Issue: Frontend landing & docs - brand alignment

## Problem / Context

The current styles of landing, app, and docs are not uniform enough:
- landing assumes too much post-login content
- docs basically uses Nextra's default style packaging
- The overall brand experience is fragmented
RFC clearly requires that when you are not logged in to the homepage, you can return to the brand description + CTA responsibilities, and the docs must also be visually unified with the app.

## Goal

Complete the brand alignment of landing and docs, and refocus the homepage responsibilities to the non-login experience.

## Acceptance Criteria

- [ ] If you are not logged in, the homepage only retains the brand, value proposition, main CTA, and lightweight function display.
- [ ] Logged-in users no longer stay on the hybrid homepage when visiting `/`
- [ ] The fonts, spacing, color swatches, and code block styles of docs are consistent with those of the main product
- [ ] landing hero has a clearer Conductor brand expression

## Scope

- In scope
- Split the homepage information architecture
- Landing hero / section structure reconstruction
- docs packaging layer and visual style are unified
- Out of scope
- docs content rewritten
- auth protocol transformation
- In-app task flow transformation

## Plan / Tasks

- [ ] Sort out the content that must be retained and must be moved out of the unlogged homepage
- [ ] Design landing hero, value props, CTA structure
- [ ] Determine the root routing policy after login (jump `/app/tasks` or `/app/dashboard`)
- [ ] Adjust docs wrapper, layout, code blocks, navigation visual style
- [ ] Verify the brand consistency of landing / docs / app

## Risks / Dependencies

- Rely on the token / typography solution in the foundation issue
- If the redirection strategy after login on the homepage is not determined first, the landing transformation will be adjusted repeatedly.
- docs When using Nextra, style customization boundaries need to be verified in advance

## Links

- RFC: `claw/rfc/0015-frontend-design-refresh.md`
Related code:
- 
- `web/src/app/page.tsx`
  - `web/src/app/docs/layout.tsx`
  - `web/src/app/docs/[[...mdxPath]]/page.tsx`
  - `web/src/mdx-components.tsx`
