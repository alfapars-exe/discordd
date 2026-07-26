/**
 * ImageLightbox tests — store-driven visibility, close paths (ESC/backdrop),
 * the stale-cookie 401 retry shared with attachment tiles, and blob URL
 * ownership (create on open, revoke on close) for E2EE images.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import ImageLightbox from "./ImageLightbox";
import { useLightboxStore } from "../../stores/lightboxStore";
import { ensureFreshToken } from "../../api/client";

vi.mock("../../api/client", () => ({
  ensureFreshToken: vi.fn(async () => "fresh-token"),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

// jsdom has no createObjectURL — stub the pair and track calls.
const createObjectURL = vi.fn(() => "blob:test-1");
const revokeObjectURL = vi.fn();

beforeEach(() => {
  useLightboxStore.getState().close();
  vi.mocked(ensureFreshToken).mockClear();
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  vi.stubGlobal("URL", Object.assign(Object.create(URL), {
    createObjectURL,
    revokeObjectURL,
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function openRemote(over: Record<string, unknown> = {}) {
  act(() => {
    useLightboxStore.getState().open({
      kind: "remote",
      src: "https://cdn.test/photo.png",
      href: "https://cdn.test/photo.png",
      filename: "photo.png",
      ...over,
    } as never);
  });
}

describe("ImageLightbox", () => {
  it("renders nothing while the store item is null", () => {
    const { container } = render(<ImageLightbox />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens as an aria-modal dialog with image, caption and links", () => {
    render(<ImageLightbox />);
    openRemote();

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("img", { name: "photo.png" })).toHaveAttribute(
      "src",
      "https://cdn.test/photo.png"
    );
    expect(screen.getByText("photo.png")).toBeInTheDocument();
    expect(screen.getByText("lightboxOpenOriginal").closest("a")).toHaveAttribute(
      "href",
      "https://cdn.test/photo.png"
    );
    expect(screen.getByText("lightboxDownload").closest("a")).toHaveAttribute(
      "download",
      "photo.png"
    );
  });

  it("closes on backdrop click", () => {
    render(<ImageLightbox />);
    openRemote();
    fireEvent.click(screen.getByRole("dialog"));
    expect(useLightboxStore.getState().item).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes on Escape", () => {
    render(<ImageLightbox />);
    openRemote();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(useLightboxStore.getState().item).toBeNull();
  });

  it("clicking the image itself does NOT close", () => {
    render(<ImageLightbox />);
    openRemote();
    fireEvent.click(screen.getByRole("img", { name: "photo.png" }));
    expect(useLightboxStore.getState().item).not.toBeNull();
  });

  it("authRetry: first error refreshes the token and cache-busts; second error shows fallback", async () => {
    render(<ImageLightbox />);
    openRemote({ authRetry: true });

    fireEvent.error(screen.getByRole("img", { name: "photo.png" }));
    await waitFor(() => {
      expect(
        screen.getByRole("img", { name: "photo.png" }).getAttribute("src")
      ).toContain("r=1");
    });
    expect(ensureFreshToken).toHaveBeenCalledTimes(1);

    fireEvent.error(screen.getByRole("img", { name: "photo.png" }));
    await waitFor(() => {
      expect(screen.queryByRole("img")).toBeNull();
    });
    expect(screen.getByText("lightboxImageFailed")).toBeInTheDocument();
  });

  it("without authRetry an error fails immediately, no refresh attempt", async () => {
    render(<ImageLightbox />);
    openRemote(); // authRetry absent

    fireEvent.error(screen.getByRole("img", { name: "photo.png" }));
    await waitFor(() => {
      expect(screen.queryByRole("img")).toBeNull();
    });
    expect(ensureFreshToken).not.toHaveBeenCalled();
  });

  it("blob items mint their OWN object URL and revoke it on close", async () => {
    render(<ImageLightbox />);
    const file = new File([new Uint8Array(4)], "secret.png", { type: "image/png" });
    act(() => {
      useLightboxStore.getState().open({ kind: "blob", file, filename: "secret.png" });
    });

    await waitFor(() => {
      expect(screen.getByRole("img", { name: "secret.png" })).toHaveAttribute(
        "src",
        "blob:test-1"
      );
    });
    expect(createObjectURL).toHaveBeenCalledWith(file);

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:test-1");
    });
  });

  it("moves focus to the close button on open and restores it on close", async () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();

    render(<ImageLightbox />);
    openRemote();

    await waitFor(() => {
      expect(document.activeElement?.getAttribute("aria-label")).toBe("close");
    });

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(document.activeElement).toBe(outside);
    });
    outside.remove();
  });
});
