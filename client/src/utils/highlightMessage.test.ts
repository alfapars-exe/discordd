import { afterEach, expect, it, vi } from "vitest";
import { highlightMessage } from "./highlightMessage";

afterEach(() => vi.useRealTimers());

it("keeps a repeated navigation highlighted for two seconds after its latest jump", () => {
  vi.useFakeTimers();
  const row = document.createElement("div");
  highlightMessage(row);
  vi.advanceTimersByTime(1500);
  highlightMessage(row);
  vi.advanceTimersByTime(500);
  expect(row.classList.contains("msg-highlight")).toBe(true);
  vi.advanceTimersByTime(1499);
  expect(row.classList.contains("msg-highlight")).toBe(true);
  vi.advanceTimersByTime(1);
  expect(row.classList.contains("msg-highlight")).toBe(false);
});

it("expires separate message rows independently", () => {
  vi.useFakeTimers();
  const first = document.createElement("div");
  const second = document.createElement("div");
  highlightMessage(first);
  vi.advanceTimersByTime(1000);
  highlightMessage(second);
  vi.advanceTimersByTime(1000);
  expect(first.classList.contains("msg-highlight")).toBe(false);
  expect(second.classList.contains("msg-highlight")).toBe(true);
  vi.advanceTimersByTime(1000);
  expect(second.classList.contains("msg-highlight")).toBe(false);
});
