import { NextRequest } from "next/server";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "test-secret";

export function createMockRequest(options: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: any;
  token?: string;
} = {}): NextRequest {
  const {
    method = "GET",
    url = "http://localhost:6152/api/test",
    headers = {},
    body,
    token,
  } = options;

  const allHeaders = new Headers(headers);
  if (token) {
    allHeaders.set("Authorization", `Bearer ${token}`);
  }
  if (body) {
    allHeaders.set("Content-Type", "application/json");
  }

  const request = new NextRequest(url, {
    method,
    headers: allHeaders,
    body: body ? JSON.stringify(body) : undefined,
  });

  return request;
}

export function createTestToken(userId: string): string {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: "1h" });
}

export async function extractJson(response: Response) {
  return await response.json();
}
