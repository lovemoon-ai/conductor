import { writeFileSync } from "node:fs";

/** Build a fake codex auth.json fixture with an id_token carrying the given claims. */
export function makeAuthJson(opts: {
  email?: string;
  accountId?: string;
  planType?: string;
  accessToken?: string;
  refreshToken?: string;
  lastRefresh?: string;
}): string {
  const payload = {
    email: opts.email,
    name: "Test User",
    sub: "google-oauth2|123",
    user_id: "user-test",
    "https://api.openai.com/auth": {
      chatgpt_account_id: opts.accountId,
      chatgpt_plan_type: opts.planType ?? "plus",
    },
  };
  const header = { alg: "none", typ: "JWT" };
  const b64 = (o: any) =>
    Buffer.from(JSON.stringify(o))
      .toString("base64")
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
  const idToken = `${b64(header)}.${b64(payload)}.sig`;
  return JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: idToken,
      access_token: opts.accessToken ?? "at_" + Math.random().toString(36).slice(2).padEnd(40, "x"),
      refresh_token: opts.refreshToken ?? "rt_test",
      account_id: opts.accountId,
    },
    last_refresh: opts.lastRefresh ?? "2026-04-10T02:28:11.655623598Z",
  });
}

export function writeAuthJson(
  path: string,
  opts: Parameters<typeof makeAuthJson>[0],
): void {
  writeFileSync(path, makeAuthJson(opts));
}
