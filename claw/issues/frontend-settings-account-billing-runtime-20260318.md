# Issue: Frontend settings - account/billing/runtime information architecture refresh

## Problem / Context

The current Settings page already hosts API tokens, connected daemons, build info, session, etc., but there are:
- The weights between sections are too even
- Accounts, runtime, billing/subscriptions, build information, etc. mixed into one page hierarchy
- Average discoverability of major operations
The RFC requires that settings/account/billing/runtime be organized more like a product settings center than a platter of information.

## Goal

Reconstruct the information structure and hierarchy of the Settings page so that high-frequency information comes to the forefront and low-frequency diagnostic information takes a back seat.

## Acceptance Criteria

- [ ] Settings page partitions are clearer (such as Account / Runtime / Billing / Build)
- [ ] API token, daemon, subscription and other high-frequency information are easier to discover
- [ ] Build info downgraded to auxiliary level
- [ ] The page style is consistent with the new app shell, section card system

## Scope

- In scope
- Settings page partition and hierarchy reconstruction
- In-page card, button, status display optimization
- Necessary subscription/account entry adjustments
- Out of scope
- Transformation of payment process agreement
- Daemon data source transformation
- landing homepage

## Plan / Tasks

- [ ] Define the new section partition model of the Settings page
- [ ] Improve the operational discoverability of token / daemon / subscription
- [ ] Adjust the visual weight of auxiliary information such as build info, session, etc.
- [ ] Connect to unified section card / toast / confirm system
- [ ] Validate mobile and desktop layouts

## Risks / Dependencies

- Depends on basic components such as SectionCard in foundation issue
- If the subscription/invitation will continue to be split in the future, it is necessary to avoid another major change in the structure.

## Links

- RFC: `claw/rfc/0015-frontend-design-refresh.md`
Related code:
- 
- `web/src/app/app/settings/page.tsx`
