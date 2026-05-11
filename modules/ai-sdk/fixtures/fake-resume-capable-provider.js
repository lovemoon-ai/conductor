class FakeResumeCapableSession {
  constructor(backend, options = {}) {
    this.backend = backend;
    this.options = options;
    this.closed = false;
  }

  getSnapshot() {
    return {
      backend: this.backend,
      provider: "fake-resume-capable-provider",
      sessionId: this.options.resumeSessionId || undefined,
      useSessionFileReplyStream: true,
    };
  }

  setSessionMessageHandler() {}
  setWorkingStatusHandler() {}
  setSessionReplyTarget() {}

  async ensureSessionInfo() {
    return {
      backend: this.backend,
      sessionId: this.options.resumeSessionId || "resume-capable-session-1",
    };
  }

  async getSessionUsageSummary() {
    return {
      sessionId: this.options.resumeSessionId || "resume-capable-session-1",
      usage: null,
      modelUsage: null,
      rateLimits: null,
    };
  }

  async interruptCurrentTurn() {
    return false;
  }

  async runTurn(promptText) {
    return {
      text: `resume-capable:${promptText}`,
      usage: null,
      items: [],
      events: [],
      provider: this.backend,
      metadata: { source: "fake-resume-capable-provider" },
    };
  }

  async close() {
    this.closed = true;
  }
}

export const providers = [
  {
    backend: "resume-capable-external",
    aliases: ["resume-capable-alias"],
    variant: "fake-resume-capable-provider",
    async createSession(backend, options) {
      return new FakeResumeCapableSession(backend, options);
    },
    async resolveResumeContext(sessionId, options = {}) {
      const cwd =
        typeof options?.cwd === "string" && options.cwd.trim()
          ? options.cwd.trim()
          : process.cwd();
      return {
        provider: "resume-capable-external",
        sessionId,
        sessionPath: null,
        cwd,
        debugMetadata: {
          cwdSource: "fake-resume-capable-provider",
          sessionPath: null,
        },
      };
    },
  },
];
