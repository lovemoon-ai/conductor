import { ChatGPTSSECollector } from "../providers/chatgpt-sse-collector.js";
import { parseSSE } from "../core/sse-parser.js";
import type { SiteDefinition } from "./types.js";

/** Incremental SSE framing; input is decoded with TextDecoder(stream: true). */
export class ChatStreamDecoder {
  text = "";
  complete = false;
  error?: string;
  private pending = "";
  private gpt = new ChatGPTSSECollector();
  private fragments = new Map<number, string>();
  private fragmentTypes = new Map<number, string>();
  private lastPath = "";

  constructor(private format: SiteDefinition["format"]) {}

  push(chunk: string): void {
    this.pending += chunk;
    if (this.pending.length > 2_000_000) throw new Error("SSE frame exceeds limit");
    // Keep a trailing CR until its LF arrives in the next chunk.
    const normalized = this.pending.replace(/\r\n/g, "\n");
    const frames = normalized.split("\n\n");
    this.pending = frames.pop() ?? "";
    for (const frame of frames) {
      for (const event of parseSSE(frame + "\n\n")) this.event(event.data);
    }
  }

  private event(data: string): void {
    if (data.trim() === "[DONE]") { this.complete = true; return; }
    let value: Record<string, any>;
    try { value = JSON.parse(data); } catch { return; }
    if (!value || typeof value !== "object") return;
    if (value.error || value.type === "error" || value.event === "error") {
      this.error = "Provider returned an error";
      return;
    }
    if (this.format === "chatgpt") {
      this.gpt.ingestEvents([{ data, event: "message" }]);
      this.text = this.gpt.getCurrentTurnText();
      this.complete ||= this.gpt.isStreamComplete();
    } else if (this.format === "claude") {
      if (value.type === "content_block_delta" && value.delta?.type === "text_delta") this.text += value.delta.text ?? "";
      if (value.type === "completion" && typeof value.completion === "string") this.text += value.completion;
      if (value.type === "message_stop") this.complete = true;
    } else if (this.format === "kimi") {
      if (value.event === "cmpl" && typeof value.text === "string") this.text += value.text;
      if (value.event === "all_done") this.complete = true;
    } else if (this.format === "deepseek") {
      const response = value.response ?? value.v?.response ?? (value.p === "response" ? value.v : undefined);
      if (Array.isArray(response?.fragments)) {
        for (const fragment of response.fragments) {
          this.fragmentTypes.set(fragment.id, fragment.type);
          this.fragments.set(fragment.id, fragment.content ?? "");
        }
      }
      const p = typeof value.p === "string" ? value.p : this.lastPath;
      this.lastPath = p;
      const match = /(?:response\/)?fragments\/(\d+)\/content/.exec(p);
      if (match && typeof value.v === "string") {
        const id = Number(match[1]);
        this.fragments.set(id, value.o === "SET" ? value.v : (this.fragments.get(id) ?? "") + value.v);
      }
      this.text = [...this.fragments].filter(([id]) => this.fragmentTypes.get(id) !== "THINK").sort(([a], [b]) => a - b).map(([, text]) => text).join("");
      if (response?.status === "FINISHED" || (p === "response/status" && value.v === "FINISHED")) this.complete = true;
    } else {
      if (value.type === "delta" && typeof value.text === "string") this.text += value.text;
      if (value.type === "done") this.complete = true;
    }
    if (this.text.length > 1_000_000) throw new Error("Response exceeds limit");
  }
}
