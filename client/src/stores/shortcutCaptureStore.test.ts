import { expect, it } from "vitest";
import { beginShortcutCapture, useShortcutCaptureStore } from "./shortcutCaptureStore";
it("resumes only after all recorders stop, with idempotent cleanup", () => {
  const stopA = beginShortcutCapture();
  const stopB = beginShortcutCapture();
  expect(useShortcutCaptureStore.getState().active).toBe(true);
  stopA(); stopA();
  expect(useShortcutCaptureStore.getState().active).toBe(true);
  stopB();
  expect(useShortcutCaptureStore.getState().active).toBe(false);
});
