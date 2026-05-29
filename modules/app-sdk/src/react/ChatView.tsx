/**
 * ChatView: top-level chat container.
 *
 * Composition is deliberately flat:
 *
 *   <ChatProvider>
 *     <RuntimeStatusBar />   (top, sticky)
 *     <MessageList />        (scrolling middle)
 *     <MessageInput />       (bottom, sticky)
 *   </ChatProvider>
 *
 * The default labels here are English. Hosts override per-string via the
 * `labels` prop. Theming overrides go through CSS variables on the root
 * element via the `theme` prop.
 *
 * v0.1: visually minimal but feature-complete (history, send, interrupt,
 * runtime status, connection state). The eventual extraction from
 * `web/src/features/chat/components/ChatView.tsx` (889 lines) brings the
 * polished visuals + markdown + attachments. Public API contract is stable
 * across that migration.
 */
import type { CSSProperties } from 'react';
import { ChatProvider } from './store/chat-store.js';
import {
  MessageList,
  type RenderMessageContent,
} from './components/MessageList.js';
import { MessageInput } from './components/MessageInput.js';
import { RuntimeStatusBar } from './components/RuntimeStatusBar.js';
import type { ChatAdapter } from '../types/adapter.js';

export interface ChatViewProps {
  taskId: string;
  adapter: ChatAdapter;

  /** i18n strings; falls back to English. */
  labels?: Partial<ChatViewLabels>;

  /** Inline theme overrides. Maps to CSS variables on the root element. */
  theme?: ChatViewTheme;

  /** Force layout regardless of viewport. Default 'auto'. */
  layout?: 'desktop' | 'mobile' | 'auto';

  /**
   * Whether to show "via {appDisplayName}" chip on bubbles with audit origin.
   * Default `false`. The main Conductor app, which renders other users'
   * app-created messages, sets this to `true`. Third-party hosts embedding
   * the widget in their own app should leave it `false` to avoid the
   * "via <self>" self-reference loop.
   */
  showAppOriginChip?: boolean;

  /**
   * Override how each message's content is rendered inside its bubble.
   * Defaults to plain text. Common use: wire in a markdown renderer.
   *
   *   import ReactMarkdown from 'react-markdown';
   *   import remarkGfm from 'remark-gfm';
   *
   *   <ChatView
   *     taskId={taskId}
   *     adapter={adapter}
   *     renderMessageContent={(m) => (
   *       <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
   *     )}
   *   />
   *
   * The SDK still owns the bubble container (role-based alignment, pending
   * state, data attributes). Only the content inside is replaced.
   */
  renderMessageContent?: RenderMessageContent;

  onError?: (error: unknown) => void;

  /** Extra className applied to the root container. */
  className?: string;

  /** Disable send/interact (e.g. when task is read-only). */
  readOnly?: boolean;

  /** Focus the composer on mount / when the task changes. Default `false`. */
  autoFocus?: boolean;
}

export interface ChatViewLabels {
  statusThinking: string;
  statusToolCall: string;
  statusAwaitingUser: string;
  statusDone: string;
  inputPlaceholder: string;
  send: string;
  interrupt: string;
  restart: string;
  loadEarlier: string;
  /** Action-menu label: copy the message text. */
  copy: string;
  /** Action-menu label shown briefly after a successful copy. */
  copied: string;
  /** Action-menu label: re-send a user message's text. */
  resend: string;
  /** Accessible label for the floating "jump to latest" button. */
  scrollToBottom: string;
  /** Accessible label prefix for the question-anchor navigation dots. */
  jumpToQuestion: string;
  /** Empty-state heading shown when the task has no messages yet. */
  emptyTitle: string;
  /** Empty-state body copy shown below the heading. */
  emptyBody: string;
  /** Empty-state / action-menu button to restart the AI session. */
  restartPending: string;
}

export interface ChatViewTheme {
  accent?: string;
  background?: string;
  bubbleUser?: string;
  bubbleAssistant?: string;
  /** Arbitrary CSS variable override (key without `--` prefix). */
  [cssVarKey: string]: string | undefined;
}

const DEFAULT_LABELS: ChatViewLabels = {
  statusThinking: 'Thinking…',
  statusToolCall: 'Calling tool…',
  statusAwaitingUser: 'Waiting for input',
  statusDone: 'Done',
  inputPlaceholder: 'Type a message',
  send: 'Send',
  interrupt: 'Stop',
  restart: 'Restart',
  loadEarlier: 'Load earlier messages',
  copy: 'Copy',
  copied: 'Copied',
  resend: 'Resend',
  scrollToBottom: 'Scroll to latest message',
  jumpToQuestion: 'Jump to question',
  emptyTitle: 'No messages yet',
  emptyBody: 'Send a message to get started — the conversation will appear here.',
  restartPending: 'Restarting…',
};

export function ChatView(props: ChatViewProps) {
  const labels = { ...DEFAULT_LABELS, ...(props.labels ?? {}) };
  const themeStyle = props.theme ? toCssVariableStyle(props.theme) : undefined;
  const className = ['conductor-chat-view', props.className].filter(Boolean).join(' ');

  return (
    <div
      className={className}
      data-task-id={props.taskId}
      data-layout={props.layout ?? 'auto'}
      style={themeStyle}
    >
      <ChatProvider taskId={props.taskId} adapter={props.adapter} onError={props.onError}>
        <RuntimeStatusBar labels={labels} />
        <MessageList
          labels={labels}
          renderMessageContent={props.renderMessageContent}
          showAppOriginChip={props.showAppOriginChip}
          readOnly={props.readOnly}
        />
        <MessageInput labels={labels} disabled={props.readOnly} autoFocus={props.autoFocus} />
      </ChatProvider>
    </div>
  );
}

function toCssVariableStyle(theme: ChatViewTheme): CSSProperties {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(theme)) {
    if (typeof value !== 'string') continue;
    const varName = WELL_KNOWN_THEME_VARS[key] ?? toCssVarName(key);
    out[varName] = value;
  }
  return out as CSSProperties;
}

const WELL_KNOWN_THEME_VARS: Record<string, string> = {
  accent: '--accent',
  background: '--conductor-paper',
  bubbleUser: '--conductor-bubble-user',
  bubbleAssistant: '--conductor-bubble-assistant',
};

function toCssVarName(camelCaseKey: string): string {
  if (camelCaseKey.startsWith('--')) return camelCaseKey;
  return (
    '--' + camelCaseKey.replace(/([A-Z])/g, (_, c: string) => `-${c.toLowerCase()}`)
  );
}
