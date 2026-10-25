import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import GroupConversationLauncher from "./GroupConversationLauncher";
const state = vi.hoisted(() => ({ user: { id: "a" }, generation: 1 }));
vi.mock("../../stores/authStore", () => ({ useAuthStore: (select: (value: typeof state) => unknown) => select(state) }));
vi.mock("../../api/client", () => ({ getAuthGeneration: () => state.generation }));
vi.mock("../../utils/conversationCommands", () => ({ CONVERSATION_CREATE_GROUP_EVENT: "hichat:create-group-conversation" }));
vi.mock("./NewConversationModal", () => ({ default: ({ initialGroupMode }: { initialGroupMode: boolean }) => <div role="dialog">{initialGroupMode ? "Group" : "DM"}</div> }));
afterEach(() => { cleanup(); state.user = { id:"a" }; state.generation = 1; });
it("opens group creation without a mounted DM sidebar and never revives another session's modal", () => {
  const view = render(<GroupConversationLauncher />);
  act(() => { window.dispatchEvent(new Event("hichat:create-group-conversation")); });
  expect(screen.getByRole("dialog")).toHaveTextContent("Group");
  state.user = { id:"b" }; state.generation++;
  view.rerender(<GroupConversationLauncher />);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  state.user = { id:"a" }; state.generation++;
  view.rerender(<GroupConversationLauncher />);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  act(() => { window.dispatchEvent(new Event("hichat:create-group-conversation")); });
  expect(screen.getByRole("dialog")).toHaveTextContent("Group");
});
it("does not open over an existing dialog", () => {
  const view = render(<><div role="dialog">Existing</div><GroupConversationLauncher /></>);
  act(() => { window.dispatchEvent(new Event("hichat:create-group-conversation")); });
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  view.unmount();
});
