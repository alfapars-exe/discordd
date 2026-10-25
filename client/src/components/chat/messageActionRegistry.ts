import type { ApplicationAction } from "../../api/applications";

export type MessageActionID =
  | "reply"
  | "reaction"
  | "forward"
  | "thread"
  | "copy"
  | "speak"
  | "copy-link"
  | "save"
  | "mark-unread"
  | "reminder"
  | "applications"
  | "report"
  | "pin"
  | "edit"
  | "delete"
  | "copy-id";

export type MessageAction = {
  id: MessageActionID;
  label: string;
  run: () => void;
  danger?: boolean;
  separator?: boolean;
  disabled?: boolean;
  children?: MessageAction[];
};

export type MessageActionRegistryInput = {
  labels: Record<MessageActionID | "applications-empty", string>;
  hasContent: boolean;
  isOwner: boolean;
  isSaved: boolean;
  isPinned: boolean;
  canManageMessages: boolean;
  developerMode: boolean;
  supportsApplications: boolean;
  supportsThreads: boolean;
  applicationActions: ApplicationAction[];
  onApplicationAction: (action: ApplicationAction) => void;
  onReply: () => void;
  onReaction: () => void;
  onForward: () => void;
  onThread: () => void;
  onCopy: () => void;
  onSpeak: () => void;
  onCopyLink: () => void;
  onSaveToggle: () => void;
  onMarkUnread: () => void;
  onRemind: () => void;
  onReport: () => void;
  onPinToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onCopyID: () => void;
};

/**
 * The canonical message-action registry shared by pointer and touch UIs.
 * Visibility and ordering live here so adding an action cannot silently leave
 * mobile or desktop behind.
 */
export function buildMessageActions(input: MessageActionRegistryInput): MessageAction[] {
  const actions: MessageAction[] = [
    { id: "reply", label: input.labels.reply, run: input.onReply },
    { id: "reaction", label: input.labels.reaction, run: input.onReaction },
    { id: "forward", label: input.labels.forward, run: input.onForward },
  ];
  if (input.supportsThreads) actions.push({ id: "thread", label: input.labels.thread, run: input.onThread });

  if (input.hasContent) actions.push({ id: "copy", label: input.labels.copy, run: input.onCopy }, { id: "speak", label: input.labels.speak, run: input.onSpeak });
  actions.push(
    { id: "copy-link", label: input.labels["copy-link"], run: input.onCopyLink },
    { id: "save", label: input.labels.save, run: input.onSaveToggle },
    { id: "mark-unread", label: input.labels["mark-unread"], run: input.onMarkUnread },
    { id: "reminder", label: input.labels.reminder, run: input.onRemind },
  );

  if (input.supportsApplications) {
    actions.push({
      id: "applications",
      label: input.labels.applications,
      run: () => undefined,
      separator: true,
      children: input.applicationActions.length > 0
        ? input.applicationActions.map((action) => ({
            id: "applications" as const,
            label: action.label,
            run: () => input.onApplicationAction(action),
          }))
        : [{ id: "applications", label: input.labels["applications-empty"], run: () => undefined, disabled: true }],
    });
  }

  if (!input.isOwner) {
    actions.push({ id: "report", label: input.labels.report, run: input.onReport, danger: true, separator: true });
  }
  if (input.canManageMessages) {
    actions.push({ id: "pin", label: input.labels.pin, run: input.onPinToggle, separator: true });
  }
  if (input.isOwner) {
    actions.push({ id: "edit", label: input.labels.edit, run: input.onEdit, separator: !input.canManageMessages });
  }
  if (input.isOwner || input.canManageMessages) {
    actions.push({ id: "delete", label: input.labels.delete, run: input.onDelete, danger: true });
  }
  if (input.developerMode) {
    actions.push({ id: "copy-id", label: input.labels["copy-id"], run: input.onCopyID, separator: true });
  }
  return actions;
}
