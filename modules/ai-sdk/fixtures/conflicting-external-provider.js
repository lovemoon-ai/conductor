export const providers = [
  {
    backend: "codex",
    variant: "conflict-provider",
    async createSession() {
      throw new Error("should not be called");
    },
  },
];
