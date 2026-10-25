import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  dismissWelcome: vi.fn(),
  dismissDownloadPrompt: vi.fn(),
  shouldShowDownloadPrompt: vi.fn(() => true),
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
  shouldShowDownloadPrompt: mocks.shouldShowDownloadPrompt,
}));

import type { User } from "../../types";
import { useAuthStore } from "../../stores/authStore";
import DownloadPromptModal from "./DownloadPromptModal";
import WelcomeModal from "./WelcomeModal";
import RecoveryPasswordPrompt from "./RecoveryPasswordPrompt";

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
    mocks.shouldShowDownloadPrompt.mockReturnValue(true);
    useAuthStore.setState({ user: user("account-one", false) });
  });

  it("shows prompts sequentially and resets local dismissal for a different account", () => {
    render(
      <>
        <WelcomeModal />
        <DownloadPromptModal />
        <RecoveryPasswordPrompt />
      </>,
    );

    expect(screen.getByRole("heading", { name: "welcomeTitle" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "downloadPromptTitle" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "recoveryPromptTitle" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "welcomeGotIt" }));
    expect(screen.queryByRole("heading", { name: "welcomeTitle" })).toBeNull();
    expect(screen.getByRole("heading", { name: "downloadPromptTitle" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "recoveryPromptTitle" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "downloadPromptDismiss" }));
    expect(screen.getByRole("heading", { name: "recoveryPromptTitle" })).toBeInTheDocument();

    act(() => useAuthStore.setState({ user: user("account-two", false) }));
    expect(screen.getByRole("heading", { name: "welcomeTitle" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "recoveryPromptTitle" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "downloadPromptTitle" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "welcomeGotIt" }));
    expect(screen.getByRole("heading", { name: "downloadPromptTitle" })).toBeInTheDocument();

    act(() => useAuthStore.setState({ user: user("account-three", true) }));
    expect(screen.queryByRole("heading", { name: "welcomeTitle" })).toBeNull();
    expect(screen.getByRole("heading", { name: "downloadPromptTitle" })).toBeInTheDocument();
  });

  it("does not defer recovery for an unavailable desktop download prompt", () => {
    mocks.shouldShowDownloadPrompt.mockReturnValue(false);
    useAuthStore.setState({ user: user("native-account", true, false) });
    render(<><DownloadPromptModal /><RecoveryPasswordPrompt /></>);
    expect(screen.queryByRole("heading", { name: "downloadPromptTitle" })).toBeNull();
    expect(screen.getByRole("heading", { name: "recoveryPromptTitle" })).toBeInTheDocument();
  });
});
