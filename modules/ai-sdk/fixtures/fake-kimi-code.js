#!/usr/bin/env node

function readFlagValue(argv, name, fallback = "") {
  const longEquals = `${name}=`;
  for (let index = 0; index < argv.length; index += 1) {
    const value = String(argv[index] || "");
    if (value.startsWith(longEquals)) {
      return value.slice(longEquals.length) || fallback;
    }
    if (value === name) {
      return String(argv[index + 1] || fallback);
    }
  }
  return fallback;
}

const argv = process.argv.slice(2);

if (argv.includes("--help")) {
  process.stdout.write(`Usage: kimi [options]\n\n`);
  process.stdout.write(`  -S, --session [id]          Resume a session.\n`);
  process.stdout.write(`  -p, --prompt <prompt>       Run one prompt non-interactively.\n`);
  process.stdout.write(`  --output-format <format>    text or stream-json.\n`);
  process.exit(0);
}

const forbiddenFlags = ["--wire", "--work-dir", "--print", "--input-format", "--yolo"];
for (const flag of forbiddenFlags) {
  if (argv.some((value) => value === flag || value.startsWith(`${flag}=`))) {
    process.stderr.write(`error: unknown option '${flag}'\n`);
    process.exit(2);
  }
}

const prompt = readFlagValue(argv, "--prompt");
const outputFormat = readFlagValue(argv, "--output-format");
const requestedSessionId = readFlagValue(argv, "--session");
if (!prompt) {
  process.stderr.write("error: required option '--prompt <prompt>' not specified\n");
  process.exit(2);
}
if (outputFormat !== "stream-json") {
  process.stderr.write("error: --output-format stream-json is required\n");
  process.exit(2);
}
if (requestedSessionId && requestedSessionId !== "ses_kimi_code_026") {
  process.stderr.write(`Session \"${requestedSessionId}\" not found.\n`);
  process.exit(1);
}

if (prompt.includes("[slow]")) {
  const keepAlive = setInterval(() => {}, 1_000);
  process.once("SIGINT", () => {
    clearInterval(keepAlive);
    process.exit(130);
  });
  await new Promise(() => {});
}

const responseText = requestedSessionId
  ? "turn 2 from fake Kimi Code\n"
  : "OK from fake Kimi Code\n";

process.stdout.write(
  `${JSON.stringify({
    role: "assistant",
    content: responseText,
  })}\n`,
);
process.stdout.write(
  `${JSON.stringify({
    role: "meta",
    type: "session.resume_hint",
    session_id: "ses_kimi_code_026",
    command: "kimi -r ses_kimi_code_026",
    content: "To resume this session: kimi -r ses_kimi_code_026",
  })}\n`,
);
