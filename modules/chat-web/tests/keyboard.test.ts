import { describe, expect, it } from "vitest";

import { planMultilineTyping } from "../src/core/keyboard.js";

describe("planMultilineTyping", () => {
  it("returns a single type action for single-line text", () => {
    expect(planMultilineTyping("hello world")).toEqual([
      { type: "type", text: "hello world" },
    ]);
  });

  it("emits Shift+Enter between segments so the composer doesn't submit early", () => {
    expect(planMultilineTyping("line1\nline2\nline3")).toEqual([
      { type: "type", text: "line1" },
      { type: "press", key: "Shift+Enter" },
      { type: "type", text: "line2" },
      { type: "press", key: "Shift+Enter" },
      { type: "type", text: "line3" },
    ]);
  });

  it("never emits a bare Enter (which would submit ChatGPT's ProseMirror)", () => {
    const actions = planMultilineTyping("a\nb\nc\nd");
    for (const action of actions) {
      if (action.type === "press") {
        expect(action.key).toBe("Shift+Enter");
        expect(action.key).not.toBe("Enter");
      }
    }
  });

  it("handles CRLF line endings", () => {
    expect(planMultilineTyping("a\r\nb")).toEqual([
      { type: "type", text: "a" },
      { type: "press", key: "Shift+Enter" },
      { type: "type", text: "b" },
    ]);
  });

  it("handles bare CR line endings", () => {
    expect(planMultilineTyping("a\rb")).toEqual([
      { type: "type", text: "a" },
      { type: "press", key: "Shift+Enter" },
      { type: "type", text: "b" },
    ]);
  });

  it("preserves consecutive blank lines as paired Shift+Enter presses", () => {
    expect(planMultilineTyping("a\n\nb")).toEqual([
      { type: "type", text: "a" },
      { type: "press", key: "Shift+Enter" },
      { type: "press", key: "Shift+Enter" },
      { type: "type", text: "b" },
    ]);
  });

  it("returns [] for empty string", () => {
    expect(planMultilineTyping("")).toEqual([]);
  });

  it("returns a single Shift+Enter for a lone newline", () => {
    expect(planMultilineTyping("\n")).toEqual([
      { type: "press", key: "Shift+Enter" },
    ]);
  });

  it("regression: ATLAS-shape multi-line prompt produces 0 bare Enter presses", () => {
    // This is structurally the prompt from task 09b34cf4-…, which used
    // to be submitted as 5 separate fragments because keyboard.type(\\n)
    // fired bare Enter into ChatGPT's ProseMirror.
    const prompt = [
      "我想和你讨论这篇 arXiv 论文：《ATLAS: Agentic or Latent Visual Reasoning? One Word is Enough for Both》。",
      "HTML 全文：https://arxiv.org/html/2605.15198",
      "PDF：https://arxiv.org/pdf/2605.15198v1",
      "arXiv 摘要页：https://arxiv.org/abs/2605.15198",
      "作者：Ziyu Guo, Rain Liu, Xinyan Chen, Pheng-Ann Heng",
      "",
      "需要时请基于 HTML 全文回答，不确定就说不知道，不要编实验数值或结论。",
    ].join("\n");

    const actions = planMultilineTyping(prompt);
    const types = actions.filter((a) => a.type === "type");
    const presses = actions.filter((a) => a.type === "press");

    // 6 non-empty segments + 1 blank line.
    expect(types).toHaveLength(6);
    // 6 newlines in the source → 6 line-break presses.
    expect(presses).toHaveLength(6);
    // EVERY press must be Shift+Enter, never bare Enter.
    for (const press of presses) {
      expect(press.key).toBe("Shift+Enter");
    }
  });
});
