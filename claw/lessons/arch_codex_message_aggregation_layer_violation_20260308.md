# arch: Codex message aggregation falls into layered violation review at the fire layer (2026-03-08)

## Symptoms
- After the `ai-sdk` / `fire` reconstruction has been clearly layered, the message aggregation of Codex `app-server` is still temporarily placed in the `fire` layer.
- This can indeed prevent the front-end from being flushed by streaming chunks in the short term, but it will immediately introduce new structural risks:
- `fire` can only do rough aggregation according to `replyTo` or turn level
- `fire` cannot see the real boundary of the assistant message inside the Codex
- If Codex produces multiple assistant replies in the same turn, they will be aggregated into one message by mistake.
- This problem is not a deviation in implementation details, but a deviation from the core architectural constraints of this reconstruction:
- provider semantics should converge at `ai-sdk`
- `fire` can only consume the unified interface and should not understand the provider-specific message boundaries.
## Root Cause
- At that time, in order to first stop the symptom of "too many front-end messages", we chose the minimal change path:
- Do not change the `ai-sdk` external incident protocol first
- Add buffer directly before `fire`'s `session stream -> sendMessage`
- The problem with this path is that it puts "tactical hemostasis" directly into the main architecture path, resulting in the re-coupling of the two layers of responsibilities:
- `fire` starts to recognize `source=codex-app-server`
- `fire` began to assume the message segmentation that should belong to the Codex provider
- The root cause is not that "I don't know how to do it right", but that on the premise of knowing the correct layering, I still give priority to the implementation method that requires the least changes, and do not keep the previously defined interface boundaries.

## Fix
- Put the aggregation logic of Codex assistant message back into the Codex provider of `ai-sdk`.
- The provider is based on structured events such as `itemId`, `item/started`, `item/completed`, etc., and outputs a complete assistant message with well-defined boundaries.
- `fire` only retains two types of responsibilities:
- Forward the complete message sent by the provider to the conductor server
- Handle control plane logic such as runtime status, ack, reconnection, idempotence, etc.
- For Codex, `fire` is no longer allowed to rely on `source=codex-app-server`, `messageId`, and session file details to decide how to split the message.

## Prevention
- Once the module boundary has been clarified in the RFC or design draft, subsequent implementation must first determine whether it has crossed the boundary even if it is "temporary hemostasis"; repairs that cross the boundary cannot directly enter the main implementation.
- For this kind of "seemingly just aggregation" question, you must first ask clearly which layer of semantics it belongs to:
- `chunk -> complete provider message` belongs to provider
- `message -> server delivery` belongs to controller / fire
- If a temporary deviation must be made, it must be explicitly marked as a short-term fallback, with a recovery plan and test constraints attached in the same round, and cannot be silently solidified into the main link.
- For all subsequent `ai-sdk`-related changes, one issue should be checked first:
- Does this logic let `fire` know the internal semantics of the provider?
- If the answer is "yes", the default should be to fall back to the provider's internal implementation.