/** MentionAutocomplete — @mention popup with keyboard navigation. Shows users and mentionable roles. */

import { useState, useEffect, useCallback, useMemo } from "react";
import { useMemberStore } from "../../stores/memberStore";
import { useRoleStore } from "../../stores/roleStore";
import { useServerStore } from "../../stores/serverStore";
import Avatar from "../shared/Avatar";
import type { MemberWithRoles, Role } from "../../types";

export type MentionSelection = {
  id: string;
  name: string;
  type: "user" | "role";
};

type MentionAutocompleteProps = {
  /** Search text after @ (e.g. "ali" -> @ali) */
  query: string;
  /** Server ID this channel belongs to (uses active server if omitted) */
  serverId?: string;
  /** Called when user or role is selected */
  onSelect: (mention: MentionSelection) => void;
  /** Close popup (Escape or empty results) */
  onClose: () => void;
};

/** Max visible results */
const MAX_RESULTS = 7;

type MentionItem =
  | { type: "user"; member: MemberWithRoles }
  | { type: "role"; role: Role };

function MentionAutocomplete({ query, serverId, onSelect, onClose }: MentionAutocompleteProps) {
  const activeServerId = useServerStore((s) => s.activeServerId);
  const effectiveServerId = serverId ?? activeServerId;

  const membersByServer = useMemberStore((s) => s.membersByServer);
  const rolesByServer = useRoleStore((s) => s.rolesByServer);
  const fetchMembers = useMemberStore((s) => s.fetchMembers);
  const fetchRoles = useRoleStore((s) => s.fetchRoles);

  // Lazy-fetch if this server's data isn't cached yet
  useEffect(() => {
    if (!effectiveServerId) return;
    if (!membersByServer[effectiveServerId]) fetchMembers(effectiveServerId);
    if (!rolesByServer[effectiveServerId]) fetchRoles(effectiveServerId);
  }, [effectiveServerId, membersByServer, rolesByServer, fetchMembers, fetchRoles]);

  // Wrap in useMemo so the filtered-list memo below gets stable
  // references — `effectiveServerId ? store[id] : []` would otherwise
  // allocate a fresh `[]` every render and bust the downstream memo.
  const members = useMemo<MemberWithRoles[]>(
    () => (effectiveServerId ? (membersByServer[effectiveServerId] ?? []) : []),
    [effectiveServerId, membersByServer]
  );
  const roles = useMemo<Role[]>(
    () => (effectiveServerId ? (rolesByServer[effectiveServerId] ?? []) : []),
    [effectiveServerId, rolesByServer]
  );
  const [activeIndex, setActiveIndex] = useState(0);

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    const items: MentionItem[] = [];

    // Mentionable roles first
    for (const role of roles) {
      if (!role.mentionable) continue;
      if (role.name.toLowerCase().includes(q)) {
        items.push({ type: "role", role });
      }
    }

    // Then users
    for (const m of members) {
      if (
        m.username.toLowerCase().includes(q) ||
        (m.display_name?.toLowerCase().includes(q) ?? false)
      ) {
        items.push({ type: "user", member: m });
      }
      if (items.length >= MAX_RESULTS) break;
    }

    return items.slice(0, MAX_RESULTS);
  }, [query, members, roles]);

  // Reset the highlight to the top entry whenever the user changes
  // their @mention query — the existing list no longer corresponds to
  // the new filter so the previous index is stale. React docs allow
  // calling setState during render when guarded by a "did the input
  // change?" check; the cascading-render rule's set-state-in-effect
  // warning doesn't fire for this pattern because there's no effect.
  const [lastQuery, setLastQuery] = useState(query);
  if (query !== lastQuery) {
    setLastQuery(query);
    setActiveIndex(0);
  }

  // Auto-close when the query matches nothing — the popup would just
  // render an empty box otherwise. Stays in a useEffect because
  // onClose lives in the parent and we need to call it outside the
  // render commit (calling it during render would re-enter the parent
  // mid-render).
  useEffect(() => {
    if (filtered.length === 0 && query.length > 0) {
      onClose();
    }
  }, [filtered.length, query.length, onClose]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (filtered.length === 0) return;

      switch (e.key) {
        case "ArrowUp":
          e.preventDefault();
          setActiveIndex((prev) => (prev > 0 ? prev - 1 : filtered.length - 1));
          break;
        case "ArrowDown":
          e.preventDefault();
          setActiveIndex((prev) => (prev < filtered.length - 1 ? prev + 1 : 0));
          break;
        case "Enter":
        case "Tab":
          e.preventDefault();
          if (filtered[activeIndex]) {
            const item = filtered[activeIndex];
            if (item.type === "user") {
              onSelect({ id: item.member.id, name: item.member.username, type: "user" });
            } else {
              onSelect({ id: item.role.id, name: item.role.name, type: "role" });
            }
          }
          break;
        case "Escape":
          e.preventDefault();
          onClose();
          break;
      }
    },
    [filtered, activeIndex, onSelect, onClose]
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [handleKeyDown]);

  if (filtered.length === 0) return null;

  return (
    <div className="mention-popup">
      {filtered.map((item, index) => {
        if (item.type === "role") {
          return (
            <button
              key={`role-${item.role.id}`}
              className={`mention-item${index === activeIndex ? " active" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect({ id: item.role.id, name: item.role.name, type: "role" });
              }}
              onMouseEnter={() => setActiveIndex(index)}
            >
              <span
                className="mention-role-dot"
                style={{ backgroundColor: item.role.color }}
              />
              <span className="mention-item-name">@{item.role.name}</span>
              <span className="mention-item-tag">Role</span>
            </button>
          );
        }

        const member = item.member;
        return (
          <button
            key={member.id}
            className={`mention-item${index === activeIndex ? " active" : ""}`}
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect({ id: member.id, name: member.username, type: "user" });
            }}
            onMouseEnter={() => setActiveIndex(index)}
          >
            <div className="mention-item-avatar">
              <Avatar
                name={member.display_name ?? member.username}
                avatarUrl={member.avatar_url ?? undefined}
                size={22}
              />
            </div>
            <span className="mention-item-name">
              {member.display_name ?? member.username}
            </span>
            <span className="mention-item-username">
              @{member.username}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export default MentionAutocomplete;
