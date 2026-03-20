# misc: Feishu Group Chat @ Robot text leaked to official news review (2026-03-17)

## Symptoms
- After the user `@bot 1+1=` in the Feishu group chat, the official user message entering the task still retains the `@bot` or Feishu placeholder (such as `@_user_1`).
- As a result, the prompt words received by the AI ​​are contaminated, which affects the reading experience and may also affect model understanding.

## Root Cause
- Feishu's inbound message standardization only performs the shallowest `message.content` analysis and does not clean mention nodes.
- Mention placeholders (such as `@_user_1`) in text messages and `at` nodes in rich text `post` messages are not processed uniformly.
- `mentionsBot` is only used to mark "whether @ the robot", but is not synchronized to "remove mention from the official text".
## Fix
- Expanded Feishu message standardization logic and is compatible with both `text` and `post` message formats.
- Unified stripping of `message.mentions[].key`, `@_user_n` placeholders and rich text `at` nodes.
- Keep the `mentionsBot` mark, and only write the cleaned user's real text to the task.
- Supplementary testing, covering two scenarios of text messaging and rich text group chat @bot.

## Prevention
- When connecting to the IM platform, "display text" and "purified text submitted to the model" should be regarded as two different levels, and structured cleaning is performed first by default.
- For high-frequency collaboration scenarios such as group chats, rich text, mentions, threads, etc., real platform samples must be used for supplementary testing, not just plain text samples.
- Any issues with "platform placeholders entering model input" should be resolved at the adapter layer first, rather than being left to the upper-layer business logic.