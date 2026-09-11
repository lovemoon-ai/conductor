#!/usr/bin/env node

// Fake Kimi Code CLI that stays busy: emits stream-json activity every
// ~150ms for ~1.5s before exiting 0. Used to prove that the print session
// turn deadline is activity-based (idle timeout), not a hard wall clock.

const LINES = 10;
const INTERVAL_MS = 150;
let sent = 0;

const timer = setInterval(() => {
  sent += 1;
  process.stdout.write(
    `${JSON.stringify({
      role: "assistant",
      content: `heartbeat ${sent}/${LINES}\n`,
    })}\n`,
  );
  process.stderr.write(`heartbeat tick ${sent}\n`);
  if (sent >= LINES) {
    clearInterval(timer);
    process.exit(0);
  }
}, INTERVAL_MS);
