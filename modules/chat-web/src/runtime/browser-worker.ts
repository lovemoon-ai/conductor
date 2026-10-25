import { fork, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ChatWorker, WorkerConfig, WorkerNotice, WorkerResult } from "./types.js";
import { RuntimeError } from "./types.js";

export class BrowserWorker implements ChatWorker {
  private child: ChildProcess;
  private counter = 0;
  private pending = new Map<number, {
    resolve: (value: WorkerResult) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
    notify?: (notice: WorkerNotice) => void;
  }>();

  constructor(config: WorkerConfig) {
    const js = new URL("./worker.js", import.meta.url);
    const target = existsSync(js) ? js : new URL("./worker.ts", import.meta.url);
    this.child = fork(fileURLToPath(target), [], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      execArgv: target.pathname.endsWith(".ts") ? ["--import", createRequire(import.meta.url).resolve("tsx")] : [],
      env: { ...process.env, CHAT_WEB_LOG: "silent" },
    });
    this.child.on("message", (message: any) => {
      const pending = this.pending.get(message?.id);
      if (!pending) return;
      if (message.notice) { pending.notify?.(message.notice); return; }
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(Object.assign(new RuntimeError(message.error.code ?? "WORKER_ERROR", message.error.message), { stopConfirmed: message.error.stopConfirmed }));
      else pending.resolve(message.result);
    });
    const fail = () => {
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new RuntimeError("WORKER_EXITED", "Chat worker exited; submitted turns must be reconciled"));
      }
      this.pending.clear();
    };
    this.child.on("exit", fail);
    this.child.on("error", fail);
    this.child.send({ config });
  }

  private request(command: string, params: object = {}, timeoutMs = 60_000, notify?: (notice: WorkerNotice) => void): Promise<WorkerResult> {
    if (!this.child.connected) return Promise.reject(new RuntimeError("WORKER_EXITED", "Chat worker is disconnected"));
    const id = ++this.counter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.child.kill("SIGTERM");
        reject(new RuntimeError("WORKER_TIMEOUT", "Chat worker timed out"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, notify });
      this.child.send({ id, command, ...params }, (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new RuntimeError("WORKER_EXITED", error.message));
        }
      });
    });
  }

  open(): Promise<WorkerResult> { return this.request("open"); }
  send(input: string, timeoutMs: number, notify: (notice: WorkerNotice) => void): Promise<WorkerResult> {
    return this.request("send", { input, timeoutMs }, timeoutMs + 60_000, notify);
  }
  cancel(): void {
    if (this.child.connected) this.child.send({ command: "cancel" }, () => undefined);
  }
  async close(): Promise<void> {
    if (this.child.connected) await this.request("close", {}, 5_000).catch(() => undefined);
    if (this.child.exitCode === null && this.child.signalCode === null) {
      const exited = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
      this.child.kill("SIGTERM");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000).unref())]);
      if (this.child.exitCode === null && this.child.signalCode === null) {
        this.child.kill("SIGKILL");
        await exited;
      }
    }
  }
}
