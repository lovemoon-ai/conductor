#!/usr/bin/env node

function readFlagValue(argv, names, fallback = "") {
  const aliases = Array.isArray(names) ? names : [names];
  for (let index = 0; index < argv.length; index += 1) {
    const value = String(argv[index] || "");
    for (const name of aliases) {
      const longEquals = `${name}=`;
      if (value.startsWith(longEquals)) {
        return value.slice(longEquals.length) || fallback;
      }
      if (value === name) {
        const next = String(argv[index + 1] || "");
        if (next && !next.startsWith("-")) {
          return next;
        }
      }
    }
  }
  return fallback;
}

function extractTextContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("");
  }
  return "";
}

function extractImageCount(content) {
  if (!Array.isArray(content)) {
    return 0;
  }
  return content.filter((part) => part?.type === "image_url").length;
}

const argv = process.argv.slice(2);
const outputFormat = readFlagValue(argv, "--output-format", "text");

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", () => {
  const lines = stdin
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const message = lines.length > 0 ? JSON.parse(lines[0]) : { role: "user", content: "" };
  const promptText = extractTextContent(message.content);
  const imageCount = extractImageCount(message.content);
  if (promptText === "/clear") {
    const reply = process.env.FAKE_KIMI_PRINT_CLEAR_ERROR === "1"
      ? "LLM provider error: rate limited"
      : "The context has been cleared.";
    process.stdout.write(`${JSON.stringify({ role: "assistant", content: reply })}\n`);
    return;
  }
  if (promptText === "/compact") {
    if (process.env.FAKE_KIMI_PRINT_COMPACT_ERROR === "1") {
      // kimi-cli print mode writes provider errors as plain text and exits 0.
      process.stdout.write("LLM provider error: rate limited\n");
      return;
    }
    const reply = process.env.FAKE_KIMI_PRINT_EMPTY_CONTEXT === "1"
      ? "The context is empty."
      : "The context has been compacted.";
    process.stdout.write(`${JSON.stringify({ role: "assistant", content: reply })}\n`);
    return;
  }
  const structured = promptText.includes("JSON Schema:");
  const responseText = structured
    ? "{\"ok\":true}\n"
    : imageCount > 0
      ? `OK from fake kimi print [images:${imageCount}]\n`
      : "OK from fake kimi print\n";

  if (outputFormat === "stream-json") {
    process.stdout.write(
      `${JSON.stringify({
        role: "assistant",
        content: "Let me inspect the workspace.",
        tool_calls: [
          {
            type: "function",
            id: "tc_1",
            function: {
              name: "Shell",
              arguments: "{\"command\":\"pwd\"}",
            },
          },
        ],
      })}\n`,
    );
    process.stdout.write(
      `${JSON.stringify({
        role: "tool",
        tool_call_id: "tc_1",
        content: "/tmp/fake-kimi\n",
      })}\n`,
    );
    process.stdout.write(
      `${JSON.stringify({
        role: "assistant",
        content: responseText,
      })}\n`,
    );
    return;
  }

  process.stdout.write(responseText);
});
