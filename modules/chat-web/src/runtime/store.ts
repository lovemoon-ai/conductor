import fs from "node:fs/promises";
import path from "node:path";
import type { Conversation, RuntimeState, Turn } from "./types.js";

export class RuntimeStore {
  private queue: Promise<unknown> = Promise.resolve();
  private constructor(readonly directory: string, private state: RuntimeState) {}

  static async open(directory: string): Promise<RuntimeStore> {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
    let state: RuntimeState = { version: 1, conversations: {}, turns: {} };
    try {
      state = JSON.parse(await fs.readFile(path.join(directory, "state.json"), "utf8")) as RuntimeState;
      if (state.version !== 1 || !state.conversations || !state.turns) throw new Error("Unsupported chat runtime state");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return new RuntimeStore(directory, state);
  }

  read(): RuntimeState {
    return structuredClone(this.state);
  }

  conversation(id: string): Conversation | undefined { return Object.hasOwn(this.state.conversations, id) ? structuredClone(this.state.conversations[id]) : undefined; }
  turn(id: string): Turn | undefined { return Object.hasOwn(this.state.turns, id) ? structuredClone(this.state.turns[id]) : undefined; }
  conversations(): Conversation[] { return structuredClone(Object.values(this.state.conversations)); }
  turnStatus(id: string) { return this.state.turns[id]?.status; }

  // Volatile callbacks validate before mutating; they only update live stream
  // text/events. The next durable transition includes all preceding deltas.
  update<T>(change: (state: RuntimeState) => T | Promise<T>, durable = true, hooks: { beforeCommit?: () => Promise<void>; afterCommit?: () => void } = {}): Promise<T> {
    const run = this.queue.then(async () => {
      const next = durable ? structuredClone(this.state) : this.state;
      const result = await change(next);
      if (durable) {
        await hooks.beforeCommit?.();
        const file = path.join(this.directory, "state.json");
        const temporary = file + ".tmp";
        const handle = await fs.open(temporary, "w", 0o600);
        try {
          await handle.writeFile(JSON.stringify(next));
          await handle.sync();
        } finally {
          await handle.close();
        }
        await fs.rename(temporary, file);
      }
      this.state = next;
      hooks.afterCommit?.();
      return structuredClone(result);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
