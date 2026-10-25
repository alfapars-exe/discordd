import { beforeEach, expect, it, vi } from "vitest";
import { registerSpamBatch, registerSpamMessage } from "./registerSpamMessage";
import { recordSpam } from "../api/spam";
const state = vi.hoisted(() => ({ user: { id: "account" }, generation: 0, toast: vi.fn() }));
vi.mock("../api/client", () => ({ getAuthGeneration: () => state.generation }));
vi.mock("../api/spam", () => ({ recordSpam: vi.fn() }));
vi.mock("../stores/authStore", () => ({ useAuthStore: { getState: () => ({ user: state.user }) } }));
vi.mock("../stores/toastStore", () => ({ useToastStore: { getState: () => ({ addToast: state.toast }) } }));
vi.mock("./messageSpamPolicy", () => ({ isMessageFilteredAsSpam: () => true }));
vi.mock("../i18n", () => ({ default: { t: (key: string) => key } }));
const message = { id: "message", user_id: "sender", content: "https://trusted.test@evil.test" };
beforeEach(() => { vi.clearAllMocks(); state.user = { id: "account" }; state.generation = 0; vi.mocked(recordSpam).mockResolvedValue({ success: true }); });
it("sends source metadata without decrypted text and binds the request to its account", async () => {
  await registerSpamMessage(message, "dm", "private");
  const [body, , isCurrent] = vi.mocked(recordSpam).mock.calls[0];
  expect(body).toEqual({ source_kind: "dm", channel_id: "private", message_id: "message", revision: "original", reasons: ["credential-link"] });
  expect(JSON.stringify(body)).not.toContain(message.content);
  expect(isCurrent?.()).toBe(true);
  state.user = { id: "other-account" };
  expect(isCurrent?.()).toBe(false);
});
it("bounds batch registration to four concurrent requests", async () => {
  let active = 0, maximum = 0;
  vi.mocked(recordSpam).mockImplementation(async () => {
    active++; maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active--; return { success: true };
  });
  await registerSpamBatch(Array.from({ length: 11 }, (_, index) => ({ ...message, id: String(index) })), "dm", "private");
  expect(recordSpam).toHaveBeenCalledTimes(11);
  expect(maximum).toBe(4);
});

it("suppresses stale-generation completion and failure toast for the same account", async () => {
  let resolve!: (value: { success: boolean; error: string }) => void;
  vi.mocked(recordSpam).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  const pending = registerSpamMessage(message, "dm", "private");
  const requestGuard = vi.mocked(recordSpam).mock.calls[0][2];
  expect(requestGuard?.()).toBe(true);

  state.generation++;
  expect(requestGuard?.()).toBe(false);
  resolve({ success: false, error: "stale failure" });
  expect(await pending).toBe(false);
  expect(state.toast).not.toHaveBeenCalled();
});
