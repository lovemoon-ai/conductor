import { randomUUID } from "node:crypto";
import { ChatRuntimeClient } from "./client.js";
import { runtimeDirectory, runtimeSocket, startRuntimeServer } from "./server.js";
import { RuntimeError } from "./types.js";

const help = `Isolated chat runtime:
  chat-web serve [--socket PATH] [--max-workers 4] [--per-account-concurrency 2]
  chat-web runtime status|stop [--socket PATH]
  chat-web chat create <chatgpt|deepseek|kimi|claude> [--account ID] [--headed] [--deepthink|--no-deepthink]
  chat-web chat list|get|resume|login|close [CHAT_ID] [--acknowledge]
  chat-web chat send CHAT_ID MESSAGE [--request-id ID] [--timeout MS] [--detach|--jsonl] [--deepthink|--no-deepthink]
  chat-web turn get|events|cancel TURN_ID [--after SEQ]
All client commands accept --socket PATH. Login opens only this chat's window.
`;

export async function runRuntimeCli(argv: string[], write: (text: string) => void = (text) => { process.stdout.write(text); }): Promise<number> {
  const args: string[] = [];
  const flags = new Map<string, string | boolean>();
  const values = new Set(["socket", "max-workers", "per-account-concurrency", "account", "request-id", "timeout", "after", "runtime-dir", "browser-executable", "browser-channel"]);
  const booleans = new Set(["headed", "headless", "acknowledge", "detach", "jsonl", "help", "deepthink", "no-deepthink"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") { args.push(...argv.slice(i + 1)); break; }
    if (!arg.startsWith("--")) { args.push(arg); continue; }
    const key = arg.slice(2);
    if (booleans.has(key)) flags.set(key, true);
    else if (values.has(key) && argv[i + 1] !== undefined) flags.set(key, argv[++i]!);
    else throw new RuntimeError("INVALID_PARAMS", "Unknown option or missing value: " + arg);
  }
  if (flags.has("help")) { write(help); return 0; }
  if (flags.has("deepthink") && flags.has("no-deepthink")) throw new RuntimeError("INVALID_PARAMS", "Choose --deepthink or --no-deepthink");
  const deepThink = flags.has("deepthink") ? true : flags.has("no-deepthink") ? false : undefined;
  if (deepThink !== undefined && !(args[0] === "chat" && ["create", "send"].includes(args[1] ?? ""))) {
    throw new RuntimeError("INVALID_PARAMS", "DeepThink options require chat create or chat send");
  }
  const value = (name: string) => typeof flags.get(name) === "string" ? flags.get(name) as string : undefined;
  const required = (index: number) => {
    if (!args[index]) throw new RuntimeError("INVALID_PARAMS", help);
    return args[index]!;
  };
  const emit = (result: unknown) => write(JSON.stringify(result) + "\n");
  const directory = value("runtime-dir") ?? runtimeDirectory();
  const socketPath = value("socket") ?? runtimeSocket(directory);
  const client = new ChatRuntimeClient(socketPath);
  if (args[0] === "serve") {
    const server = await startRuntimeServer({ directory, socketPath,
      maxWorkers: value("max-workers") === undefined ? undefined : Number(value("max-workers")),
      perAccountConcurrency: value("per-account-concurrency") === undefined ? undefined : Number(value("per-account-concurrency")),
      executablePath: value("browser-executable"), channel: value("browser-channel") });
    emit({ socketPath, ...server.runtime.status() });
    const stop = () => { void server.close(); };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    try { await server.closed; }
    finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
    return 0;
  }
  const group = required(0);
  const action = required(1);
  if (group === "runtime") {
    if (!["status", "stop"].includes(action)) throw new RuntimeError("INVALID_PARAMS", help);
    emit(await client.call("runtime." + action));
  } else if (group === "chat") {
    switch (action) {
      case "create":
        if (flags.has("headed") && flags.has("headless")) throw new RuntimeError("INVALID_PARAMS", "Choose headed or headless");
        emit(await client.create({ provider: required(2), accountId: value("account"), headless: !flags.has("headed"), deepThink }));
        break;
      case "list": emit(await client.list()); break;
      case "get": emit(await client.get(required(2))); break;
      case "close": emit(await client.closeConversation(required(2))); break;
      case "login":
      case "resume":
        emit(await client.resume(required(2), { ...(action === "login" ? { headed: true } :
          flags.has("headed") ? { headed: true } : flags.has("headless") ? { headed: false } : {}),
          acknowledgeUncertain: flags.has("acknowledge") }));
        break;
      case "send": {
        const chat = required(2);
        const input = args.slice(3).join(" ");
        const turn = await client.submit({ conversationId: chat, input,
          requestId: value("request-id") ?? randomUUID(), timeoutMs: value("timeout") ? Number(value("timeout")) : undefined, deepThink });
        if (flags.has("detach")) { emit(turn); break; }
        const result = await client.wait(turn.id, flags.has("jsonl") ? emit : undefined);
        if (!flags.has("jsonl")) emit(result);
        return result.status === "completed" ? 0 : 1;
      }
      default: throw new RuntimeError("INVALID_PARAMS", help);
    }
  } else if (group === "turn") {
    const id = required(2);
    if (action === "get") emit(await client.getTurn(id));
    else if (action === "cancel") emit(await client.cancel(id));
    else if (action === "events") {
      const after = Number(value("after") ?? 0);
      if (!Number.isInteger(after) || after < 0) throw new RuntimeError("INVALID_PARAMS", "Invalid sequence");
      for await (const event of client.events(id, after)) emit(event);
    } else throw new RuntimeError("INVALID_PARAMS", help);
  } else throw new RuntimeError("INVALID_PARAMS", help);
  return 0;
}
