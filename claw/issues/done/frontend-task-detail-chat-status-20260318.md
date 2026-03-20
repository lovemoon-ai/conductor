# Issue: Frontend task detail - chat/status/input polish

## Problem / Context

The current task detail chat page is already good in engineering implementation (scrolling recovery, draft saving, and session processing are all basic), but there is still some room for improvement in terms of product experience:
- The hierarchical relationship between the message area, runtime status bar, and input area can be made clearer
- "Session not ready" is still prompted via `alert()`
- There is still a lack of unified visual rhythm between the chat detail page and the new dashboard shell
This issue does not rewrite the chat model, but does a round of high-frequency experience polish.

## Goal

Improve the level of task detail chat page, status feedback and input experience to make it more consistent with the new app shell and design system.

## Acceptance Criteria

- [ ] Message area, runtime status area, and input area hierarchy are clearer
- [ ] Session not ready no longer uses native `alert()`
- [ ] Key status (running, replying, not connected, empty message) expression is more unified
- [ ] Do not revert to existing scroll recovery, draft saving, IME input logic

## Scope

- In scope
- Chat view layout level optimization
- runtime status UI optimization
- Input area visual and feedback optimization
- Replacement of existing alert
- Out of scope
- websocket protocol changes
- message schema transformation
- terminal interactive rewrite

## Plan / Tasks

- [ ] Sort out the structure of the three areas of the chat page: header / messages / composer / status
- [ ] Optimize the readability and location of runtime status
- [ ] Change not ready prompt to inline or toast feedback
- [ ] Adjust the visual rhythm and white space of MessageBubble / MessageInput
- [ ] Regression verification rolling, draft, send, running status prompt

## Risks / Dependencies

- Depend on toast / status primitives in foundation issue
- If the visual changes to the chat page are too large, it may affect the existing usage habits of high-frequency users

## Links

- RFC: `claw/rfc/frontend-design-refresh.md`
Related code:
- 
- `web/src/app/app/tasks/[taskId]/page.tsx`
  - `web/src/components/conductor/chat/ChatView.tsx`
  - `web/src/components/conductor/chat/MessageBubble.tsx`
  - `web/src/components/conductor/chat/MessageInput.tsx`
