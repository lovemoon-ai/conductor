import { describe, expect, it } from "vitest";

import {
  pickBest,
  scoreAssistantMessageCandidate,
  scoreInputCandidate,
  scoreSendButtonCandidate,
  type ElementDescriptor,
} from "../src/core/locator-score.js";

describe("scoreInputCandidate", () => {
  it("prefers a visible textarea with a Message placeholder over a hidden one", () => {
    const good: ElementDescriptor = {
      tag: "textarea",
      role: null,
      placeholder: "Message ChatGPT",
      visible: true,
      editable: true,
      enabled: true,
      viewportY: 0.9,
    };
    const hidden: ElementDescriptor = {
      tag: "textarea",
      role: null,
      placeholder: "Search",
      visible: false,
      editable: false,
      enabled: false,
    };
    expect(scoreInputCandidate(good)).toBeGreaterThan(scoreInputCandidate(hidden));
  });

  it("recognises Chinese hints", () => {
    const cn: ElementDescriptor = {
      tag: "textarea",
      placeholder: "给 DeepSeek 发送消息",
      visible: true,
      editable: true,
      enabled: true,
    };
    expect(scoreInputCandidate(cn)).toBeGreaterThan(8);
  });

  it("penalises elements in sidebars", () => {
    const sidebar: ElementDescriptor = {
      tag: "textarea",
      placeholder: "Message",
      visible: true,
      editable: true,
      enabled: true,
      inAuxiliaryRegion: true,
    };
    const main: ElementDescriptor = { ...sidebar, inAuxiliaryRegion: false };
    expect(scoreInputCandidate(main)).toBeGreaterThan(scoreInputCandidate(sidebar));
  });
});

describe("scoreSendButtonCandidate", () => {
  it("prefers enabled buttons near the input", () => {
    const near: ElementDescriptor = {
      tag: "button",
      ariaLabel: "Send prompt",
      visible: true,
      enabled: true,
      distanceToInput: 50,
    };
    const far: ElementDescriptor = {
      ...near,
      distanceToInput: 800,
    };
    expect(scoreSendButtonCandidate(near)).toBeGreaterThan(scoreSendButtonCandidate(far));
  });
});

describe("scoreAssistantMessageCandidate", () => {
  it("ranks data-message-author-role=assistant above generic prose", () => {
    const explicit: ElementDescriptor = {
      tag: "div",
      authorRole: "assistant",
      insideMainConversation: true,
      containsProse: true,
    };
    const guess: ElementDescriptor = {
      tag: "div",
      containsProse: true,
    };
    expect(scoreAssistantMessageCandidate(explicit)).toBeGreaterThan(
      scoreAssistantMessageCandidate(guess),
    );
  });

  it("penalises history/sidebar nodes", () => {
    const sidebar: ElementDescriptor = {
      tag: "div",
      authorRole: "assistant",
      inHistory: true,
    };
    const main: ElementDescriptor = {
      tag: "div",
      authorRole: "assistant",
      insideMainConversation: true,
    };
    expect(scoreAssistantMessageCandidate(main)).toBeGreaterThan(
      scoreAssistantMessageCandidate(sidebar),
    );
  });
});

describe("pickBest", () => {
  it("returns the highest-scoring item, preferring the first on ties", () => {
    const items: ElementDescriptor[] = [
      { tag: "textarea", visible: true, editable: true, enabled: true },
      { tag: "textarea", visible: true, editable: true, enabled: true, placeholder: "Message" },
      { tag: "input", visible: true, editable: true, enabled: true },
    ];
    const best = pickBest(items, scoreInputCandidate);
    expect(best).toBe(items[1]);
  });

  it("returns null for empty input", () => {
    expect(pickBest([] as ElementDescriptor[], scoreInputCandidate)).toBeNull();
  });
});
