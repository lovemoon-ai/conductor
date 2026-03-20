export const JWT_STORAGE_KEY = "conductor.jwt";
export const ATTACHMENT_AUTH_COOKIE_NAME = "conductor_attachment_jwt";

const ATTACHMENT_AUTH_COOKIE_PATH = "/api/tasks";
const ATTACHMENT_AUTH_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

function attachmentCookieSuffix() {
  if (typeof window !== "undefined" && window.location.protocol === "https:") {
    return "; Secure";
  }
  return "";
}

export function syncAttachmentAuthCookie(token: string | null | undefined): void {
  if (typeof document === "undefined") {
    return;
  }

  const normalizedToken = typeof token === "string" ? token.trim() : "";
  if (normalizedToken) {
    document.cookie =
      `${ATTACHMENT_AUTH_COOKIE_NAME}=${normalizedToken}; Path=${ATTACHMENT_AUTH_COOKIE_PATH}; ` +
      `Max-Age=${ATTACHMENT_AUTH_COOKIE_MAX_AGE_SECONDS}; SameSite=Strict${attachmentCookieSuffix()}`;
    return;
  }

  document.cookie =
    `${ATTACHMENT_AUTH_COOKIE_NAME}=; Path=${ATTACHMENT_AUTH_COOKIE_PATH}; ` +
    `Max-Age=0; SameSite=Strict${attachmentCookieSuffix()}`;
}

export function getStoredJwtToken(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  const token = window.localStorage.getItem(JWT_STORAGE_KEY);
  return typeof token === "string" && token.trim() ? token : null;
}

export function storeJwtToken(token: string): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(JWT_STORAGE_KEY, token);
  syncAttachmentAuthCookie(token);
}

export function clearStoredJwtToken(): void {
  if (typeof window !== "undefined") {
    window.localStorage.removeItem(JWT_STORAGE_KEY);
  }
  syncAttachmentAuthCookie(null);
}
