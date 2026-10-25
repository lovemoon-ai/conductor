import fs from "node:fs/promises";
import path from "node:path";
import type { RuntimeState } from "./types.js";

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

  update<T>(change: (state: RuntimeState) => T): Promise<T> {
    const run = this.queue.then(async () => {
      const next = structuredClone(this.state);
      const result = change(next);
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
      this.state = next;
      return structuredClone(result);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
