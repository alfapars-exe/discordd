import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  dismissWelcome: vi.fn(),
  dismissDownloadPrompt: vi.fn(),
}));

vi.mock("../../api/auth", () => ({
  dismissWelcome: mocks.dismissWelcome,
  dismissDownloadPrompt: mocks.dismissDownloadPrompt,
  getMe: vi.fn(),
  login: vi.fn(),
  register: vi.fn(),
  logout: vi.fn(),
}));
vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("../../utils/detectOS", () => ({
  detectOS: () => ({ url: "https://example.test/download", i18nKey: "downloadPromptTitle" }),
  shouldShowDownloadPrompt: () => true,
}));

import type { User } from "../../types";
import { useAuthStore } from "../../stores/authStore";
import DownloadPromptModal from "./DownloadPromptModal";
import WelcomeModal from "./WelcomeModal";

function user(id: string, hasSeenWelcome: boolean, hasSeenDownloadPrompt = false) {
  return {
    id,
    username: id,
    has_seen_welcome: hasSeenWelcome,
    has_seen_download_prompt: hasSeenDownloadPrompt,
  } as User;
}

describe("first-run onboarding prompts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({ user: user("account-one", false) });
  });

  it("shows prompts sequentially and resets local dismissal for a different account", () => {
    render(
      <>
        <WelcomeModal />
        <DownloadPromptModal />
      </>,
    );

    expect(screen.getByRole("heading", { name: "welcomeTitle" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "downloadPromptTitle" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "welcomeGotIt" }));
    expect(screen.queryByRole("heading", { name: "welcomeTitle" })).toBeNull();
    expect(screen.getByRole("heading", { name: "downloadPromptTitle" })).toBeInTheDocument();

    act(() => useAuthStore.setState({ user: user("account-two", false) }));
    expect(screen.getByRole("heading", { name: "welcomeTitle" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "downloadPromptTitle" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "welcomeGotIt" }));
    expect(screen.getByRole("heading", { name: "downloadPromptTitle" })).toBeInTheDocument();

    act(() => useAuthStore.setState({ user: user("account-three", true) }));
    expect(screen.queryByRole("heading", { name: "welcomeTitle" })).toBeNull();
    expect(screen.getByRole("heading", { name: "downloadPromptTitle" })).toBeInTheDocument();
  });
});
