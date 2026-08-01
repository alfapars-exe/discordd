/**
 * MemberCardIdentity — active-timeout banner (B2/B4).
 *
 * The banner (and its "Remove timeout" action) is the one piece of
 * conditional rendering logic in this otherwise presentational component:
 * it only shows in server context with a live expiry, and the Remove
 * button only shows for moderators who can act on it.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// initReactI18next is re-exported because MemberCardIdentity's imports (via
// utils/dateFormat) transitively load src/i18n/index.ts, which calls
// .use(initReactI18next) — omitting it makes i18next throw "No
// initReactI18next export is defined on the react-i18next mock".
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

import MemberCardIdentity from "./MemberCardIdentity";

type Props = Parameters<typeof MemberCardIdentity>[0];

function baseProps(overrides: Partial<Props> = {}): Props {
  return {
    username: "alice",
    userBadges: [],
    joinDate: "1 Jan 2026",
    canEditNickname: false,
    nicknameDraft: null,
    setNicknameDraft: vi.fn(),
    openNicknameEditor: vi.fn(),
    handleSaveNickname: vi.fn(),
    isServerContext: true,
    canTimeout: false,
    handleRemoveTimeout: vi.fn(),
    sortedRoles: [],
    onClose: vi.fn(),
    ...overrides,
  };
}

const futureIso = () => new Date(Date.now() + 60_000).toISOString();

describe("MemberCardIdentity — timeout banner", () => {
  it("does not render when there is no active timeout", () => {
    render(<MemberCardIdentity {...baseProps()} />);
    expect(screen.queryByText("timeoutActive")).not.toBeInTheDocument();
  });

  it("does not render outside server context, even with an expiry set", () => {
    render(
      <MemberCardIdentity
        {...baseProps({ isServerContext: false, timeoutExpiresAt: futureIso() })}
      />
    );
    expect(screen.queryByText("timeoutActive")).not.toBeInTheDocument();
  });

  it("renders when isServerContext and timeoutExpiresAt are both set", () => {
    render(<MemberCardIdentity {...baseProps({ timeoutExpiresAt: futureIso() })} />);
    expect(screen.getByText("timeoutActive")).toBeInTheDocument();
  });

  it("does not render the Remove button without canTimeout", () => {
    render(
      <MemberCardIdentity
        {...baseProps({ timeoutExpiresAt: futureIso(), canTimeout: false })}
      />
    );
    expect(screen.queryByText("removeTimeout")).not.toBeInTheDocument();
  });

  it("renders the Remove button when canTimeout, and clicking it calls the handler", () => {
    const handleRemoveTimeout = vi.fn();
    render(
      <MemberCardIdentity
        {...baseProps({
          timeoutExpiresAt: futureIso(),
          canTimeout: true,
          handleRemoveTimeout,
        })}
      />
    );
    fireEvent.click(screen.getByText("removeTimeout"));
    expect(handleRemoveTimeout).toHaveBeenCalledTimes(1);
  });
});
