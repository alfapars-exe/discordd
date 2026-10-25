import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import ServerCreationLauncher from "./ServerCreationLauncher";

const state = vi.hoisted(() => ({ user: { id: "a" } as { id: string } | null, generation: 1 }));
vi.mock("../../stores/authStore", () => ({
  useAuthStore: (select: (value: typeof state) => unknown) => select(state),
}));
vi.mock("../../api/client", () => ({ getAuthGeneration: () => state.generation }));
vi.mock("./AddServerModal", () => ({ default: () => <div role="dialog">Add server modal</div> }));

afterEach(() => {
  cleanup();
  state.user = { id: "a" };
  state.generation = 1;
});

it("ignores server-creation events while single-server mode is active", () => {
  const view = render(<ServerCreationLauncher />);
  act(() => window.dispatchEvent(new Event("hichat:open-add-server")));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

  state.user = { id: "b" };
  state.generation++;
  view.rerender(<ServerCreationLauncher />);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

  state.user = { id: "a" };
  state.generation++;
  view.rerender(<ServerCreationLauncher />);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  act(() => window.dispatchEvent(new Event("hichat:open-add-server")));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

  state.user = { id: "a" };
  state.generation++;
  view.rerender(<ServerCreationLauncher />);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("does not open over an existing dialog or menu", () => {
  const view = render(<><div role="dialog">Existing</div><ServerCreationLauncher /></>);
  act(() => window.dispatchEvent(new Event("hichat:open-add-server")));
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  view.rerender(<><div role="menu">Existing menu</div><ServerCreationLauncher /></>);
  act(() => window.dispatchEvent(new Event("hichat:open-add-server")));
  expect(screen.queryByText("Add server modal")).not.toBeInTheDocument();
});
