/**
 * Typed error classes used across chat-web.
 *
 * Each subclass carries a `code` field (machine-friendly) and a `hint`
 * field (human-friendly next action), so CLI / daemon callers can both
 * branch on the code and surface a useful remediation step.
 */
export type ChatWebErrorCode =
  | "NOT_LOGGED_IN"
  | "INPUT_NOT_FOUND"
  | "SEND_BUTTON_NOT_FOUND"
  | "RESPONSE_TIMEOUT"
  | "RESPONSE_EXTRACTION"
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_CAPTCHA"
  | "PROVIDER_API_KEY_REQUIRED"
  | "PROVIDER_PERMISSION_DENIED"
  | "PROVIDER_AUTOMATION_BLOCKED"
  | "SELECTOR_VERIFICATION"
  | "UNKNOWN_PROVIDER"
  | "PROFILE_ERROR"
  | "BROWSER_LAUNCH_FAILED";

export class ChatWebError extends Error {
  readonly code: ChatWebErrorCode;
  readonly hint?: string;
  readonly provider?: string;

  constructor(
    code: ChatWebErrorCode,
    message: string,
    options: { hint?: string; provider?: string; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "ChatWebError";
    this.code = code;
    this.hint = options.hint;
    this.provider = options.provider;
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

export class NotLoggedInError extends ChatWebError {
  constructor(provider: string) {
    super("NOT_LOGGED_IN", `Provider "${provider}" is not logged in.`, {
      provider,
      hint: `Run: chat-web login ${provider}`,
    });
    this.name = "NotLoggedInError";
  }
}

export class InputNotFoundError extends ChatWebError {
  constructor(provider: string) {
    super("INPUT_NOT_FOUND", `Could not locate the input box for "${provider}".`, {
      provider,
      hint: `Run: chat-web doctor ${provider} --snapshot`,
    });
    this.name = "InputNotFoundError";
  }
}

export class SendButtonNotFoundError extends ChatWebError {
  constructor(provider: string) {
    super("SEND_BUTTON_NOT_FOUND", `Could not locate the send button for "${provider}".`, {
      provider,
      hint: `Run: chat-web doctor ${provider} --snapshot`,
    });
    this.name = "SendButtonNotFoundError";
  }
}

export class ResponseTimeoutError extends ChatWebError {
  constructor(provider: string, timeoutMs: number) {
    super(
      "RESPONSE_TIMEOUT",
      `Timed out after ${timeoutMs}ms waiting for "${provider}" response.`,
      {
        provider,
        hint: `Try: chat-web ask ${provider} --timeout ${timeoutMs * 2} "..."`,
      },
    );
    this.name = "ResponseTimeoutError";
  }
}

export class ResponseExtractionError extends ChatWebError {
  constructor(provider: string, message = "Failed to extract assistant message.") {
    super("RESPONSE_EXTRACTION", message, {
      provider,
      hint: `Run: chat-web doctor ${provider} --snapshot`,
    });
    this.name = "ResponseExtractionError";
  }
}

export class ProviderRateLimitedError extends ChatWebError {
  constructor(provider: string) {
    super("PROVIDER_RATE_LIMITED", `Provider "${provider}" appears to be rate limiting us.`, {
      provider,
      hint: "Slow down request rate, or wait a few minutes before retrying.",
    });
    this.name = "ProviderRateLimitedError";
  }
}

export class ProviderCaptchaError extends ChatWebError {
  constructor(provider: string) {
    super("PROVIDER_CAPTCHA", `Provider "${provider}" is requesting human verification.`, {
      provider,
      hint: `Run: chat-web login ${provider} and pass the verification flow in the headed browser.`,
    });
    this.name = "ProviderCaptchaError";
  }
}

export class ProviderApiKeyRequiredError extends ChatWebError {
  constructor(provider: string, detail?: string) {
    const base = `Provider "${provider}" needs an API key configured in its web console.`;
    super("PROVIDER_API_KEY_REQUIRED", detail ? `${base} ${detail}` : base, {
      provider,
      hint:
        provider === "gemini"
          ? "Open https://aistudio.google.com/app/apikey, create a key, then in AI Studio click the 'Get API key' / 'No API key selected' button and select that key."
          : `Configure an API key for ${provider} in its web console.`,
    });
    this.name = "ProviderApiKeyRequiredError";
  }
}

export class ProviderAutomationBlockedError extends ChatWebError {
  constructor(provider: string, detail?: string) {
    const base =
      `Provider "${provider}" appears to be blocking automated access ` +
      "(model invocation never started after the input was submitted; the page sits on 'Thinking' indefinitely).";
    super(
      "PROVIDER_AUTOMATION_BLOCKED",
      detail ? `${base} ${detail}` : base,
      {
        provider,
        hint:
          provider === "gemini"
            ? "Google AI Studio runs an anti-abuse challenge (WAA) before invoking the model. " +
              "Headless / scripted browsers routinely fail this challenge silently. " +
              "Workarounds: (1) use chat-web's `chatgpt` provider instead — ChatGPT is far more permissive of automation; " +
              "(2) call the Gemini API directly with an API key from https://aistudio.google.com/app/apikey (outside chat-web); " +
              "(3) try again later — the challenge sometimes passes."
            : "The provider's anti-bot system is silently blocking model invocation. Try a different provider.",
      },
    );
    this.name = "ProviderAutomationBlockedError";
  }
}

export class ProviderPermissionDeniedError extends ChatWebError {
  constructor(provider: string, detail?: string) {
    const base = `Provider "${provider}" denied the request (permission denied).`;
    super("PROVIDER_PERMISSION_DENIED", detail ? `${base} ${detail}` : base, {
      provider,
      hint:
        "Common causes: missing/invalid API key, model not enabled on the account, region restriction, quota exhausted. Open the provider's web console to inspect.",
    });
    this.name = "ProviderPermissionDeniedError";
  }
}

export class SelectorVerificationError extends ChatWebError {
  constructor(provider: string, what: string) {
    super(
      "SELECTOR_VERIFICATION",
      `Selector verification failed for "${provider}" while probing ${what}.`,
      {
        provider,
        hint: `Run: chat-web doctor ${provider} --snapshot`,
      },
    );
    this.name = "SelectorVerificationError";
  }
}

export class UnknownProviderError extends ChatWebError {
  constructor(provider: string, known: readonly string[]) {
    super(
      "UNKNOWN_PROVIDER",
      `Unknown provider "${provider}". Known providers: ${known.join(", ")}`,
      { provider, hint: `Use one of: ${known.join(", ")}` },
    );
    this.name = "UnknownProviderError";
  }
}

export class ProfileError extends ChatWebError {
  constructor(provider: string, message: string, cause?: unknown) {
    super("PROFILE_ERROR", message, { provider, cause });
    this.name = "ProfileError";
  }
}

export class BrowserLaunchError extends ChatWebError {
  constructor(provider: string, message: string, cause?: unknown) {
    super("BROWSER_LAUNCH_FAILED", message, {
      provider,
      cause,
      hint: "Check Playwright install: `npx playwright install chromium`",
    });
    this.name = "BrowserLaunchError";
  }
}
