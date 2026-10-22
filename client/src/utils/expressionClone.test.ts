import { describe, it, expect } from "vitest";
import { alreadyCloned, canCloneHere, cloneErrorKey, type CloneableItem } from "./expressionClone";
import { Permissions } from "./permissions";

const SRC = "0123456789abcdef";
const item: CloneableItem = { id: SRC, server_id: "s-src", copyable: true, cloned_from: null };
const ctx = { activeServerId: "s-dst", perms: Permissions.ManageExpressions, existing: [] };

describe("canCloneHere", () => {
  it("allows a copyable original from another server with ManageExpressions", () => {
    expect(canCloneHere(item, ctx)).toBe(true);
  });
  it("Admin implies ManageExpressions", () => {
    expect(canCloneHere(item, { ...ctx, perms: Permissions.Admin })).toBe(true);
  });
  it("not in catalog (null) → false", () => {
    expect(canCloneHere(null, ctx)).toBe(false);
    expect(canCloneHere(undefined, ctx)).toBe(false);
  });
  it("no active server (DM) → false", () => {
    expect(canCloneHere(item, { ...ctx, activeServerId: null })).toBe(false);
  });
  it("not copyable → false", () => {
    expect(canCloneHere({ ...item, copyable: false }, ctx)).toBe(false);
  });
  it("a clone is never cloneable", () => {
    expect(canCloneHere({ ...item, cloned_from: "ffffffffffffffff" }, ctx)).toBe(false);
  });
  it("same server → false", () => {
    expect(canCloneHere({ ...item, server_id: "s-dst" }, ctx)).toBe(false);
  });
  it("missing ManageExpressions → false", () => {
    expect(canCloneHere(item, { ...ctx, perms: 0 })).toBe(false);
  });
  it("already cloned into the target → false", () => {
    expect(canCloneHere(item, { ...ctx, existing: [{ cloned_from: SRC }] })).toBe(false);
    expect(canCloneHere(item, { ...ctx, existing: [{ cloned_from: null }, { cloned_from: "x" }] })).toBe(true);
  });
});

describe("alreadyCloned", () => {
  it("matches on cloned_from", () => {
    expect(alreadyCloned(SRC, [{ cloned_from: SRC }])).toBe(true);
    expect(alreadyCloned(SRC, [])).toBe(false);
  });
});

describe("cloneErrorKey", () => {
  it("maps server codes", () => {
    expect(cloneErrorKey({ code: "EXPRESSION_NOT_COPYABLE" }, "emoji")).toBe("notCopyable");
    expect(cloneErrorKey({ code: "EXPRESSION_CLONE_SAME_SERVER" }, "emoji")).toBe("cloneSameServer");
    expect(cloneErrorKey({ code: "EXPRESSION_NOT_FOUND" }, "sticker")).toBe("expressionNotFound");
    expect(cloneErrorKey({ code: "EXPRESSION_NAME_TAKEN" }, "sticker")).toBe("nameTaken");
  });
  it("limit message depends on kind", () => {
    expect(cloneErrorKey({ code: "EXPRESSION_LIMIT_REACHED" }, "emoji")).toBe("limitReached");
    expect(cloneErrorKey({ code: "EXPRESSION_LIMIT_REACHED" }, "sticker")).toBe("stickerLimitReached");
  });
  it("falls back on status, then generic", () => {
    expect(cloneErrorKey({ status: 409 }, "emoji")).toBe("nameTaken");
    expect(cloneErrorKey({ status: 404 }, "emoji")).toBe("expressionNotFound");
    expect(cloneErrorKey({ status: 500 }, "emoji")).toBe("cloneFailed");
  });
});
