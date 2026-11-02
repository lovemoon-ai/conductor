import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { RuntimeError, type Conversation } from "./types.js";

/** Small identity records outlive profile/history GC, so Conductor IDs remain resumable. */
export class ConversationArchive {
  constructor(private directory: string) {}
  private file(id: string): string {
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id)) throw new RuntimeError("NOT_FOUND", "Conversation not found");
    return path.join(this.directory, "archive", id + ".json");
  }
  read(id: string): Conversation | undefined {
    let text: string;
    try { text = readFileSync(this.file(id), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    const record = JSON.parse(text);
    if (record.version !== 1 || record.conversation?.id !== id || typeof record.conversation.provider !== "string" ||
      typeof record.conversation.accountId !== "string") throw new RuntimeError("INVALID_ARCHIVE", "Saved conversation identity is invalid");
    return { ...record.conversation, archived: true };
  }
  async save(chat: Conversation): Promise<void> {
    const file = this.file(chat.id);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const { archived: _archived, ...conversation } = chat;
    const temporary = file + "." + randomUUID() + ".tmp";
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      try { await handle.writeFile(JSON.stringify({ version: 1, conversation })); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
  }
}
