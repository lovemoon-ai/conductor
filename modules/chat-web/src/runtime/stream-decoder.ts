import { ChatGPTSSECollector } from "../providers/chatgpt-sse-collector.js";
import { parseSSE } from "../core/sse-parser.js";
import type { SiteDefinition } from "./types.js";

/** Incremental SSE framing; input is decoded with TextDecoder(stream: true). */
export class ChatStreamDecoder {
  text = "";
  complete = false;
  error?: string;
  errorCode?: string;
  source: "sse" | "connect" = "sse";
  captured = false;
  private connectPending = Buffer.alloc(0);
  private connectEnded = false;
  private kimiDone = false;
  private kimiMessageId = "";
  private kimiBlocks = new Map<string, string>();
  private pending = "";
  private gpt = new ChatGPTSSECollector();
  private fragments = new Map<number, string>();
  private fragmentTypes = new Map<number, string>();
  private lastPath = "";

  constructor(private format: SiteDefinition["format"]) {}

  push(chunk: string): void {
    this.captured = true;
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

  /** Connect's five-byte envelope must be decoded before UTF-8, including split headers. */
  pushConnect(chunk: Uint8Array): void {
    this.source = "connect";
    this.captured = true;
    if (this.connectEnded) throw new Error("Data after Connect end stream");
    this.connectPending = Buffer.concat([this.connectPending, chunk]);
    let offset = 0;
    while (this.connectPending.length - offset >= 5) {
      const flags = this.connectPending[offset]!;
      const size = this.connectPending.readUInt32BE(offset + 1);
      if (size > 2_000_000) throw new Error("Connect frame exceeds limit");
      if (flags !== 0 && flags !== 2) throw new Error("Unsupported Connect frame flags");
      if (this.connectPending.length - offset < size + 5) break;
      const body = this.connectPending.subarray(offset + 5, offset + 5 + size);
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
      offset += size + 5;
      if (flags === 2) {
        this.connectEnded = true;
        if (value.error) this.providerError(value, "Provider returned a Connect error");
        else this.complete = !this.error && this.kimiDone && !!this.text;
        if (offset !== this.connectPending.length) throw new Error("Data after Connect end stream");
      } else {
        if (this.format !== "kimi") throw new Error("Connect is unsupported for this provider");
        this.kimiConnect(value);
      }
    }
    this.connectPending = this.connectPending.subarray(offset);
  }

  finishConnect(): void {
    if (!this.complete && (this.connectPending.length || !this.connectEnded)) throw new Error("Connect stream ended without a complete trailer");
  }

  private kimiConnect(value: Record<string, any>): void {
    if (this.error) return;
    if (value.error) { this.providerError(value, "Provider returned an error"); return; }
    if (value.message?.role === "assistant") this.kimiMessageId = value.message.id;
    const block = value.block;
    if (block && typeof block.text?.content === "string" &&
        typeof block.id === "string" && /^block\.text(?:\.content)?$/.test(value.mask ?? "") &&
        (!block.messageId || block.messageId === this.kimiMessageId)) {
      const key = this.kimiMessageId + ":" + block.id;
      this.kimiBlocks.set(key, value.op === "append"
        ? (this.kimiBlocks.get(key) ?? "") + block.text.content : block.text.content);
      this.text = [...this.kimiBlocks.values()].join("");
    }
    // Kimi can abort fetch after turn done, before the clone receives the Connect trailer.
    // Message completion alone is insufficient: tool rounds can create more messages.
    if (value.done) { this.kimiDone = true; this.complete = !!this.text; }
    if (this.text.length > 1_000_000) throw new Error("Response exceeds limit");
  }

  private deepseek(value: Record<string, any>, base = ""): void {
    const response = value.response ?? value.v?.response ?? (value.p === "response" && !Array.isArray(value.v) ? value.v : undefined);
    if (Array.isArray(response?.fragments)) {
      this.fragments.clear(); this.fragmentTypes.clear();
      response.fragments.forEach((fragment: any, index: number) => {
        this.fragmentTypes.set(index, fragment.type);
        this.fragments.set(index, fragment.content ?? "");
      });
    }
    const path = typeof value.p === "string" ? (base ? base + "/" + value.p : value.p) : this.lastPath;
    if (value.o === "BATCH" && Array.isArray(value.v)) {
      for (const patch of value.v) this.deepseek(patch, path);
    } else {
      if (typeof value.p === "string") this.lastPath = path;
      if (path === "response/fragments" && Array.isArray(value.v)) {
        if (value.o === "SET") { this.fragments.clear(); this.fragmentTypes.clear(); }
        for (const fragment of value.v) {
          const index = this.fragments.size;
          this.fragmentTypes.set(index, fragment.type);
          this.fragments.set(index, fragment.content ?? "");
        }
      }
      const match = /(?:response\/)?fragments\/(-?\d+)\/content$/.exec(path);
      if (match && typeof value.v === "string") {
        const raw = Number(match[1]);
        const index = raw < 0 ? this.fragments.size + raw : raw;
        if (index >= 0) this.fragments.set(index, value.o === "SET" ? value.v : (this.fragments.get(index) ?? "") + value.v);
      }
      if (response?.status === "FINISHED" || (path === "response/status" && value.v === "FINISHED")) this.complete = true;
    }
    this.text = [...this.fragments].filter(([index]) => this.fragmentTypes.get(index) === "RESPONSE")
      .sort(([a], [b]) => a - b).map(([, text]) => text).join("");
  }

  private providerError(value: Record<string, any>, fallback: string): void {
    if (this.error) return;
    const error = value.error;
    const details: Record<string, any>[] = Array.isArray(error?.details) ? error.details : [];
    const concurrency = (this.format === "deepseek" && value.finish_reason === "parallel_chat_limit") ||
      (this.format === "kimi" && details.some(detail => detail?.debug?.reason === "REASON_CHAT_CONCURRENCY_EXCEEDED"));
    this.errorCode = concurrency ? "PROVIDER_CONCURRENCY_LIMIT" : "PROVIDER_ERROR";
    this.complete = false;
    if (concurrency) {
      const provider = this.format === "kimi" ? "Kimi" : "DeepSeek";
      this.error = provider + " 账号同时生成的对话过多，请等待其他对话结束后重试。";
      return;
    }
    // Forward only the provider's error message, never its full response,
    // encoded details, metadata or account data.
    const message = [
      typeof error === "string" ? error : error?.message,
      ...details.map(detail => detail?.debug?.localizedMessage?.message),
      value.message,
      this.format === "deepseek" ? value.content : undefined,
    ].find(item => typeof item === "string" && item.trim());
    const code = typeof error?.code === "string" && /^[a-zA-Z0-9_.-]{1,80}$/.test(error.code) ? error.code : "";
    const text = typeof message === "string" ? message.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 500) : "";
    this.error = fallback + (code ? " [" + code + "]" : "") + (text ? ": " + text : "");
  }

  private event(data: string): void {
    if (this.error) return;
    if (data.trim() === "[DONE]") { this.complete = true; return; }
    let value: Record<string, any>;
    try { value = JSON.parse(data); } catch { return; }
    if (!value || typeof value !== "object") return;
    if (value.error || value.type === "error" || value.event === "error") {
      this.providerError(value, "Provider returned an error");
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
      this.deepseek(value);
    } else {
      if (value.type === "delta" && typeof value.text === "string") this.text += value.text;
      if (value.type === "done") this.complete = true;
    }
    if (this.text.length > 1_000_000) throw new Error("Response exceeds limit");
  }
}
