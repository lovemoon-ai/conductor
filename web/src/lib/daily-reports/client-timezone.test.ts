import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { getClientIpFromHeaders, resolveClientTimezone } from "./client-timezone";

const makeRequest = (headers: Record<string, string> = {}) =>
  new NextRequest("http://localhost:6152/api/user-preferences/daily-report", {
    headers,
  });

describe("client timezone resolution", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("uses timezone headers before IP lookup", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      resolveClientTimezone(makeRequest({ "x-client-timezone": "America/Los_Angeles" })),
    ).resolves.toBe("America/Los_Angeles");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("looks up timezone from the first public forwarded IP", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ timezone: "Europe/London" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      resolveClientTimezone(makeRequest({ "x-forwarded-for": "8.8.8.8, 10.0.0.1" })),
    ).resolves.toBe("Europe/London");
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://ipapi.co/8.8.8.8/json/",
      expect.objectContaining({
        headers: { Accept: "application/json, text/plain;q=0.9" },
      }),
    );
  });

  it("falls back when only local or private IPs are available", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    expect(getClientIpFromHeaders(new Headers({ "x-forwarded-for": "127.0.0.1" }))).toBeNull();
    await expect(
      resolveClientTimezone(makeRequest({ "x-forwarded-for": "192.168.1.10" })),
    ).resolves.toBe("Asia/Shanghai");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
