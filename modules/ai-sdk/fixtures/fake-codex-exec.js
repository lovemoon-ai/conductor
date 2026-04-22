#!/usr/bin/env node

import fs from "node:fs";

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

function collectFlagValues(argv, names) {
  const aliases = Array.isArray(names) ? names : [names];
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = String(argv[index] || "");
    for (const name of aliases) {
      const longEquals = `${name}=`;
      if (value.startsWith(longEquals)) {
        values.push(value.slice(longEquals.length));
        continue;
      }
      if (value === name) {
        const next = String(argv[index + 1] || "");
        if (next) {
          values.push(next);
        }
      }
    }
  }
  return values;
}

function extractPrompt(argv) {
  const positional = [];
  let skipNext = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = String(argv[index] || "");
    if (!value) {
      continue;
    }
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (
      value === "exec" ||
      value === "--json" ||
      value === "--color" ||
      value === "--skip-git-repo-check" ||
      value === "--full-auto" ||
      value === "--output-last-message" ||
      value === "--output-schema" ||
      value === "--model" ||
      value === "--image"
    ) {
      if (
        value === "--color" ||
        value === "--output-last-message" ||
        value === "--output-schema" ||
        value === "--model" ||
        value === "--image"
      ) {
        skipNext = true;
      }
      continue;
    }
    if (
      value.startsWith("--color=") ||
      value.startsWith("--output-last-message=") ||
      value.startsWith("--output-schema=") ||
      value.startsWith("--model=") ||
      value.startsWith("--image=")
    ) {
      continue;
    }
    if (!value.startsWith("-")) {
      positional.push(value);
    }
  }
  return positional.at(-1) || "";
}

const argv = process.argv.slice(2);
const lastMessageFile = readFlagValue(argv, "--output-last-message");
const outputSchemaFile = readFlagValue(argv, "--output-schema");
const imageFiles = collectFlagValues(argv, ["--image", "-i"]);
const prompt = extractPrompt(argv) || fs.readFileSync(0, "utf8");

let responseText = "OK from fake codex exec\n";
if (outputSchemaFile) {
  const schema = JSON.parse(fs.readFileSync(outputSchemaFile, "utf8"));
  if (schema?.properties?.codex_api_key_present) {
    responseText = `${JSON.stringify({ codex_api_key_present: Boolean(process.env.CODEX_API_KEY) })}\n`;
  } else {
    responseText = schema?.properties?.ok ? "{\"ok\":true}\n" : "{\"value\":\"OK from fake codex exec\"}\n";
  }
}
if (prompt.includes("[images]")) {
  responseText = `${responseText.trim()} [images:${imageFiles.length}]\n`;
}

if (lastMessageFile) {
  fs.writeFileSync(lastMessageFile, responseText, "utf8");
}

process.stdout.write(`${JSON.stringify({ type: "turn.started" })}\n`);
process.stdout.write(
  `${JSON.stringify({
    type: "item.completed",
    item: {
      type: "agent_message",
      text: responseText,
    },
  })}\n`,
);
