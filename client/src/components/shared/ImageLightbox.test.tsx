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
import {useFriendStore} from "../../stores/friendStore";
import { usePreferencesStore } from "../../stores/preferencesStore";

vi.mock("../../api/client", () => ({
  getAuthGeneration: () => 1,
  ensureFreshToken: vi.fn(async () => "fresh-token"),
}));

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
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
  it("cycles Tab focus within the viewer and includes the open media menu", () => {
    render(<ImageLightbox />);
    openRemote();
    // Zoom-out is disabled at 100%, so reset is the first tabbable control.
    const first = screen.getByRole("button", { name: "lightboxResetZoom" });
    const last = screen.getByRole("button", { name: "close" });
    last.focus();
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    fireEvent(last, tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "mediaActions" }));
    const menuAction = screen.getByRole("menuitem", { name: "lightboxDownload" });
    menuAction.focus();
    const within = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    fireEvent(menuAction, within);
    expect(within.defaultPrevented).toBe(false);

    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    fireEvent.keyDown(outside, { key: "Tab" });
    expect(first).toHaveFocus();
    outside.remove();
  });

  it("revokes an open preview when media preferences change", () => {
    render(<ImageLightbox />);
    openRemote();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    act(() => usePreferencesStore.setState({ data: { privacy: { sensitiveMedia: { channels: "block" } } } }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(useLightboxStore.getState().items).toHaveLength(0);
  });
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

  it("shows message author and timestamp metadata", () => {
    render(<ImageLightbox />);
    openRemote({ authorName: "Alice", authorAvatarUrl: "/avatars/alice.png", createdAt: "2026-07-18T12:30:00Z" });

    expect(screen.getByText(/Alice/)).toBeInTheDocument();
    expect(screen.getByText(/2026/)).toBeInTheDocument();
    expect(document.querySelector(".image-lightbox-avatar")).toHaveAttribute("src", "/avatars/alice.png");
  });

  it("exposes forward and contextual media actions when opened from a message", () => {
    render(<ImageLightbox />);
    openRemote({ message: { id: "m1", user_id: "u1", content: "photo", attachments: [], reactions: [], created_at: "2026-01-01T00:00:00Z", edited_at: null, reply_to_id: null, is_pinned: false, referenced_message: null, author: { id: "u1", username: "alice" } } });
    expect(screen.getByRole("button", { name: "forwardMessage" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "mediaActions" }));
    expect(screen.getByRole("menuitem", { name: "forwardMessage" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "lightboxOpenOriginal" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "lightboxDownload" })).toBeInTheDocument();
  });

  it("zooms with controls and resets when the image changes", async () => {
    render(<ImageLightbox />);
    openRemote();

    fireEvent.click(screen.getByRole("button", { name: "lightboxZoomIn" }));
    expect(screen.getByRole("button", { name: "lightboxResetZoom" })).toHaveTextContent("125%");
    expect(screen.getByRole("img", { name: "photo.png" }).getAttribute("style")).toContain("scale(1.25)");

    act(() => {
      useLightboxStore.getState().open({
        kind: "remote",
        src: "https://cdn.test/other.png",
        href: "https://cdn.test/other.png",
        filename: "other.png",
      });
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "lightboxResetZoom" })).toHaveTextContent("100%"));
  });

  it("preserves browser zoom and history shortcuts without changing image zoom or gallery", () => {
    render(<ImageLightbox />);
    act(() => useLightboxStore.getState().openGallery([
      { kind: "remote", src: "https://cdn.test/one.png", href: "https://cdn.test/one.png", filename: "one.png" },
      { kind: "remote", src: "https://cdn.test/two.png", href: "https://cdn.test/two.png", filename: "two.png" },
    ]));
    fireEvent.click(screen.getByRole("button", { name: "lightboxZoomIn" }));
    for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      for (const key of ["+", "-", "0", "ArrowRight"]) {
        const event = new KeyboardEvent("keydown", { key, ...modifiers, bubbles: true, cancelable: true });
        fireEvent(document, event);
        expect(event.defaultPrevented).toBe(false);
        expect(screen.getByRole("button", { name: "lightboxResetZoom" })).toHaveTextContent("125%");
        expect(screen.getByRole("img", { name: "one.png" })).toBeInTheDocument();
      }
    }
    fireEvent.keyDown(document, { key: "+" });
    expect(screen.getByRole("button", { name: "lightboxResetZoom" })).toHaveTextContent("150%");
  });

  it("dismisses the media menu before the viewer and restores the menu trigger focus", async () => {
    render(<ImageLightbox />);
    openRemote();
    const trigger = screen.getByRole("button", { name: "mediaActions" });
    fireEvent.click(trigger);
    const action = screen.getByRole("menuitem", { name: "lightboxDownload" });
    action.focus();
    fireEvent.keyDown(action, { key: "+" });
    expect(screen.getByRole("button", { name: "lightboxResetZoom" })).toHaveTextContent("100%");
    fireEvent.keyDown(action, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("dialog", { name: "imagePreview" })).toBeInTheDocument();
    expect(trigger).toHaveFocus();
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("clears image pan when zoom reaches 100% through the button or keyboard", () => {
    render(<ImageLightbox />);
    openRemote();
    const image = screen.getByRole("img", { name: "photo.png" });
    const stage = document.querySelector(".image-lightbox-stage")!;

    fireEvent.click(screen.getByRole("button", { name: "lightboxZoomIn" }));
    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 40, clientY: 25 });
    fireEvent.pointerUp(stage, { pointerId: 1, clientX: 40, clientY: 25 });
    expect(image.getAttribute("style")).toContain("translate(30px, 15px)");
    fireEvent.click(screen.getByRole("button", { name: "lightboxZoomOut" }));
    expect(image.getAttribute("style")).toContain("translate(0px, 0px)");

    fireEvent.click(screen.getByRole("button", { name: "lightboxZoomIn" }));
    fireEvent.pointerDown(stage, { pointerId: 2, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(stage, { pointerId: 2, clientX: 40, clientY: 25 });
    fireEvent.pointerUp(stage, { pointerId: 2, clientX: 40, clientY: 25 });
    fireEvent.keyDown(document, { key: "-" });
    expect(image.getAttribute("style")).toContain("translate(0px, 0px)");
  });

  it("restores the persistent menu trigger after forwarding from an unmounted menu action", async () => {
    render(<ImageLightbox />);
    openRemote({ message: { id: "m1", user_id: "u1", content: "photo", attachments: [], reactions: [], created_at: "2026-01-01T00:00:00Z", edited_at: null, reply_to_id: null, is_pinned: false, referenced_message: null, author: { id: "u1", username: "alice" } } });
    await waitFor(() => expect(screen.getByRole("button", { name: "close" })).toHaveFocus());
    const menuTrigger = screen.getByRole("button", { name: "mediaActions" });
    fireEvent.click(menuTrigger);
    const action = screen.getByRole("menuitem", { name: "forwardMessage" });
    action.focus();
    fireEvent.click(action);
    expect(action.isConnected).toBe(false);
    expect(screen.getByRole("dialog", { name: "forwardMessage" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "forwardClose" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "forwardMessage" })).toBeNull());
    expect(menuTrigger).toHaveFocus();
    expect(screen.getByRole("dialog", { name: "imagePreview" })).toBeInTheDocument();
    fireEvent.click(menuTrigger);
    const nextAction = screen.getByRole("menuitem", { name: "forwardMessage" });
    nextAction.focus();
    fireEvent.click(nextAction);
    // Interacting with nested controls must never dismiss the parent viewer.
    fireEvent.click(document.querySelector(".forward-search")!);
    expect(screen.getByRole("dialog", { name: "forwardMessage" })).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "imagePreview" })).toBeInTheDocument();
    fireEvent.click(document.querySelector(".report-overlay")!);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "forwardMessage" })).toBeNull());
    expect(screen.getByRole("dialog", { name: "imagePreview" })).toBeInTheDocument();
    expect(menuTrigger).toHaveFocus();
  });

  it("Escape closes the nested forward dialog and restores its trigger focus", async () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    render(<ImageLightbox />);
    openRemote({ message: { id: "m1", user_id: "u1", content: "photo", attachments: [], reactions: [], created_at: "2026-01-01T00:00:00Z", edited_at: null, reply_to_id: null, is_pinned: false, referenced_message: null, author: { id: "u1", username: "alice" } } });
    const trigger = screen.getByRole("button", { name: "forwardMessage" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "close" })));
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "forwardMessage" })).toBeInTheDocument();
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
    expect(document.activeElement).toBe(document.querySelector(".forward-search"));
    const nestedTab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    fireEvent(document.activeElement!, nestedTab);
    expect(nestedTab.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(document.querySelector(".forward-search"));

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "forwardMessage" })).toBeNull());
    expect(screen.getByRole("dialog", { name: "imagePreview" })).toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(opener));
    opener.remove();
  });

  it("navigates a gallery with buttons and arrow keys", () => {
    render(<ImageLightbox />);
    act(() => {
      useLightboxStore.getState().openGallery([
        { kind: "remote", src: "https://cdn.test/one.png", href: "https://cdn.test/one.png", filename: "one.png" },
        { kind: "remote", src: "https://cdn.test/two.png", href: "https://cdn.test/two.png", filename: "two.png" },
      ]);
    });

    expect(screen.getByText("1 / 2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "lightboxNext" }));
    expect(screen.getByRole("img", { name: "two.png" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "ArrowLeft" });
    expect(screen.getByRole("img", { name: "one.png" })).toBeInTheDocument();
  });

  it("supports touch swipe navigation and pinch zoom", () => {
    render(<ImageLightbox />);
    act(() => {
      useLightboxStore.getState().openGallery([
        { kind: "remote", src: "https://cdn.test/one.png", href: "https://cdn.test/one.png", filename: "one.png" },
        { kind: "remote", src: "https://cdn.test/two.png", href: "https://cdn.test/two.png", filename: "two.png" },
      ]);
    });
    const stage = document.querySelector(".image-lightbox-stage")!;
    fireEvent.pointerDown(stage, { pointerId: 1, pointerType: "touch", clientX: 180, clientY: 100 });
    fireEvent.pointerMove(stage, { pointerId: 1, pointerType: "touch", clientX: 90, clientY: 104 });
    fireEvent.pointerUp(stage, { pointerId: 1, pointerType: "touch", clientX: 90, clientY: 104 });
    expect(screen.getByRole("img", { name: "two.png" })).toBeInTheDocument();

    fireEvent.pointerDown(stage, { pointerId: 2, pointerType: "touch", clientX: 100, clientY: 100 });
    fireEvent.pointerDown(stage, { pointerId: 3, pointerType: "touch", clientX: 200, clientY: 100 });
    fireEvent.pointerMove(stage, { pointerId: 3, pointerType: "touch", clientX: 260, clientY: 100 });
    expect(screen.getByRole("button", { name: "lightboxResetZoom" })).toHaveTextContent("160%");
  });

  it("keeps gallery shortcuts out of form fields and resets pan when zoom reaches 100%", () => {
    render(<ImageLightbox />);
    act(() => {
      useLightboxStore.getState().openGallery([
        { kind: "remote", src: "https://cdn.test/one.png", href: "https://cdn.test/one.png", filename: "one.png" },
        { kind: "remote", src: "https://cdn.test/two.png", href: "https://cdn.test/two.png", filename: "two.png" },
      ]);
    });
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    fireEvent.keyDown(input, { key: "ArrowRight" });
    expect(screen.getByRole("img", { name: "one.png" })).toBeInTheDocument();
    input.remove();

    fireEvent.click(screen.getByRole("button", { name: "lightboxZoomIn" }));
    fireEvent.wheel(document.querySelector(".image-lightbox-stage")!, { deltaY: 100 });
    expect(screen.getByRole("button", { name: "lightboxResetZoom" })).toHaveTextContent("100%");
    expect(screen.getByRole("img", { name: "one.png" }).getAttribute("style")).toContain("translate(0px, 0px)");
  });

  it("ignores a third finger and continues the original pinch as one-finger pan", () => {
    render(<ImageLightbox />);
    openRemote();
    const stage = document.querySelector(".image-lightbox-stage")!;
    const capture = vi.fn();
    Object.assign(stage, { setPointerCapture: capture });
    fireEvent.pointerDown(stage, { pointerId: 1, pointerType: "touch", clientX: 100, clientY: 100 });
    fireEvent.pointerDown(stage, { pointerId: 2, pointerType: "touch", clientX: 200, clientY: 100 });
    fireEvent.pointerDown(stage, { pointerId: 3, pointerType: "touch", clientX: 400, clientY: 100 });
    fireEvent.pointerUp(stage, { pointerId: 3, pointerType: "touch", clientX: 100, clientY: 100 });
    fireEvent.pointerMove(stage, { pointerId: 2, pointerType: "touch", clientX: 300, clientY: 100 });
    expect(screen.getByRole("button", { name: "lightboxResetZoom" })).toHaveTextContent("200%");
    expect(capture.mock.calls).toEqual([[1], [2]]);
    fireEvent.pointerUp(stage, { pointerId: 1, pointerType: "touch", clientX: 100, clientY: 100 });
    fireEvent.pointerMove(stage, { pointerId: 2, pointerType: "touch", clientX: 330, clientY: 120 });
    expect(screen.getByRole("img", { name: "photo.png" }).getAttribute("style")).toContain("translate(30px, 20px)");
    fireEvent.pointerUp(stage, { pointerId: 2, pointerType: "touch", clientX: 330, clientY: 120 });
  });

  it("ignores non-primary mouse buttons and abandons drag after capture loss or cancellation", () => {
    render(<ImageLightbox />);
    openRemote();
    const stage = document.querySelector(".image-lightbox-stage")!;
    const image = screen.getByRole("img", { name: "photo.png" });
    fireEvent.click(screen.getByRole("button", { name: "lightboxZoomIn" }));
    for (const button of [1, 2]) {
      fireEvent.pointerDown(stage, { pointerId: 7, pointerType: "mouse", button, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(stage, { pointerId: 7, pointerType: "mouse", clientX: 40, clientY: 20 });
      expect(image.getAttribute("style")).toContain("translate(0px, 0px)");
    }
    for (const cancel of ["pointerCancel", "lostPointerCapture"] as const) {
      fireEvent.pointerDown(stage, { pointerId: 8, pointerType: "touch", clientX: 10, clientY: 10 });
      fireEvent[cancel](stage, { pointerId: 8 });
      fireEvent.pointerMove(stage, { pointerId: 8, pointerType: "touch", clientX: 40, clientY: 20 });
      expect(image.getAttribute("style")).toContain("translate(0px, 0px)");
    }
    fireEvent.pointerDown(stage, { pointerId: 9, pointerType: "touch", clientX: 10, clientY: 10 });
    fireEvent.pointerUp(stage, { pointerId: 99 });
    fireEvent.pointerMove(stage, { pointerId: 9, pointerType: "touch", clientX: 40, clientY: 20 });
    expect(image.getAttribute("style")).toContain("translate(30px, 10px)");
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

it.each(["loading","error"] as const)("closes an existing preview when friendship certainty becomes %s without ID changes",status=>{
 useFriendStore.setState({ownerId:"owner",authGeneration:1,friendsStatus:"ready",friends:[]});render(<ImageLightbox/>);openRemote();expect(screen.getByRole("dialog")).toBeInTheDocument();act(()=>useFriendStore.setState({friendsStatus:status}));expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
it("closes a preview when friend snapshot account/session provenance changes",()=>{
 useFriendStore.setState({ownerId:"owner",authGeneration:1,friendsStatus:"ready",friends:[]});render(<ImageLightbox/>);openRemote();act(()=>useFriendStore.setState({authGeneration:2}));expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
