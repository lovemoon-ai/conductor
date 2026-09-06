import { createHmac, timingSafeEqual } from "node:crypto";

export type TransferTokenPurpose = "pull" | "push";

export type TransferTokenClaims = {
  transferId: string;
  agentHost: string;
  purpose: TransferTokenPurpose;
};

type SignedClaims = TransferTokenClaims & { exp: number };

/** RFC 0037: unlike the attachment token, this one expires. 15 minutes covers
 *  the staging TTL plus the daemon's own 300s transfer budget. */
const DEFAULT_TTL_MS = 15 * 60 * 1000;

function secret(): string {
  const value = process.env.ATTACHMENT_TRANSFER_SECRET || process.env.JWT_SECRET;
  if (value) return value;
  if (process.env.NODE_ENV === "production") throw new Error("ATTACHMENT_TRANSFER_SECRET or JWT_SECRET is required");
  return "conductor-development-attachment-transfer-secret";
}

export function signTransferToken(claims: TransferTokenClaims, ttlMs: number = DEFAULT_TTL_MS): string {
  const signed: SignedClaims = { ...claims, exp: Date.now() + ttlMs };
  const payload = Buffer.from(JSON.stringify(signed)).toString("base64url");
  const signature = createHmac("sha256", secret()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyTransferToken(token: string, expected: TransferTokenClaims): boolean {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return false;
  const actual = Buffer.from(signature, "base64url");
  const wanted = createHmac("sha256", secret()).update(payload).digest();
  if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) return false;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as SignedClaims;
    if (typeof claims.exp !== "number" || claims.exp <= Date.now()) return false;
    return claims.transferId === expected.transferId
      && claims.agentHost === expected.agentHost
      && claims.purpose === expected.purpose;
  } catch {
    return false;
  }
}
