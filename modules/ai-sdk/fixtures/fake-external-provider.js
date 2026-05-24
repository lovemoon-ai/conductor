class FakeExternalSession {
  // Goal-capable for the existing client tests that exercise the proxy
  // capability snapshot.
  static capabilities = Object.freeze({ goal: true });

  constructor(backend, options = {}) {
    this.backend = backend;
    this.options = options;
    this.closed = false;
    this.currentTurn = null;
  }

  getCapabilities() {
    return { ...FakeExternalSession.capabilities };
  }

  getSnapshot() {
    return {
      backend: this.backend,
      provider: "fake-external-provider",
      sessionId: this.options.resumeSessionId || undefined,
      useSessionFileReplyStream: true,
      capabilities: this.getCapabilities(),
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

  async runGoal(goal, options = {}) {
    const objective = typeof goal === "object" && goal ? String(goal.objective || "") : "";
    if (typeof options.onProgress === "function") {
      options.onProgress({ phase: "goal_started", objective });
    }
    this.lastGoal = {
      objective,
      status: "complete",
      tokenBudget: goal && typeof goal === "object" ? goal.tokenBudget ?? null : null,
    };
    return {
      text: `external-goal:${objective}`,
      usage: null,
      items: [],
      events: [],
      provider: this.backend,
      goal: { ...this.lastGoal },
      metadata: {
        source: "fake-external-provider",
        goalSource: goal && typeof goal === "object" ? goal.source || null : null,
      },
    };
  }

  async getGoal() {
    return this.lastGoal ? { ...this.lastGoal } : null;
  }

  async clearGoal() {
    if (!this.lastGoal) {
      return false;
    }
    this.lastGoal = null;
    return true;
  }

  async close() {
    await this.interruptCurrentTurn();
    this.closed = true;
  }
}

// A second fake provider that explicitly does NOT support goal mode. Used by
// the client capability-detection tests to verify that the proxy honors
// `capabilities.goal === false` and throws `unsupported_goal` without paying
// an IPC round-trip.
class FakeNoGoalExternalSession {
  static capabilities = Object.freeze({ goal: false });

  constructor(backend, options = {}) {
    this.backend = backend;
    this.options = options;
    this.closed = false;
  }

  getCapabilities() {
    return { ...FakeNoGoalExternalSession.capabilities };
  }

  getSnapshot() {
    return {
      backend: this.backend,
      provider: "fake-no-goal-external-provider",
      sessionId: this.options.resumeSessionId || undefined,
      useSessionFileReplyStream: true,
      capabilities: this.getCapabilities(),
    };
  }

  async ensureSessionInfo() {
    return {
      backend: this.backend,
      sessionId: this.options.resumeSessionId || "no-goal-session-1",
    };
  }

  async getSessionUsageSummary() {
    return {
      sessionId: this.options.resumeSessionId || "no-goal-session-1",
      sessionFilePath: undefined,
      usage: null,
      rateLimits: null,
      manualResume: { ready: true, command: `no-goal --resume ${this.options.resumeSessionId || "no-goal-session-1"}` },
    };
  }

  setSessionMessageHandler() {}
  setWorkingStatusHandler() {}
  setSessionReplyTarget() {}

  async runTurn(promptText) {
    return {
      text: `no-goal:${promptText}`,
      usage: null,
      items: [],
      events: [],
      provider: this.backend,
      metadata: { source: "fake-no-goal-external-provider" },
    };
  }

  // Intentionally still exposes runGoal so we can verify capability gating
  // wins over method-presence detection.
  async runGoal() {
    throw new Error("this fixture should never actually run a goal");
  }

  async close() {
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
  {
    backend: "test-external-no-goal",
    variant: "fake-no-goal-external-provider",
    async createSession(backend, options) {
      return new FakeNoGoalExternalSession(backend, options);
    },
  },
];
