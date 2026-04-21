class FakeExternalSession {
  constructor(backend, options = {}) {
    this.backend = backend;
    this.options = options;
    this.closed = false;
    this.currentTurn = null;
  }

  getSnapshot() {
    return {
      backend: this.backend,
      provider: "fake-external-provider",
      sessionId: this.options.resumeSessionId || undefined,
      useSessionFileReplyStream: true,
    };
  }

  async ensureSessionInfo() {
    return {
      backend: this.backend,
      sessionId: this.options.resumeSessionId || "external-session-1",
    };
  }

  async getSessionUsageSummary() {
    return {
      sessionId: this.options.resumeSessionId || "external-session-1",
      sessionFilePath: undefined,
      totalCostUsd: undefined,
      tokenUsagePercent: undefined,
      contextUsagePercent: undefined,
      usage: null,
      modelUsage: null,
      rateLimits: null,
      manualResume: {
        ready: true,
        command: `external --resume ${this.options.resumeSessionId || "external-session-1"}`,
      },
    };
  }

  setSessionMessageHandler() {}

  setWorkingStatusHandler() {}

  setSessionReplyTarget() {}

  async interruptCurrentTurn() {
    if (!this.currentTurn) {
      return false;
    }
    const { reject } = this.currentTurn;
    this.currentTurn = null;
    const error = new Error("external turn interrupted");
    error.reason = "turn_interrupted";
    reject(error);
    return true;
  }

  async runTurn(promptText) {
    if (promptText.includes("[wait-for-interrupt]")) {
      return await new Promise((resolve, reject) => {
        this.currentTurn = { resolve, reject };
      });
    }
    return {
      text: `external:${promptText}`,
      usage: null,
      items: [],
      events: [],
      provider: this.backend,
      metadata: {
        source: "fake-external-provider",
        sessionId: this.options.resumeSessionId || "external-session-1",
      },
    };
  }

  async close() {
    await this.interruptCurrentTurn();
    this.closed = true;
  }
}

export const providers = [
  {
    backend: "test-external",
    aliases: ["test-external-alias"],
    variant: "fake-external-provider",
    async createSession(backend, options) {
      return new FakeExternalSession(backend, options);
    },
  },
];
