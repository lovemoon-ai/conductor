---
"@love-moon/conductor-cli": patch
"@love-moon/conductor-sdk": patch
---

Support `/stop` in task chats. A bare `/stop` message, sent from the web, the
CLI or a channel, makes the server interrupt the AI's running turn right away
instead of waiting for fire to read the message once that turn ends. When fire
does read the queued `/stop`, it posts a confirmation and does not send it to
the model. `/stop` only interrupts the running turn: messages already queued
before it still run first. The server targets the reply it knows is running, so
older fires stop it too; `interrupt_turn` no longer needs a reply target, and
without one fire interrupts the turn it is running, including the initial
prompt and pre_prompt turns. In the web chat, the ⋯ menu gains `/stop`,
`/clear` and `/compact`, which send those commands as messages, and Interrupt
(Esc) sends `/stop`, ignored while an earlier `/stop` is unanswered. The Interrupt action is gone from the message toolbar.
