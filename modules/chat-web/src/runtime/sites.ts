import type { SiteDefinition } from "./types.js";

export const runtimeSites: SiteDefinition[] = [
  {
    name: "chatgpt", homeUrl: "https://chatgpt.com/",
    input: '#prompt-textarea[contenteditable="true"], #prompt-textarea',
    send: 'button[data-testid="send-button"], button[aria-label="Send prompt"], button#composer-submit-button',
    assistant: '[data-message-author-role="assistant"]',
    stop: 'button[data-testid="stop-button"], button[aria-label*="Stop generating" i], button[aria-label="Stop streaming"]',
    conversationPath: "/c/([^/?#]+)",
    streamPath: "/backend-api/(?:[^/]+/)*conversation(?:\\?|$)",
    format: "chatgpt",
  },
  {
    name: "deepseek", homeUrl: "https://chat.deepseek.com/",
    deepThink: '.ds-toggle-button:has-text("DeepThink"), .ds-toggle-button:has-text("深度思考"), button[aria-label="DeepThink"], [role="switch"][aria-label="DeepThink"]',
    input: "textarea", send: 'button[aria-label*="send" i], button[aria-label*="发送"]',
    assistant: ".ds-markdown", stop: '[role="button"][aria-label*="stop" i], button[aria-label*="停止"], button[aria-label*="stop" i], [role="button"].ds-button--circle:has(svg path[d^="M2 4.88"])',
    conversationPath: "/(?:a/chat/s|chat)/([^/?#]+)",
    streamPath: "/api/v[0-9]+/chat/completion(?:\\?|$)", format: "deepseek",
  },
  {
    name: "kimi", homeUrl: "https://www.kimi.com/",
    input: '[contenteditable="true"][role="textbox"], .chat-input-editor[contenteditable="true"], textarea',
    send: 'button[aria-label*="send" i], button[aria-label*="发送"], .send-button, .send-button-container:not(.stop):not(.disabled)',
    assistant: ".segment-assistant .markdown:not(.toolcall-container .markdown):not(.thinking-container .markdown), [data-role=assistant]",
    stop: 'button[aria-label*="stop" i], button[aria-label*="停止"], .stop-button, .send-button-container.stop',
    conversationPath: "/chat/([^/?#]+)",
    streamPath: "/(?:api/chat/[^/]+/completion/stream|apiv2/kimi\\.gateway\\.chat\\.v1\\.ChatService/Chat)(?:\\?|$)", format: "kimi", experimental: true,
  },
  {
    name: "claude", homeUrl: "https://claude.ai/new",
    input: '[contenteditable="true"].ProseMirror, [contenteditable="true"][role="textbox"]',
    send: 'button[aria-label="Send message"], button[aria-label="Send Message"]',
    assistant: '[data-is-streaming] .font-claude-message, .font-claude-message',
    stop: 'button[aria-label*="Stop" i]',
    conversationPath: "/chat/([^/?#]+)",
    streamPath: "/api/organizations/[^/]+/chat_conversations/[^/]+/completion", format: "claude", experimental: true,
  },
];
