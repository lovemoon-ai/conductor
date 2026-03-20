import { describe, it, expect } from "vitest";
import { GET } from "@/app/api/health/route";
import { extractJson } from "@/__tests__/helpers";

describe("/api/health", () => {
  it("should return ok status", async () => {
    const response = await GET();
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.status).toBe("ok");
    expect(data.timestamp).toBeDefined();
  });

  it("should return valid ISO timestamp", async () => {
    const response = await GET();
    const data = await extractJson(response);

    const timestamp = new Date(data.timestamp);
    expect(timestamp.toISOString()).toBe(data.timestamp);
  });
});
