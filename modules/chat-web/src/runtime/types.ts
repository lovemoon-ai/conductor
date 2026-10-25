export type TurnStatus = "queued" | "starting" | "submitting" | "streaming" | "cancelling" | "completed" | "cancelled" | "failed" | "uncertain";

export interface Conversation {
  id: string;
  provider: string;
  accountId: string;
  headless: boolean;
  createdAt: string;
  url?: string;
  providerConversationId?: string;
  needsReview: boolean;
  closed: boolean;
}

export interface TurnEvent {
  seq: number;
  turnId: string;
  type: TurnStatus | "message_delta" | "message_snapshot";
  at: string;
  text?: string;
  error?: string;
  stopConfirmed?: boolean;
  source?: "sse" | "connect" | "dom";
}

export interface Turn {
  id: string;
  conversationId: string;
  requestId: string;
  input: string;
  timeoutMs: number;
  status: TurnStatus;
  text: string;
  events: TurnEvent[];
  createdAt: string;
  error?: string;
  stopConfirmed?: boolean;
  source?: "sse" | "connect" | "dom";
}

export interface RuntimeState {
  version: 1;
  conversations: Record<string, Conversation>;
  turns: Record<string, Turn>;
}

export interface SiteDefinition {
  name: string;
  homeUrl: string;
  input: string;
  send: string;
  assistant: string;
  stop: string;
  conversationPath: string;
  streamPath: string;
  format: "chatgpt" | "deepseek" | "kimi" | "claude" | "text";
  experimental?: boolean;
}

export interface WorkerResult {
  text?: string;
  url?: string;
  providerConversationId?: string;
  ready?: boolean;
  stopConfirmed?: boolean;
  source?: "sse" | "connect" | "dom";
}
export interface WorkerNotice {
  type: "submitting" | "progress";
  text?: string;
  url?: string;
}
export interface ChatWorker {
  open(): Promise<WorkerResult>;
  send(input: string, timeoutMs: number, notify: (notice: WorkerNotice) => void): Promise<WorkerResult>;
  cancel(): void;
  close(): Promise<void>;
}
export interface WorkerConfig {
  conversation: Conversation;
  profileDir: string;
  site: SiteDefinition;
  executablePath?: string;
  channel?: string;
}
export type WorkerFactory = (config: WorkerConfig) => ChatWorker;

export function isTerminal(status: TurnStatus): boolean {
  return ["completed", "cancelled", "failed", "uncertain"].includes(status);
}
export class RuntimeError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "RuntimeError";
  }
}
