#!/usr/bin/env node
/**
 * Minimal CLI app: chat with your Conductor daemon from a terminal.
 *
 * What it shows: the four moves any third-party server-side integration
 * needs to perform.
 *
 *   1. connect()                  — open an AppClient with a Conductor token.
 *   2. client.projects.bind()     — idempotent find-or-create of the
 *                                   project (daemon + workspace pair).
 *   3. client.tasks.create()      — start a new AI conversation in that
 *                                   project.
 *   4. client.tasks.streamReply() — stream the AI reply token-preview by
 *                                   token-preview to stdout. (Send a
 *                                   message first via tasks.sendMessage,
 *                                   or use `initialMessage` on create.)
 *
 * Total business code: ~35 lines (the rest is config + UX).
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout, exit, env } from 'node:process';
import { connect } from '@love-moon/app-sdk/server';

function readRequired(key) {
  const v = env[key];
  if (!v) {
    console.error(`Missing env var ${key}. See README for setup.`);
    exit(1);
  }
  return v;
}

const config = {
  baseUrl: env.CONDUCTOR_BASE_URL ?? 'http://localhost:6152',
  token: readRequired('CONDUCTOR_TOKEN'),
  daemonHost: readRequired('CONDUCTOR_DAEMON_HOST'),
  workspacePath: readRequired('CONDUCTOR_WORKSPACE_PATH'),
  appName: env.CONDUCTOR_APP_NAME ?? 'App SDK CLI Example',
};

async function main() {
  console.log(`→ connecting to ${config.baseUrl}`);
  const client = await connect({
    baseUrl: config.baseUrl,
    bearerToken: config.token,
    onUnauthorized: () => console.error('! token rejected (401)'),
  });

  console.log(`→ binding project "${config.appName}" on ${config.daemonHost}:${config.workspacePath}`);
  const project = await client.projects.bind({
    name: config.appName,
    daemonHost: config.daemonHost,
    workspacePath: config.workspacePath,
  });
  console.log(`  project ${project.id} (${project.createdByApp ? 'created' : 'reused'})`);

  // Prompt the user for the initial message right away, so the task is
  // created with content and the AI starts working immediately.
  const rl = createInterface({ input: stdin, output: stdout });
  const prompt = await rl.question('You: ');
  rl.close();
  if (!prompt.trim()) {
    console.log('(empty input — nothing to do)');
    await client.close();
    return;
  }

  console.log(`→ creating task`);
  const task = await client.tasks.create({
    projectId: project.id,
    title: prompt.slice(0, 60),
    initialMessage: prompt,
  });
  console.log(`  task ${task.id}`);

  // Stream the AI reply. streamReply yields cumulative text previews; we
  // print only the new tail each time so the terminal shows a smooth flow.
  console.log('\nAI:');
  let printedSoFar = '';
  for await (const delta of client.tasks.streamReply(task.id)) {
    if (delta.type === 'text') {
      // The first delta is the full preview-so-far; later deltas are
      // already diffed by the SDK. Most of the time the cumulative preview
      // grows monotonically, but the backend may emit a reset (e.g. a tool
      // call replaces the text). When that happens we print the whole new
      // text rather than a corrupt slice.
      stdout.write(delta.text);
      if (delta.text && delta.text.startsWith(printedSoFar)) {
        printedSoFar = delta.text;
      } else {
        // Reset path: the SDK already detected a non-continuation and is
        // handing us the FULL new preview as `delta.text`, not an
        // incremental tail. Tracking `printedSoFar + delta.text` here would
        // double-count and corrupt the prefix used by the 'done' fill-in
        // below.
        printedSoFar = delta.text;
      }
    } else if (delta.type === 'done') {
      // streamReply guarantees a single 'done' carrying the persisted message.
      // If the rolling previews missed any trailing characters, fill them in
      // (only when the persisted content is a continuation of what we printed).
      const full = delta.message.content;
      if (full.startsWith(printedSoFar) && printedSoFar.length < full.length) {
        stdout.write(full.slice(printedSoFar.length));
      }
      stdout.write('\n');
      break;
    } else if (delta.type === 'error') {
      stdout.write(`\n! AI failed: ${delta.error.message}\n`);
      break;
    }
    // 'status' deltas are ignored in this minimal example.
  }

  await client.close();
}

main().catch((err) => {
  // ConductorAppError has a stable `code` field for branching; for a CLI we
  // just print message + code.
  const code = err?.code ? ` [${err.code}]` : '';
  console.error(`\n! ${err.message ?? err}${code}`);
  exit(1);
});
