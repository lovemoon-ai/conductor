import { describe, expect, it } from "vitest";

import { signTransferToken, verifyTransferToken } from "./transfer-token";

const claims = {
  transferId: "t-1",
  agentHost: "ubuntu",
  purpose: "pull" as const,
};

describe("transfer token", () => {
  it("round-trips its own claims", () => {
    expect(verifyTransferToken(signTransferToken(claims), claims)).toBe(true);
  });

  it("rejects a token minted for a different transfer, host, or purpose", () => {
    const token = signTransferToken(claims);
    expect(verifyTransferToken(token, { ...claims, transferId: "t-2" })).toBe(false);
    expect(verifyTransferToken(token, { ...claims, agentHost: "other" })).toBe(false);
    // The pull/push split is what stops a daemon from turning a read
    // capability into a write one against the same staged transfer.
    expect(verifyTransferToken(token, { ...claims, purpose: "push" })).toBe(false);
  });

  it("rejects a tampered payload and a malformed token", () => {
    const token = signTransferToken(claims);
    const [, signature] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...claims, purpose: "push", exp: Date.now() + 60_000 }),
    ).toString("base64url");
    expect(verifyTransferToken(`${forged}.${signature}`, { ...claims, purpose: "push" })).toBe(false);
    expect(verifyTransferToken("", claims)).toBe(false);
    expect(verifyTransferToken("no-dot", claims)).toBe(false);
  });

  it("expires, unlike the attachment token it was modelled on", () => {
    const expired = signTransferToken(claims, -1_000);
    expect(verifyTransferToken(expired, claims)).toBe(false);
    expect(verifyTransferToken(signTransferToken(claims, 60_000), claims)).toBe(true);
  });
});
