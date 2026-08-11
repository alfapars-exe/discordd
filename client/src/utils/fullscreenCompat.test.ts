/**
 * fullscreenCompat regression tests — the whole point of these helpers is the
 * vendor-prefixed fallback, and that is the one path no type checker can guard:
 * lib.dom.d.ts declares no webkit-prefixed fullscreen members, so TypeScript
 * cannot tell that `webkitRequestFullscreen()` returns `undefined` rather than a
 * promise. These tests pin the contract the call sites rely on — every helper
 * hands back a real, chainable promise regardless of what the engine returns.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  requestFullscreenCompat,
  exitFullscreenCompat,
  getFullscreenElement,
} from "./fullscreenCompat";

type Mutable = Record<string, unknown>;

/** Installs own properties on `document`, returning a restore fn. */
function stubDocument(props: Mutable): () => void {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const key of Object.keys(props)) {
    saved.set(key, Object.getOwnPropertyDescriptor(document, key));
    Object.defineProperty(document, key, {
      value: props[key],
      configurable: true,
      writable: true,
    });
  }
  return () => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(document, key, descriptor);
      else delete (document as unknown as Mutable)[key];
    }
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("requestFullscreenCompat", () => {
  it("uses the standard API when present", async () => {
    const el = document.createElement("div");
    const requestFullscreen = vi.fn(() => Promise.resolve());
    Object.assign(el, { requestFullscreen });

    await expect(requestFullscreenCompat(el)).resolves.toBeUndefined();
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
  });

  it("falls back to webkitRequestFullscreen when the standard API is missing", async () => {
    const el = document.createElement("div");
    const webkitRequestFullscreen = vi.fn(() => undefined);
    Object.assign(el, { requestFullscreen: undefined, webkitRequestFullscreen });

    await expect(requestFullscreenCompat(el)).resolves.toBeUndefined();
    expect(webkitRequestFullscreen).toHaveBeenCalledTimes(1);
  });

  it("returns a chainable promise even when the vendor API returns undefined", () => {
    const el = document.createElement("div");
    // Legacy WebKit returns void, not a promise. Chaining .catch() on the raw
    // return value is what used to throw "… .catch is not a function".
    Object.assign(el, {
      requestFullscreen: undefined,
      webkitRequestFullscreen: () => undefined,
    });

    const result = requestFullscreenCompat(el);
    expect(typeof result.catch).toBe("function");
    return expect(result).resolves.toBeUndefined();
  });

  it("converts a synchronous throw into a rejection", async () => {
    const el = document.createElement("div");
    Object.assign(el, {
      requestFullscreen: undefined,
      webkitRequestFullscreen: () => {
        throw new Error("not permitted");
      },
    });

    await expect(requestFullscreenCompat(el)).rejects.toThrow("not permitted");
  });

  it("invokes the vendor method with the element as receiver", async () => {
    const el = document.createElement("div");
    // Extracting the method loses its binding; calling it unbound throws
    // "Illegal invocation" in a real engine, which jsdom mocks cannot reproduce.
    const webkitRequestFullscreen = vi.fn(() => undefined);
    Object.assign(el, { requestFullscreen: undefined, webkitRequestFullscreen });

    await requestFullscreenCompat(el);
    expect(webkitRequestFullscreen.mock.contexts[0]).toBe(el);
  });

  it("resolves and warns when no fullscreen API exists at all", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const el = document.createElement("div");
    Object.assign(el, { requestFullscreen: undefined, webkitRequestFullscreen: undefined });

    await expect(requestFullscreenCompat(el)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});

describe("exitFullscreenCompat", () => {
  it("prefers the standard API", async () => {
    const exitFullscreen = vi.fn(() => Promise.resolve());
    const restore = stubDocument({ exitFullscreen, webkitExitFullscreen: undefined });

    await expect(exitFullscreenCompat()).resolves.toBeUndefined();
    expect(exitFullscreen).toHaveBeenCalledTimes(1);
    restore();
  });

  it("falls back to the void-returning webkit API without breaking the chain", async () => {
    const webkitExitFullscreen = vi.fn(() => undefined);
    const restore = stubDocument({ exitFullscreen: undefined, webkitExitFullscreen });

    const result = exitFullscreenCompat();
    expect(typeof result.catch).toBe("function");
    await expect(result).resolves.toBeUndefined();
    expect(webkitExitFullscreen).toHaveBeenCalledTimes(1);
    restore();
  });

  it("resolves and warns when neither API exists", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const restore = stubDocument({ exitFullscreen: undefined, webkitExitFullscreen: undefined });

    await expect(exitFullscreenCompat()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    restore();
  });
});

describe("getFullscreenElement", () => {
  it("returns the standard element when set", () => {
    const el = document.createElement("div");
    const restore = stubDocument({ fullscreenElement: el, webkitFullscreenElement: null });

    expect(getFullscreenElement()).toBe(el);
    restore();
  });

  it("falls back to the webkit element when the standard one is nullish", () => {
    const el = document.createElement("div");
    const restore = stubDocument({ fullscreenElement: null, webkitFullscreenElement: el });

    expect(getFullscreenElement()).toBe(el);
    restore();
  });

  it("returns null when nothing is fullscreen", () => {
    const restore = stubDocument({ fullscreenElement: null, webkitFullscreenElement: null });

    expect(getFullscreenElement()).toBeNull();
    restore();
  });
});
