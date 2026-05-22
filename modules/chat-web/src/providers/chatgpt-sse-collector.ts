import type { Page, Response } from "playwright";

import { parseSSE, type SSEEvent } from "../core/sse-parser.js";

/**
 * URL pattern for ChatGPT's streaming conversation endpoint. The exact
 * path has shifted historically (`/backend-api/conversation`,
 * `/backend-api/f/conversation`, `/backend-api/lat/r/conversation`, ...);
 * `conversation` has stayed as the final path segment in every form.
 *
 * NOTE: must NOT match the sibling JSON endpoints `/conversation/init`,
 * `/conversation/prepare`, `/conversation/textdocs/...` — those land
 * before the real SSE response and would otherwise be captured first.
 */
export const CHATGPT_CONVERSATION_URL = /\/backend-api\/(?:[^/]+\/)*conversation(?:\?|$)/;

interface AssistantSnapshot {
  /** Concatenated text across `content.parts`, in order. */
  parts: string[];
  status: string;
  authorRole: string;
}

interface TurnState {
  /** Messages we've seen in this turn, keyed by `message.id` (or a synthetic id for delta-only frames). */
  messages: Map<string, AssistantSnapshot>;
  /**
   * v1 delta-encoding remembers the last `{p, o}` pair so subsequent
   * frames that contain only `{v: …}` can implicitly extend the same op.
   */
  lastDeltaPath?: string;
  lastDeltaOp?: string;
  lastDeltaTargetId?: string;
  /** True once we've seen [DONE] or message_stream_complete on the wire. */
  streamComplete: boolean;
  /** Raw events kept for debugging / doctor dumps. */
  rawEvents: SSEEvent[];
}

/**
 * Listens to ChatGPT's streaming conversation responses and reconstructs
 * the assistant's original markdown (code fences, list prefixes, table
 * pipes, link URLs — everything that `innerText` would have stripped).
 *
 * Usage:
 *   const collector = new ChatGPTSSECollector();
 *   collector.attach(page);
 *   …
 *   const wait = collector.beginTurn();
 *   await adapter.sendMessage(page, "...");
 *   const markdown = await wait; // resolves to the assistant's raw markdown
 *
 * Robust to multiple SSE formats observed in the wild:
 *   - Full message snapshots: `{message: {author, content: {parts}, status}, ...}`
 *   - v1 delta encoding: `{p, o: "append", v}` followed by `{v}` shorthand frames
 *   - Terminators: `[DONE]` or `{"type": "message_stream_complete"}`
 */
export class ChatGPTSSECollector {
  private detach?: () => void;

  private pendingTurn:
    | {
        resolve: (text: string) => void;
        reject: (err: unknown) => void;
        captured: boolean;
        timer?: NodeJS.Timeout;
      }
    | undefined;

  private currentTurn: TurnState = freshTurn();

  /** Most recent assistant text we managed to reconstruct, across all turns. */
  private lastAssistantText = "";

  /** Attach to a Playwright Page. Idempotent. */
  attach(page: Page): void {
    if (this.detach) return;
    const handler = (response: Response) => {
      void this.maybeConsume(response);
    };
    page.on("response", handler);
    this.detach = () => page.off("response", handler);
  }

  dispose(): void {
    this.detach?.();
    this.detach = undefined;
    if (this.pendingTurn?.timer) clearTimeout(this.pendingTurn.timer);
    this.pendingTurn = undefined;
  }

  /**
   * Start watching for the next conversation response. Returns a promise
   * that resolves to the accumulated markdown once that response finishes
   * streaming (or rejects on the supplied timeout).
   */
  beginTurn(options: { timeoutMs?: number } = {}): Promise<string> {
    // Reject any prior unresolved turn first — we only track one in flight.
    if (this.pendingTurn) {
      this.pendingTurn.reject(new Error("Superseded by a new turn"));
      if (this.pendingTurn.timer) clearTimeout(this.pendingTurn.timer);
    }
    this.currentTurn = freshTurn();

    const timeoutMs = options.timeoutMs ?? 180_000;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingTurn) {
          const partial = this.bestAssistantText();
          this.pendingTurn = undefined;
          // Resolve with whatever we got rather than rejecting — callers
          // can decide to fall back. Empty string means "no SSE captured".
          resolve(partial);
        }
      }, timeoutMs);
      this.pendingTurn = { resolve, reject, captured: false, timer };
    });
  }

  /** Latest assistant text across all completed turns. */
  getLastAssistantText(): string {
    return this.lastAssistantText;
  }

  /** Has the current turn's SSE stream ended? */
  isStreamComplete(): boolean {
    return this.currentTurn.streamComplete;
  }

  /**
   * Apply a raw SSE body directly. Exposed for tests and for callers that
   * want to feed in a recorded transcript.
   */
  ingest(body: string): void {
    const events = parseSSE(body);
    for (const ev of events) this.applyEvent(ev);
    this.currentTurn.streamComplete = true;
    this.finishPendingTurn();
  }

  private async maybeConsume(response: Response): Promise<void> {
    if (!this.pendingTurn || this.pendingTurn.captured) return;
    const url = response.url();
    if (!CHATGPT_CONVERSATION_URL.test(url)) return;
    if (response.request().method() !== "POST") return;

    // Only the streaming reply matters. ChatGPT's sibling POSTs to the
    // same path family (`/conversation/init`, `/conversation/prepare`)
    // return `application/json` and would otherwise race us to claim the
    // pendingTurn before the real `text/event-stream` arrives.
    const contentType = response.headers()["content-type"] ?? "";
    if (!contentType.includes("event-stream")) return;

    // Claim this response so concurrent matches don't double-process.
    this.pendingTurn.captured = true;

    let body: string;
    try {
      // `response.finished()` resolves only after the entire body has been
      // fetched (the network-level "request finished" signal). For chunked
      // SSE this is non-trivial: the `response` event fires when headers
      // arrive, but the body keeps streaming. Without this wait, certain
      // Playwright builds let `response.text()` return whatever was
      // buffered at handler-time — usually a partial SSE that cuts the
      // assistant reply mid-token.
      await response.finished().catch(() => undefined);
      body = await response.text();
    } catch (err) {
      // Network aborted etc. Don't reject — let the caller fall back.
      this.finishPendingTurnWithError(err);
      return;
    }
    this.ingest(body);
  }

  private applyEvent(ev: SSEEvent): void {
    this.currentTurn.rawEvents.push(ev);

    const raw = ev.data.trim();
    if (raw === "[DONE]") {
      this.currentTurn.streamComplete = true;
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // delta_encoding marker: `event: delta_encoding\ndata: "v1"`. The
      // bare-string data isn't valid as a top-level JSON value in our
      // pipeline (it parses but doesn't carry payload), so ignore quietly.
      return;
    }

    if (!parsed || typeof parsed !== "object") return;
    const obj = parsed as Record<string, unknown>;

    // Case 1: full message snapshot.
    if (isMessageEnvelope(obj)) {
      const msg = obj.message as Record<string, unknown>;
      const id = String(msg.id ?? `snap-${this.currentTurn.messages.size}`);
      const role = ((msg.author as Record<string, unknown> | undefined)?.role ?? "") as string;
      const content = msg.content as Record<string, unknown> | undefined;
      const rawParts = Array.isArray(content?.parts) ? content!.parts : [];
      const parts = rawParts.map((p) => (typeof p === "string" ? p : ""));
      const status = String(msg.status ?? "in_progress");
      this.currentTurn.messages.set(id, { parts, status, authorRole: role });
      this.currentTurn.lastDeltaTargetId = id;
      if (status === "finished_successfully" && role === "assistant") {
        // Don't set streamComplete here — a later [DONE] is the real signal.
      }
      return;
    }

    // Case 2: terminator frame.
    if (obj.type === "message_stream_complete") {
      this.currentTurn.streamComplete = true;
      return;
    }

    // Case 3: v1 delta encoding.
    if ("v" in obj) {
      this.applyDelta(obj);
      return;
    }

    // Case 4: anything else (heartbeats, moderation hints, …) — ignore.
  }

  private applyDelta(obj: Record<string, unknown>): void {
    const path = typeof obj.p === "string" ? obj.p : this.currentTurn.lastDeltaPath;
    const op = typeof obj.o === "string" ? obj.o : this.currentTurn.lastDeltaOp ?? "append";
    if (path !== undefined) this.currentTurn.lastDeltaPath = path;
    this.currentTurn.lastDeltaOp = op;

    // PATCH first: ChatGPT delivers the message's CLOSING tokens (the
    // final "```", the status flip to "finished_successfully", end_turn,
    // metadata, ...) inside one wrapper frame:
    //   {"p":"", "o":"patch", "v":[ {p,o,v}, {p,o,v}, ... ]}
    // The wrapper's own `p` is empty, so we MUST recurse before we
    // bail on the parts-path check below — otherwise the closing
    // backticks of code blocks (and any trailing content) get dropped.
    if (op === "patch" && Array.isArray(obj.v)) {
      for (const sub of obj.v) {
        if (sub && typeof sub === "object") this.applyDelta(sub as Record<string, unknown>);
      }
      return;
    }

    // Beyond patches, we only care about deltas that mutate assistant
    // message text. ChatGPT uses paths shaped like
    // "/message/content/parts/0".
    const partMatch = path?.match(/parts\/(\d+)/);
    if (!partMatch) return;
    const idx = parseInt(partMatch[1]!, 10);

    // Identify the target message. v1 delta frames often omit the id, in
    // which case the prior snapshot's id is the active one.
    const id = this.currentTurn.lastDeltaTargetId ?? "__current";
    let snap = this.currentTurn.messages.get(id);
    if (!snap) {
      snap = { parts: [], status: "in_progress", authorRole: "assistant" };
      this.currentTurn.messages.set(id, snap);
    }
    while (snap.parts.length <= idx) snap.parts.push("");

    const v = obj.v;
    if (op === "append") {
      const piece = typeof v === "string" ? v : "";
      snap.parts[idx] = (snap.parts[idx] ?? "") + piece;
    } else if (op === "replace") {
      const piece = typeof v === "string" ? v : "";
      snap.parts[idx] = piece;
    }
  }

  private finishPendingTurn(): void {
    if (!this.pendingTurn) return;
    const text = this.bestAssistantText();
    if (text) this.lastAssistantText = text;
    if (this.pendingTurn.timer) clearTimeout(this.pendingTurn.timer);
    const { resolve } = this.pendingTurn;
    this.pendingTurn = undefined;
    resolve(text);
  }

  private finishPendingTurnWithError(_err: unknown): void {
    if (!this.pendingTurn) return;
    if (this.pendingTurn.timer) clearTimeout(this.pendingTurn.timer);
    const { resolve } = this.pendingTurn;
    this.pendingTurn = undefined;
    // Surface as empty so the caller falls back to innerText extraction.
    resolve("");
  }

  /** Best-effort assistant text from the current turn's snapshots. */
  private bestAssistantText(): string {
    // Prefer the most recently-seen finished assistant message; fall back
    // to whatever's most recent in any status.
    let lastFinished: AssistantSnapshot | undefined;
    let lastAny: AssistantSnapshot | undefined;
    for (const snap of this.currentTurn.messages.values()) {
      if (snap.authorRole !== "assistant") continue;
      lastAny = snap;
      if (snap.status === "finished_successfully") lastFinished = snap;
    }
    const target = lastFinished ?? lastAny;
    if (!target) return "";
    return target.parts.join("");
  }
}

function freshTurn(): TurnState {
  return {
    messages: new Map(),
    streamComplete: false,
    rawEvents: [],
  };
}

function isMessageEnvelope(obj: Record<string, unknown>): boolean {
  const msg = obj.message;
  if (!msg || typeof msg !== "object") return false;
  const author = (msg as Record<string, unknown>).author;
  return Boolean(author && typeof author === "object");
}
