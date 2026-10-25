import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSpamVisibility } from "./useSpamVisibility";
import { usePreferencesStore } from "../stores/preferencesStore";
import { useFriendStore } from "../stores/friendStore";
import { useAuthStore } from "../stores/authStore";
import { clearTokens } from "../api/client";
import { recordSpam, decideSpam } from "../api/spam";
vi.mock("../api/spam", () => ({ recordSpam: vi.fn(), decideSpam: vi.fn() }));
vi.mock("../api/preferences", () => ({ getPreferences: vi.fn(), updatePreferences: vi.fn(async () => ({ success: true })) }));

beforeEach(() => {
  clearTokens();
  useAuthStore.setState({ user: { id: "spam-test-user" } as never });
  vi.mocked(recordSpam).mockReset().mockResolvedValue({ success: true });
  vi.mocked(decideSpam).mockReset().mockResolvedValue({ success: true });
  usePreferencesStore.getState().reset();
  usePreferencesStore.getState().bindAccount("spam-test-user", "https://spam-test.invalid");
  usePreferencesStore.setState({ data: {} });
  useFriendStore.setState({ friends: [] });
});

it("ignores a restore response after the same account signs in again", async () => {
  let finish!: (value: { success: boolean }) => void;
  vi.mocked(decideSpam).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const { result } = renderHook(() => useSpamVisibility({ id: "stale", user_id: "other", content: "https://a.test@b.test" }, { kind: "dm", channelId: "dm" }));
  let pending!: Promise<void>;
  await act(async () => { pending = result.current.restore(); await Promise.resolve(); });
  act(() => { clearTokens(); useAuthStore.setState({ user: { id: "spam-test-user" } as never }); });
  await act(async () => { finish({ success: true }); await pending; });
  expect(result.current.hidden).toBe(true);
  expect(usePreferencesStore.getState().get<{ spamRestoredMessages?: Record<string, string> }>("privacy")?.spamRestoredMessages).toBeUndefined();
});

it("does not restore an edited message using an earlier request", async () => {
  let finish!: (value: { success: boolean }) => void;
  vi.mocked(decideSpam).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const value = { id: "edited", user_id: "other", content: "https://a.test@b.test", edited_at: "old" };
  const view = renderHook(({ message }) => useSpamVisibility(message, { kind: "dm", channelId: "dm" }), { initialProps: { message: value } });
  let pending!: Promise<void>;
  await act(async () => { pending = view.result.current.restore(); await Promise.resolve(); });
  view.rerender({ message: { ...value, edited_at: "new" } });
  await act(async () => { finish({ success: true }); await pending; });
  expect(view.result.current.hidden).toBe(true);
  expect(usePreferencesStore.getState().get<{ spamRestoredMessages?: Record<string, string> }>("privacy")?.spamRestoredMessages).toBeUndefined();
});

it("does not send a restore decision after unmounting during registration", async () => {
  const view = renderHook(() => useSpamVisibility({ id: "unmounted", user_id: "other", content: "https://a.test@b.test" }, { kind: "dm", channelId: "dm" }));
  let finish!: (value: { success: boolean }) => void;
  vi.mocked(recordSpam).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  let pending!: Promise<void>;
  act(() => { pending = view.result.current.restore(); });
  view.unmount();
  await act(async () => { finish({ success: true }); await pending; });
  expect(decideSpam).not.toHaveBeenCalled();
  expect(usePreferencesStore.getState().get<{ spamRestoredMessages?: Record<string, string> }>("privacy")?.spamRestoredMessages).toBeUndefined();
});
afterEach(() => {
  cleanup();
  usePreferencesStore.getState().reset();
});

it("hides classified spam and restores it without changing message content", async () => {
  const message = { id: "message", user_id: "other", content: "https://trusted.test@evil.test" };
  const { result, rerender } = renderHook(({ value }) => useSpamVisibility(value), { initialProps: { value: message } });
  expect(result.current.hidden).toBe(true);
  await act(async () => { await result.current.restore(); });
  expect(result.current.hidden).toBe(false);
  expect(message.content).toBe("https://trusted.test@evil.test");
  rerender({ value: { ...message, id: "another" } });
  expect(result.current.hidden).toBe(true);
});

it("responds immediately to disabled filtering and never treats unavailable content as spam", () => {
  const { result } = renderHook(() => useSpamVisibility({ id: "m", user_id: "other", content: "https://a.test@b.test" }));
  expect(result.current.hidden).toBe(true);
  act(() => usePreferencesStore.setState({ data: { privacy: { spamFilter: "off" } } }));
  expect(result.current.hidden).toBe(false);
  const unknown = renderHook(() => useSpamVisibility({ id: "encrypted", user_id: "other", content: null }));
  expect(unknown.result.current.hidden).toBe(false);
});

it("retains a synchronized restore after remount but rechecks edited messages", async () => {
  const message = { id: "persisted", user_id: "other", content: "https://a.test@b.test", edited_at: null as string | null };
  const first = renderHook(() => useSpamVisibility(message));
  await act(async () => { await first.result.current.restore(); });
  first.unmount();
  const next = renderHook(({ value }) => useSpamVisibility(value), { initialProps: { value: message } });
  expect(next.result.current.hidden).toBe(false);
  next.rerender({ value: { ...message, edited_at: "2026-10-24T12:00:00Z" } });
  expect(next.result.current.hidden).toBe(true);
  expect(JSON.stringify(usePreferencesStore.getState().data)).not.toContain("https://");
});
