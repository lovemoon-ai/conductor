---
"@love-moon/conductor-cli": patch
"@love-moon/conductor-sdk": patch
---

Support `/stop` in task chats: a bare `/stop` interrupts the AI's current turn,
whatever it is doing, instead of being sent to the model. `interrupt_turn` no
longer needs a reply target; without one, fire interrupts the turn it is
running.
