import { RemoteAgentSession } from "./remote-agent-session.js";

export class ClaudeRemoteSession extends RemoteAgentSession {
  constructor(_backend = "claude-remote", options = {}) {
    super("claude-remote", options);
  }
}

