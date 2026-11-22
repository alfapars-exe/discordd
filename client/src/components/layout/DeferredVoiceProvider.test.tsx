import { useEffect, type ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SectionErrorBoundary from "../shared/SectionErrorBoundary";

vi.mock("../../api/clientLog", () => ({ logToServer: vi.fn() }));
vi.mock("../../monitoring/sentry", () => ({ captureBoundaryError: vi.fn() }));
vi.mock("../../i18n", () => ({ default: { t: (_key: string, options: { defaultValue: string }) => options.defaultValue } }));
const mounted = vi.fn(), unmounted = vi.fn();
function TestProvider({ children }: { children: ReactNode }) {
  useEffect(() => { mounted(); return () => { unmounted(); }; }, []);
  return <div data-testid="provider">{children}</div>;
}
type Module = { default: typeof TestProvider };
function deferred() {
  let resolve!: (value: Module) => void, reject!: (error: unknown) => void;
  const promise = new Promise<Module>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function setup() {
  const module = deferred(), load = vi.fn(() => module.promise);
  vi.doMock("../voice/VoiceProvider", load);
  const { default: DeferredVoiceProvider } = await import("./DeferredVoiceProvider");
  return { module, load, DeferredVoiceProvider };
}
beforeEach(() => { vi.resetModules(); mounted.mockClear(); unmounted.mockClear(); });
afterEach(() => { vi.doUnmock("../voice/VoiceProvider"); vi.restoreAllMocks(); });

it("does not import or mount the provider until the active-session wrapper mounts", async () => {
  const { module, load, DeferredVoiceProvider } = await setup();
  expect(load).not.toHaveBeenCalled();
  const view = render(<DeferredVoiceProvider><p>current body</p></DeferredVoiceProvider>);
  expect(screen.getByText("current body")).toBeInTheDocument();
  expect(screen.queryByTestId("provider")).toBeNull(); expect(mounted).not.toHaveBeenCalled();
  await act(async () => { module.resolve({ default: TestProvider }); });
  await waitFor(() => expect(screen.getByTestId("provider")).toBeInTheDocument());
  expect(load).toHaveBeenCalledOnce(); expect(mounted).toHaveBeenCalledOnce(); view.unmount();
});

it("uses latest pending children and keeps the loaded provider mounted across rerenders", async () => {
  const { module, load, DeferredVoiceProvider } = await setup();
  const view = render(<DeferredVoiceProvider><p>first body</p></DeferredVoiceProvider>);
  view.rerender(<DeferredVoiceProvider><p>latest body</p></DeferredVoiceProvider>);
  expect(screen.queryByText("first body")).toBeNull(); expect(screen.getByText("latest body")).toBeInTheDocument();
  await act(async () => { module.resolve({ default: TestProvider }); });
  await waitFor(() => expect(mounted).toHaveBeenCalledOnce());
  view.rerender(<DeferredVoiceProvider><p>new destination</p></DeferredVoiceProvider>);
  expect(screen.getByText("new destination")).toBeInTheDocument();
  expect(mounted).toHaveBeenCalledOnce(); expect(unmounted).not.toHaveBeenCalled(); expect(load).toHaveBeenCalledOnce(); view.unmount();
});

it("never mounts after leaving during import and adopts the component immediately on rejoin", async () => {
  const { module, load, DeferredVoiceProvider } = await setup();
  const view = render(<DeferredVoiceProvider><p>session</p></DeferredVoiceProvider>);
  view.unmount();
  await act(async () => { module.resolve({ default: TestProvider }); });
  await vi.dynamicImportSettled();
  expect(mounted).not.toHaveBeenCalled();
  const next = render(<DeferredVoiceProvider><p>new session</p></DeferredVoiceProvider>);
  // No effect or promise turn is needed once the module cache is populated.
  expect(screen.getByTestId("provider")).toBeInTheDocument();
  expect(mounted).toHaveBeenCalledOnce(); expect(load).toHaveBeenCalledOnce(); next.unmount();
});

it("shares a pending import while independently retiring an obsolete wrapper", async () => {
  const { module, load, DeferredVoiceProvider } = await setup();
  const obsolete = render(<DeferredVoiceProvider><p>old</p></DeferredVoiceProvider>);
  const current = render(<DeferredVoiceProvider><p>current</p></DeferredVoiceProvider>);
  obsolete.unmount();
  await act(async () => { module.resolve({ default: TestProvider }); });
  await waitFor(() => expect(mounted).toHaveBeenCalledOnce());
  expect(screen.queryByText("old")).toBeNull(); expect(screen.getByText("current")).toBeInTheDocument();
  expect(load).toHaveBeenCalledOnce(); current.unmount();
});

it.each([new Error("module unavailable"), undefined])("routes a rejected import to the existing section boundary and permits retry (%s)", async failure => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { module, DeferredVoiceProvider } = await setup();
  const view = render(<SectionErrorBoundary section="voice"><DeferredVoiceProvider><p>body</p></DeferredVoiceProvider></SectionErrorBoundary>);
  await act(async () => { module.reject(failure); });
  await waitFor(() => expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument());
  expect(mounted).not.toHaveBeenCalled();
  // Simulate a subsequent successful module delivery after a transient load failure.
  vi.doMock("../voice/VoiceProvider", () => ({ default: TestProvider }));
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(screen.getByTestId("provider")).toBeInTheDocument());
  expect(mounted).toHaveBeenCalledOnce(); view.unmount();
});

it("ignores a load failure after the wrapper unmounts", async () => {
  const { module, DeferredVoiceProvider } = await setup();
  const view = render(<SectionErrorBoundary section="voice"><DeferredVoiceProvider><p>body</p></DeferredVoiceProvider></SectionErrorBoundary>);
  view.unmount();
  await act(async () => { module.reject(new Error("late load failure")); });
  await vi.dynamicImportSettled();
  expect(mounted).not.toHaveBeenCalled(); expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
});
