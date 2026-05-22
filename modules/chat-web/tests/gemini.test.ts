import { describe, expect, it } from "vitest";

import { stripChromeFromTurn } from "../src/providers/gemini.js";

describe("stripChromeFromTurn", () => {
  it("strips the model turn header and icon ligatures from a normal answer", () => {
    const raw = [
      "edit",
      "more_vert",
      "Model 5:54 PM",
      "Gemini 是 Google 开发的多模态大语言模型家族。",
      "content_copy",
      "thumb_up",
      "thumb_down",
    ].join("\n");
    expect(stripChromeFromTurn(raw)).toBe(
      "Gemini 是 Google 开发的多模态大语言模型家族。",
    );
  });

  it("keeps multi-line content while dropping chrome", () => {
    const raw = [
      "Model 9:01 AM",
      "error",
      "An internal error has occurred.",
      "content_copy",
    ].join("\n");
    expect(stripChromeFromTurn(raw)).toBe("An internal error has occurred.");
  });

  it("does not drop a line that merely contains a known ligature as a word", () => {
    // "error" alone on its own line is chrome; "an error occurred" is content.
    const raw = ["Model 1:23 PM", "an error occurred while parsing"].join("\n");
    expect(stripChromeFromTurn(raw)).toBe("an error occurred while parsing");
  });

  it("handles the 24-hour style header", () => {
    const raw = ["Model 14:05", "Hello"].join("\n");
    expect(stripChromeFromTurn(raw)).toBe("Hello");
  });

  it("returns empty when only chrome is present", () => {
    const raw = ["edit", "more_vert", "Model 5:54 PM", "content_copy"].join("\n");
    expect(stripChromeFromTurn(raw)).toBe("");
  });

  it("preserves intentional blank lines between paragraphs", () => {
    const raw = [
      "Model 5:54 PM",
      "Paragraph one.",
      "",
      "Paragraph two.",
      "content_copy",
    ].join("\n");
    expect(stripChromeFromTurn(raw)).toBe("Paragraph one.\n\nParagraph two.");
  });

  it("returns '' on empty input", () => {
    expect(stripChromeFromTurn("")).toBe("");
  });
});
