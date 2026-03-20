import { describe, it, expect } from "vitest";
import { detectLangFromLocale } from "./i18n";

describe("detectLangFromLocale", () => {
  it("always resolves to English", () => {
    expect(detectLangFromLocale("ja-JP")).toBe("en");
    expect(detectLangFromLocale("zh-TW")).toBe("en");
    expect(detectLangFromLocale("es-ES")).toBe("en");
    expect(detectLangFromLocale(undefined)).toBe("en");
  });
});
