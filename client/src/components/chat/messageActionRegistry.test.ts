import { describe, expect, it, vi } from "vitest";
import { buildMessageActions, type MessageActionRegistryInput } from "./messageActionRegistry";

function input(overrides: Partial<MessageActionRegistryInput> = {}): MessageActionRegistryInput {
  const labels = Object.fromEntries([
    "reply", "reaction", "forward", "thread", "copy", "speak", "copy-link", "save", "mark-unread", "reminder",
    "applications", "applications-empty", "report", "pin", "edit", "delete", "copy-id",
  ].map((key) => [key, key])) as MessageActionRegistryInput["labels"];
  const noop = vi.fn();
  return {
    labels, hasContent: true, isOwner: false, isSaved: false, isPinned: false,
    canManageMessages: false, developerMode: false, supportsApplications: false, supportsThreads: false,
    applicationActions: [], onApplicationAction: noop, onReply: noop, onReaction: noop,
    onForward: noop, onThread: noop, onCopy: noop, onSpeak: noop, onCopyLink: noop, onSaveToggle: noop, onMarkUnread: noop,
    onRemind: noop, onReport: noop, onPinToggle: noop, onEdit: noop, onDelete: noop,
    onCopyID: noop, ...overrides,
  };
}

describe("message action registry", () => {
  it("keeps universal actions in one stable order", () => {
    expect(buildMessageActions(input()).map((action) => action.id)).toEqual([
      "reply", "reaction", "forward", "copy", "speak", "copy-link", "save", "mark-unread", "reminder", "report",
    ]);
  });

  it("applies owner, moderator and developer visibility once for all surfaces", () => {
    expect(buildMessageActions(input({ isOwner: true, canManageMessages: true, developerMode: true }))
      .map((action) => action.id)).toEqual([
        "reply", "reaction", "forward", "copy", "speak", "copy-link", "save", "mark-unread", "reminder",
        "pin", "edit", "delete", "copy-id",
      ]);
  });

  it("exposes application children from the same registry", () => {
    const actions = buildMessageActions(input({
      supportsApplications: true,
      applicationActions: [{ id: "a", application_id: "app", name: "inspect", label: "Inspect", context: "message" }],
    }));
    expect(actions.find((action) => action.id === "applications")?.children?.map((child) => child.label))
      .toEqual(["Inspect"]);
  });
});
