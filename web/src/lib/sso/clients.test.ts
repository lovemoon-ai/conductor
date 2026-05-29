import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertRedirectUri,
  getSsoClient,
  listSsoClients,
  parseSsoClientsJson,
  resetSsoClientRegistryForTesting,
  verifyClientSecret,
} from "./clients";
import { hashSecret } from "@/lib/auth/service";

describe("parseSsoClientsJson", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("parses a valid array", () => {
    const json = JSON.stringify([
      {
        client_id: "arxiv-radar",
        display_name: "arxiv-radar",
        client_secret: "secret-value",
        redirect_uris: ["https://example.com/cb"],
        trusted: true,
      },
    ]);
    const registry = parseSsoClientsJson(json);
    expect(registry.size).toBe(1);
    const client = registry.get("arxiv-radar");
    expect(client?.displayName).toBe("arxiv-radar");
    expect(client?.redirectUris).toEqual(["https://example.com/cb"]);
    expect(client?.trusted).toBe(true);
    expect(client?.clientSecret).toBe("secret-value");
  });

  it("returns empty registry for invalid JSON", () => {
    expect(parseSsoClientsJson("not-json").size).toBe(0);
  });

  it("returns empty registry when not an array", () => {
    expect(parseSsoClientsJson("{}").size).toBe(0);
  });

  it("skips entries missing client_id or client_secret", () => {
    const json = JSON.stringify([
      { client_id: "ok", client_secret: "s", redirect_uris: ["https://x"] },
      { client_id: "no-secret", redirect_uris: ["https://x"] },
      { client_secret: "s", redirect_uris: ["https://y"] },
      "not-an-object",
    ]);
    const registry = parseSsoClientsJson(json);
    expect(registry.size).toBe(1);
    expect(registry.has("ok")).toBe(true);
  });

  it("accepts an entry with no redirect_uris (uses no allowlist)", () => {
    const json = JSON.stringify([
      {
        client_id: "loose",
        client_secret: "s",
      },
    ]);
    const registry = parseSsoClientsJson(json);
    expect(registry.size).toBe(1);
    expect(registry.get("loose")?.redirectUris).toEqual([]);
  });

  it("dedupes by client_id, keeping the first occurrence", () => {
    const json = JSON.stringify([
      { client_id: "a", client_secret: "s", redirect_uris: ["https://first"] },
      { client_id: "a", client_secret: "s", redirect_uris: ["https://second"] },
    ]);
    const registry = parseSsoClientsJson(json);
    expect(registry.size).toBe(1);
    expect(registry.get("a")?.redirectUris).toEqual(["https://first"]);
  });
});

describe("assertRedirectUri", () => {
  it("requires exact match when allowlist is configured", () => {
    const client = {
      clientId: "x",
      displayName: "x",
      redirectUris: ["https://example.com/cb"],
      trusted: true,
    };
    expect(assertRedirectUri(client, "https://example.com/cb")).toBe(true);
    expect(assertRedirectUri(client, "https://example.com/cb/")).toBe(false);
    expect(assertRedirectUri(client, "https://example.com/cb?x=1")).toBe(false);
    expect(assertRedirectUri(client, "https://evil.example/cb")).toBe(false);
    expect(assertRedirectUri(client, null)).toBe(false);
    expect(assertRedirectUri(client, "")).toBe(false);
  });

  it("accepts any http(s) URI when redirectUris is empty (loose mode)", () => {
    const client = {
      clientId: "x",
      displayName: "x",
      redirectUris: [],
      trusted: true,
    };
    expect(assertRedirectUri(client, "https://arxiv-radar.example.com/cb")).toBe(true);
    expect(assertRedirectUri(client, "http://localhost:3000/api/auth/callback")).toBe(true);
    expect(assertRedirectUri(client, "https://anything.example/whatever?with=query")).toBe(true);
    // Still reject non-URL strings and non-http schemes.
    expect(assertRedirectUri(client, "javascript:alert(1)")).toBe(false);
    expect(assertRedirectUri(client, "ftp://example.com/")).toBe(false);
    expect(assertRedirectUri(client, "not a url")).toBe(false);
    expect(assertRedirectUri(client, null)).toBe(false);
    expect(assertRedirectUri(client, "")).toBe(false);
  });
});

describe("verifyClientSecret", () => {
  it("verifies plaintext client_secret", () => {
    const client = {
      clientId: "x",
      displayName: "x",
      redirectUris: ["https://x"],
      trusted: true,
      clientSecret: "topsecret",
    };
    expect(verifyClientSecret(client, "topsecret")).toBe(true);
    expect(verifyClientSecret(client, "wrong")).toBe(false);
    expect(verifyClientSecret(client, "")).toBe(false);
    expect(verifyClientSecret(client, null)).toBe(false);
  });

  it("verifies hashed client_secret_hash + salt", () => {
    const secret = "another-secret";
    const { hash, salt } = hashSecret(secret);
    const client = {
      clientId: "x",
      displayName: "x",
      redirectUris: ["https://x"],
      trusted: true,
      clientSecretHash: hash,
      clientSecretSalt: salt,
    };
    expect(verifyClientSecret(client, secret)).toBe(true);
    expect(verifyClientSecret(client, "wrong")).toBe(false);
  });
});

describe("env-driven registry", () => {
  const originalEnv = process.env.CONDUCTOR_SSO_CLIENTS_JSON;
  beforeEach(() => {
    resetSsoClientRegistryForTesting();
  });
  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CONDUCTOR_SSO_CLIENTS_JSON;
    } else {
      process.env.CONDUCTOR_SSO_CLIENTS_JSON = originalEnv;
    }
    resetSsoClientRegistryForTesting();
  });

  it("returns null when env is missing", () => {
    delete process.env.CONDUCTOR_SSO_CLIENTS_JSON;
    resetSsoClientRegistryForTesting();
    expect(getSsoClient("anything")).toBeNull();
    expect(listSsoClients()).toEqual([]);
  });

  it("loads client config from env", () => {
    process.env.CONDUCTOR_SSO_CLIENTS_JSON = JSON.stringify([
      {
        client_id: "arxiv-radar",
        display_name: "arxiv-radar",
        client_secret: "abc",
        redirect_uris: ["http://localhost:3000/cb"],
        trusted: true,
      },
    ]);
    resetSsoClientRegistryForTesting();
    const client = getSsoClient("arxiv-radar");
    expect(client).not.toBeNull();
    expect(listSsoClients().length).toBe(1);
  });

  it("loads a minimal client (id + display_name + client_secret only)", () => {
    process.env.CONDUCTOR_SSO_CLIENTS_JSON = JSON.stringify([
      {
        client_id: "arxiv-radar",
        display_name: "arxiv-radar",
        client_secret: "abc",
      },
    ]);
    resetSsoClientRegistryForTesting();
    const client = getSsoClient("arxiv-radar");
    expect(client).not.toBeNull();
    expect(client?.redirectUris).toEqual([]);
  });
});
