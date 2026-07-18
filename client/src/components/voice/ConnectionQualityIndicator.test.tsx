/**
 * ConnectionQualityIndicator — bar-count and silence-on-unknown contract.
 *
 * The "renders nothing when unknown" case is the important one: an absent
 * store entry is the normal state for the first seconds of every call, and
 * painting an empty (or worse, red) indicator there would tell users their
 * healthy connection is broken.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { vi } from "vitest";

import ConnectionQualityIndicator from "./ConnectionQualityIndicator";
import { useVoiceStore } from "../../stores/voiceStore";

vi.mock("../../api/voice", () => ({ getVoiceToken: vi.fn() }));
vi.mock("../../api/client", () => ({ ensureFreshToken: vi.fn() }));
vi.mock("../../utils/sounds", () => ({
  playJoinSound: vi.fn(),
  playLeaveSound: vi.fn(),
  closeAudioContext: vi.fn(),
}));
// t() returns the TR defaultValue the component passes, so these assertions
// pin the actual user-visible Turkish rather than a key name.
// initReactI18next is re-exported because pulling in the real voiceStore
// transitively loads src/i18n/index.ts, which calls .use(initReactI18next).
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, o?: { defaultValue?: string }) => o?.defaultValue ?? key,
  }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

/** Number of lit bars — the visual the user actually counts. */
function filledBars(container: HTMLElement): number {
  return container.querySelectorAll('[data-cq-bar="filled"]').length;
}

describe("ConnectionQualityIndicator", () => {
  beforeEach(() => {
    useVoiceStore.setState({ connectionQuality: {} });
  });

  it("renders nothing when the participant has no quality entry", () => {
    const { container } = render(<ConnectionQualityIndicator identity="u1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for a different participant's entry", () => {
    useVoiceStore.setState({ connectionQuality: { someoneElse: "poor" } });
    const { container } = render(<ConnectionQualityIndicator identity="u1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders 3 filled bars for excellent", () => {
    useVoiceStore.setState({ connectionQuality: { u1: "excellent" } });
    const { container } = render(<ConnectionQualityIndicator identity="u1" />);
    expect(filledBars(container)).toBe(3);
  });

  it("renders 2 filled bars for good", () => {
    useVoiceStore.setState({ connectionQuality: { u1: "good" } });
    const { container } = render(<ConnectionQualityIndicator identity="u1" />);
    expect(filledBars(container)).toBe(2);
  });

  it("renders 1 filled bar for poor", () => {
    useVoiceStore.setState({ connectionQuality: { u1: "poor" } });
    const { container } = render(<ConnectionQualityIndicator identity="u1" />);
    expect(filledBars(container)).toBe(1);
  });

  it("renders 0 filled bars for lost", () => {
    useVoiceStore.setState({ connectionQuality: { u1: "lost" } });
    const { container } = render(<ConnectionQualityIndicator identity="u1" />);
    expect(filledBars(container)).toBe(0);
    // Still renders the (empty, red) indicator — "lost" is information.
    expect(container).not.toBeEmptyDOMElement();
  });

  it("always draws 3 bar slots so the widget never reflows between levels", () => {
    for (const level of ["excellent", "good", "poor", "lost"] as const) {
      useVoiceStore.setState({ connectionQuality: { u1: level } });
      const { container, unmount } = render(
        <ConnectionQualityIndicator identity="u1" />,
      );
      expect(container.querySelectorAll("[data-cq-bar]")).toHaveLength(3);
      unmount();
    }
  });

  it("exposes an accessible label describing the level", () => {
    useVoiceStore.setState({ connectionQuality: { u1: "poor" } });
    render(<ConnectionQualityIndicator identity="u1" />);
    const el = screen.getByRole("img");
    expect(el).toHaveAccessibleName("Bağlantı: zayıf");
    // Pointer users get the same text without a screen reader.
    expect(el).toHaveAttribute("title", "Bağlantı: zayıf");
  });

  it("labels each level distinctly", () => {
    const expected: Record<string, string> = {
      excellent: "Bağlantı: mükemmel",
      good: "Bağlantı: iyi",
      poor: "Bağlantı: zayıf",
      lost: "Bağlantı: koptu",
    };
    for (const [level, label] of Object.entries(expected)) {
      useVoiceStore.setState({
        connectionQuality: { u1: level as "good" },
      });
      const { unmount } = render(<ConnectionQualityIndicator identity="u1" />);
      expect(screen.getByRole("img")).toHaveAccessibleName(label);
      unmount();
    }
  });
});
