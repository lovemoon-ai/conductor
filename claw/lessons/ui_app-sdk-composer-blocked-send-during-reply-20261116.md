# app-sdk composer blocked sending while a reply was in progress

## Symptom
Apps embedding `<ChatView />` (e.g. robot-rsi) could not send a follow-up while the agent was replying: the send button was replaced by the interrupt button, so the only way to send was to stop the current turn first. The main Conductor app lets users keep sending and queues the messages.

## Root cause
`MessageInput` rendered either the interrupt button or the send button (`canInterrupt ? interrupt : send`). The server already queues user messages sent mid-turn; only the widget prevented it.

## Fix
Render the send button unconditionally (enabled whenever there is text) and show the interrupt button beside it while a reply is in progress. Esc-to-interrupt and the bubble-menu interrupt are unchanged. Test: `keeps send available while a reply is in progress so messages queue`.

## How to avoid
When porting a main-app interaction into the SDK widget, mirror its behavior, not just its controls: check what the main composer allows in each runtime state (idle, replying, interrupting) and add a widget test per state.
