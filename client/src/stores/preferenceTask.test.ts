import { describe, expect, it, vi } from "vitest";
import { startPreferenceTask } from "./preferenceTask";
import { retirePreferenceScope } from "./preferenceScope";

describe("detached preference task ownership", () => {
  it("invokes immediately and observes a synchronous factory failure", () => {
    const report = vi.fn();
    const run = vi.fn(() => { throw new Error("factory"); });
    expect(() => startPreferenceTask(run, report)).not.toThrow();
    expect(run).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledOnce();
  });

  it("observes a retired factory failure without reporting into its replacement", () => {
    const report = vi.fn();
    startPreferenceTask(() => {
      retirePreferenceScope();
      throw new Error("retired factory");
    }, report);
    expect(report).not.toHaveBeenCalled();
  });

  it("reports an asynchronous rejection only while its binding is current", async () => {
    const current = vi.fn();
    startPreferenceTask(() => Promise.reject(new Error("current")), current);
    await Promise.resolve();
    expect(current).toHaveBeenCalledOnce();
    const retired = vi.fn();
    startPreferenceTask(() => Promise.reject(new Error("retired")), retired);
    retirePreferenceScope();
    await Promise.resolve();
    expect(retired).not.toHaveBeenCalled();
  });
});
