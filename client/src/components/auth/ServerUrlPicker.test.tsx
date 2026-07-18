import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { normalizeServerUrl } from "./ServerUrlPicker";

// isNativeApp() is checked at render time; force it true so the picker
// actually renders during tests. Web-mode-hides-the-picker is covered
// in a dedicated test below.
let mockIsNative = true;
vi.mock("../../utils/constants", () => ({
  DEFAULT_SERVER_URL: "https://default.example",
  isNativeApp: () => mockIsNative,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

import ServerUrlPicker from "./ServerUrlPicker";

// window.location.reload is called after a successful save. Stub it so
// the test doesn't blow up jsdom.
const reloadSpy = vi.fn();

beforeEach(() => {
  mockIsNative = true;
  localStorage.clear();
  reloadSpy.mockReset();
  Object.defineProperty(window, "location", {
    value: { reload: reloadSpy },
    writable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("normalizeServerUrl", () => {
  it("adds https:// when no scheme given", () => {
    const r = normalizeServerUrl("myserver.com");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url).toBe("https://myserver.com");
  });

  it("keeps existing scheme", () => {
    const r = normalizeServerUrl("http://myserver.com");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url).toBe("http://myserver.com");
  });

  it("strips trailing slash", () => {
    const r = normalizeServerUrl("https://myserver.com/");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url).toBe("https://myserver.com");
  });

  it("rejects empty string with 'empty'", () => {
    const r = normalizeServerUrl("");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("empty");
  });

  it("rejects whitespace-only with 'empty'", () => {
    const r = normalizeServerUrl("   ");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("empty");
  });

  it("rejects ftp:// with 'invalid_url'", () => {
    const r = normalizeServerUrl("ftp://myserver.com");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid_url");
  });
});

describe("ServerUrlPicker component", () => {
  it("renders nothing in web mode", () => {
    mockIsNative = false;
    const { container } = render(<ServerUrlPicker />);
    expect(container.firstChild).toBeNull();
  });

  it("shows default URL when nothing stored", () => {
    render(<ServerUrlPicker />);
    expect(screen.getByRole("button", { name: /https:\/\/default\.example/ })).toBeInTheDocument();
  });

  it("shows saved URL when localStorage has one", () => {
    localStorage.setItem("mqvi_server_url", "https://myhome.example");
    render(<ServerUrlPicker />);
    expect(screen.getByRole("button", { name: /https:\/\/myhome\.example/ })).toBeInTheDocument();
  });

  it("expands to reveal input when toggle clicked", () => {
    render(<ServerUrlPicker />);
    expect(screen.queryByTestId("server-url-picker-input")).toBeNull();
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByTestId("server-url-picker-input")).toBeInTheDocument();
  });

  it("shows 'empty' error when user tries to save nothing", async () => {
    render(<ServerUrlPicker />);
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    fireEvent.click(screen.getByRole("button", { name: "serverUrlPicker.save" }));
    await waitFor(() => {
      const err = screen.getByTestId("server-url-picker-error");
      expect(err.dataset.errorKind).toBe("empty");
    });
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it("shows 'unreachable' when /api/version fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("net")));
    render(<ServerUrlPicker />);
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    fireEvent.change(screen.getByTestId("server-url-picker-input"), {
      target: { value: "https://home.example" },
    });
    fireEvent.click(screen.getByRole("button", { name: "serverUrlPicker.save" }));
    await waitFor(() => {
      const err = screen.getByTestId("server-url-picker-error");
      expect(err.dataset.errorKind).toBe("unreachable");
    });
    expect(reloadSpy).not.toHaveBeenCalled();
    // Nothing should have been persisted on failure.
    expect(localStorage.getItem("mqvi_server_url")).toBeNull();
  });

  it("shows 'not_a_hichat_server' when /api/version returns unrelated JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ service: "router-admin" }),
      })
    );
    render(<ServerUrlPicker />);
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    fireEvent.change(screen.getByTestId("server-url-picker-input"), {
      target: { value: "https://myrouter.local" },
    });
    fireEvent.click(screen.getByRole("button", { name: "serverUrlPicker.save" }));
    await waitFor(() => {
      const err = screen.getByTestId("server-url-picker-error");
      expect(err.dataset.errorKind).toBe("not_a_hichat_server");
    });
    expect(localStorage.getItem("mqvi_server_url")).toBeNull();
  });

  it("saves + reloads when probe returns hichat service", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ service: "hichat", status: "ok" }),
      })
    );
    render(<ServerUrlPicker />);
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    fireEvent.change(screen.getByTestId("server-url-picker-input"), {
      target: { value: "myserver.example" },
    });
    fireEvent.click(screen.getByRole("button", { name: "serverUrlPicker.save" }));
    await waitFor(() => {
      expect(reloadSpy).toHaveBeenCalledTimes(1);
    });
    // Auto-scheme addition happened at save time.
    expect(localStorage.getItem("mqvi_server_url")).toBe("https://myserver.example");
  });

  it("reset button clears localStorage and reloads", () => {
    localStorage.setItem("mqvi_server_url", "https://old.example");
    render(<ServerUrlPicker />);
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    fireEvent.click(screen.getByRole("button", { name: "serverUrlPicker.reset" }));
    expect(localStorage.getItem("mqvi_server_url")).toBeNull();
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });
});
