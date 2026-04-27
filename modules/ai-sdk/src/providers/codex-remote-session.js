import { RemoteAgentSession } from "./remote-agent-session.js";

export class CodexRemoteSession extends RemoteAgentSession {
  constructor(_backend = "codex-remote", options = {}) {
    super("codex-remote", options);
  }
}

