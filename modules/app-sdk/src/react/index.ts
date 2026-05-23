/**
 * @love-moon/app-sdk/react — React chat widget.
 *
 * Public surface (v0.1):
 *   - <ChatView />        — top-level composed widget (recommended).
 *   - <MessageList />     — message bubble list (requires <ChatProvider>).
 *   - <MessageInput />    — input + send/interrupt (requires <ChatProvider>).
 *   - <RuntimeStatusBar />— AI status line (requires <ChatProvider>).
 *   - <ChatProvider />    — context/state wrapper for compose-your-own layouts.
 *   - useChat()           — hook for accessing chat state / actions inside provider.
 *   - createRestAdapter() — default ChatAdapter that talks to a Conductor-shaped BFF.
 *
 * Most consumers only need `<ChatView>` + `createRestAdapter`.
 */
export { ChatView } from './ChatView.js';
export type {
  ChatViewProps,
  ChatViewLabels,
  ChatViewTheme,
} from './ChatView.js';

export { MessageList } from './components/MessageList.js';
export type {
  MessageListProps,
  RenderMessageContent,
} from './components/MessageList.js';
export { MessageInput } from './components/MessageInput.js';
export { RuntimeStatusBar } from './components/RuntimeStatusBar.js';

export { ChatProvider, useChat } from './store/chat-store.js';
export type { ChatState } from './store/chat-store.js';

export { createRestAdapter } from './adapter/rest-adapter.js';
export type { RestAdapterOptions } from './adapter/rest-adapter.js';

// Re-export types for ergonomic single-import callers.
export type {
  ChatAdapter,
  Message,
  MessageRole,
  Attachment,
  SendMessageInput,
  RuntimeStatus,
  RuntimeState,
  ChatEvent,
  Task,
  TaskStatus,
} from '../types/index.js';

export { ConductorAppError, isConductorAppError } from '../types/errors.js';
