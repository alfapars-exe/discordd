import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import type { FileRejection } from "../utils/fileValidation";

const addToast = vi.fn();

vi.mock("../stores/toastStore", () => ({
  useToastStore: Object.assign(
    () => addToast,
    {
      getState: () => ({ addToast }),
    }
  ),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts) return `${key}:${JSON.stringify(opts)}`;
      return key;
    },
  }),
}));

import { useAttachmentRejectionToast } from "./useAttachmentRejectionToast";

function makeFile(name: string): File {
  return new File([new Uint8Array(1)], name, { type: "" });
}

describe("useAttachmentRejectionToast", () => {
  beforeEach(() => {
    addToast.mockReset();
  });

  it("does nothing when the rejected list is empty", () => {
    const { result } = renderHook(() => useAttachmentRejectionToast());
    result.current([]);
    expect(addToast).not.toHaveBeenCalled();
  });

  it("reports a single oversized file with its filename", () => {
    const { result } = renderHook(() => useAttachmentRejectionToast());
    const rejections: FileRejection[] = [
      { file: makeFile("photo.png"), reason: "too_large" },
    ];
    result.current(rejections);
    expect(addToast).toHaveBeenCalledTimes(1);
    const [type, message] = addToast.mock.calls[0]!;
    expect(type).toBe("error");
    expect(message).toContain("photo.png");
    expect(message).toContain("fileTooLarge");
  });

  it("reports a single disallowed type", () => {
    const { result } = renderHook(() => useAttachmentRejectionToast());
    const rejections: FileRejection[] = [
      { file: makeFile("script.exe"), reason: "type_not_allowed" },
    ];
    result.current(rejections);
    expect(addToast).toHaveBeenCalledTimes(1);
    const [type, message] = addToast.mock.calls[0]!;
    expect(type).toBe("error");
    expect(message).toContain("script.exe");
    expect(message).toContain("fileTypeNotAllowed");
  });

  it("aggregates multiple rejections into one toast", () => {
    const { result } = renderHook(() => useAttachmentRejectionToast());
    const rejections: FileRejection[] = [
      { file: makeFile("a.png"), reason: "too_large" },
      { file: makeFile("b.exe"), reason: "type_not_allowed" },
      { file: makeFile("c.png"), reason: "too_large" },
    ];
    result.current(rejections);
    expect(addToast).toHaveBeenCalledTimes(1);
    const [, message] = addToast.mock.calls[0]!;
    expect(message).toContain("a.png");
    expect(message).toContain("b.exe");
    expect(message).toContain("c.png");
  });
});
