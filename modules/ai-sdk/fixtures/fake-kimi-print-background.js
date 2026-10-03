#!/usr/bin/env node

// Fake Kimi Code CLI (`kimi -p`, default background mode "steer") whose main
// agent launches a background subagent and ends its turn: the process then
// stays silent until the subagent's completion wakes the main agent, which
// replies and exits. Stream shape copied from kimi 0.41.0.

const SILENCE_MS = Number(process.env.FAKE_KIMI_BACKGROUND_SILENCE_MS || 1200);
const write = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`);

write({ role: "meta", type: "system.version", version: "0.41.0" });
write({
  role: "assistant",
  tool_calls: [
    {
      type: "function",
      id: "tool_bg_1",
      function: { name: "Agent", arguments: JSON.stringify({ description: "Run work.py", run_in_background: true }) },
    },
  ],
});
write({
  role: "tool",
  tool_call_id: "tool_bg_1",
  content:
    "task_id: agent-dkkzbo2u\nstatus: running\nagent_id: agent-0\nactual_subagent_type: coder\nautomatic_notification: true\n\ndescription: Run work.py",
});
write({ role: "assistant", content: "LAUNCHED" });

setTimeout(() => {
  write({ role: "assistant", content: "BACKGROUND_DONE SUBAGENT_FINISHED" });
  write({ role: "meta", type: "session.resume_hint", session_id: "session_bg_1" });
  process.exit(0);
}, SILENCE_MS);
