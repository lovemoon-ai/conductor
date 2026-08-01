import { createHmac, timingSafeEqual } from "node:crypto";

type TransferClaims = { taskId: string; attachmentId: string; agentHost: string };

function secret(): string {
  const value = process.env.ATTACHMENT_TRANSFER_SECRET || process.env.JWT_SECRET;
  if (value) return value;
  if (process.env.NODE_ENV === "production") throw new Error("ATTACHMENT_TRANSFER_SECRET or JWT_SECRET is required");
  return "conductor-development-attachment-transfer-secret";
}

export function signAttachmentTransferToken(claims: TransferClaims): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", secret()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyAttachmentTransferToken(token: string, expected: TransferClaims): boolean {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return false;
  const actual = Buffer.from(signature, "base64url");
  const wanted = createHmac("sha256", secret()).update(payload).digest();
  if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) return false;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as TransferClaims;
    return claims.taskId === expected.taskId
      && claims.attachmentId === expected.attachmentId
      && claims.agentHost === expected.agentHost;
  } catch {
    return false;
  }
}
