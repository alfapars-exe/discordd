import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  prefs: { ttsEnabled: true, ttsRate: 1.4 },
  spoken: [] as Array<{ text: string; rate: number; lang: string }>,
}));

vi.mock("../stores/accessibilityStore", () => ({
  useAccessibilityStore: { getState: () => h.prefs },
}));
vi.mock("../i18n", () => ({ default: { language: "tr" } }));

class FakeUtterance {
  rate = 1;
  lang = "";
  text: string;
  constructor(text: string) { this.text = text; }
}

import { previewTextToSpeech, supportsTextToSpeech, speakIncomingMessage, speakMessage } from "./textToSpeech";

beforeEach(() => {
  h.prefs = { ttsEnabled: true, ttsRate: 1.4 };
  h.spoken = [];
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
  Object.defineProperty(window, "speechSynthesis", {
    configurable: true,
    value: { speak: (value: FakeUtterance) => h.spoken.push({ text: value.text, rate: value.rate, lang: value.lang }) },
  });
});

describe("speakIncomingMessage", () => {
  it("speaks incoming text using the account rate and language while hiding URLs", () => {
    expect(speakIncomingMessage("Ayşe", "bak https://example.test/gizli şimdi")).toBe(true);
    expect(h.spoken).toEqual([{ text: "Ayşe: bak link şimdi", rate: 1.4, lang: "tr-TR" }]);
  });

  it("does nothing when TTS is disabled or no plaintext is available", () => {
    h.prefs.ttsEnabled = false;
    expect(speakIncomingMessage("Ayşe", "merhaba")).toBe(false);
    h.prefs.ttsEnabled = true;
    expect(speakIncomingMessage("Ayşe", null)).toBe(false);
    expect(h.spoken).toHaveLength(0);
  });
  it("allows explicit reading without enabling automatic incoming reading", () => {
    h.prefs.ttsEnabled = false;
    expect(speakMessage("QA", "read this message")).toBe(true);
    expect(speakIncomingMessage("QA", "do not read automatically")).toBe(false);
    expect(h.spoken).toEqual([{ text: "QA: read this message", rate: 1.4, lang: "tr-TR" }]);
  });
  it("reads full manual message text while bounding automatic announcements", () => {
    const text = "a".repeat(800);
    speakMessage("", text); speakIncomingMessage("", text);
    expect(h.spoken.map((entry) => entry.text.length)).toEqual([800, 500]);
  });
  it("reports synchronous speech engine failures instead of throwing", () => {
    vi.spyOn(window.speechSynthesis, "speak").mockImplementation(() => { throw new Error("unavailable"); });
    expect(speakMessage("QA", "hello")).toBe(false);
  });
});


describe("TTS preview", () => {
  it("replaces queued speech with the saved rate and message language", () => {
    const cancel = vi.fn();
    Object.assign(window.speechSynthesis, { cancel });
    h.prefs.ttsEnabled = false;
    expect(previewTextToSpeech("Önizleme")).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    expect(h.spoken).toEqual([{ text: "Önizleme", rate: 1.4, lang: "tr-TR" }]);
  });
  it("disables unsupported engines and contains cancellation failures", () => {
    vi.stubGlobal("SpeechSynthesisUtterance", undefined);
    expect(supportsTextToSpeech()).toBe(false);
    expect(previewTextToSpeech("hello")).toBe(false);
    vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
    Object.assign(window.speechSynthesis, { cancel: () => { throw new Error("unavailable"); } });
    expect(previewTextToSpeech("hello")).toBe(false);
    expect(h.spoken).toEqual([]);
  });
});
