import { expect, it, vi } from "vitest";
import { loginCredentialOperation } from "./loginCredentialOperation";

it("returns the native save promise and preserves its receiver and origin", () => {
  const saved = Promise.resolve();
  const bridge = {
    saveCredentials: vi.fn(function (this: unknown, username: string, password: string, origin: string) {
      expect(this).toBe(bridge);
      expect([username, password, origin]).toEqual(["fixture-user", "fixture-password", "https://chat.example"]);
      return saved;
    }),
    clearCredentials: vi.fn(),
  };
  expect(loginCredentialOperation(bridge, true, "fixture-user", "fixture-password", "https://chat.example")).toBe(saved);
  expect(bridge.clearCredentials).not.toHaveBeenCalled();
});

it("returns the native clear promise without sending credentials", () => {
  const cleared = Promise.resolve();
  const bridge = { saveCredentials: vi.fn(), clearCredentials: vi.fn(() => cleared) };
  expect(loginCredentialOperation(bridge, false, "fixture-user", "fixture-password", "https://chat.example")).toBe(cleared);
  expect(bridge.clearCredentials).toHaveBeenCalledExactlyOnceWith();
  expect(bridge.saveCredentials).not.toHaveBeenCalled();
});

it.each([true, false])("keeps the absent-bridge result synchronous (remember=%s)", remember => {
  expect(loginCredentialOperation(undefined, remember, "fixture-user", "fixture-password", "https://chat.example")).toBeUndefined();
});

it("keeps a synchronous native failure synchronous with its original identity", () => {
  const failure = new Error("fixture native failure");
  const bridge = { saveCredentials() { throw failure; }, clearCredentials: vi.fn() };
  let caught: unknown;
  try { loginCredentialOperation(bridge, true, "fixture-user", "fixture-password", "https://chat.example"); } catch (error) { caught = error; }
  expect(caught).toBe(failure);
});
