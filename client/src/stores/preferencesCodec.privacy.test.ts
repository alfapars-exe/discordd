import { expect, it } from "vitest";
import { cacheable } from "./preferencesCodec";

const dictionaryFields = [
  "friendRequests", "spamRestoredMessages", "ignoredUsers", "serverDMOverrides",
  "gameActivityServerOverrides", "sensitiveMedia", "disturbingMedia",
] as const;

it.each(dictionaryFields)("preserves an explicit empty %s dictionary for account reset", field => {
  expect(cacheable({ privacy: { [field]: {} } })).toEqual({ privacy: { [field]: {} } });
});

const malformedDictionaries = dictionaryFields.flatMap(field =>
  [null, false, 42, "enabled", [], [true]].map(value => ({ field, value })),
);
it.each(malformedDictionaries)("rejects malformed $field dictionary $value", ({ field, value }) => {
  expect(cacheable({ privacy: { [field]: value } })).toEqual({});
});

const idDictionaries = [
  { field: "spamRestoredMessages", maxIdLength: 128, value: "revision" },
  { field: "ignoredUsers", maxIdLength: 128, value: false },
  { field: "serverDMOverrides", maxIdLength: 128, value: true },
  { field: "gameActivityServerOverrides", maxIdLength: 256, value: false },
] as const;

it.each(idDictionaries)("preserves both ID boundaries and rejects malformed keys in $field", ({ field, maxIdLength, value }) => {
  for (const id of ["a", "a".repeat(maxIdLength)]) {
    expect(cacheable({ privacy: { [field]: { [id]: value } } })).toEqual({ privacy: { [field]: { [id]: value } } });
  }
  for (const id of ["", "a".repeat(maxIdLength + 1)]) {
    expect(cacheable({ privacy: { [field]: { valid: value, [id]: value } } })).toEqual({});
  }
});

it.each(idDictionaries)("accepts 1024 $field entries and rejects 1025 without truncating", ({ field, value }) => {
  const accepted = Object.fromEntries(Array.from({ length: 1024 }, (_, index) => [`id-${index}`, value]));
  expect(cacheable({ privacy: { [field]: accepted } })).toEqual({ privacy: { [field]: accepted } });
  expect(cacheable({ privacy: { [field]: { ...accepted, overflow: value } } })).toEqual({});
});

it.each(["ignoredUsers", "serverDMOverrides", "gameActivityServerOverrides"])("rejects the entire %s dictionary when one boolean is malformed", field => {
  for (const value of [0, 1, "false", null, {}, []]) {
    expect(cacheable({ privacy: { [field]: { valid: true, malformed: value } } })).toEqual({});
  }
});

it("preserves empty and 64-character restored revisions but rejects a malformed revision", () => {
  for (const revision of ["", "r".repeat(64)]) {
    expect(cacheable({ privacy: { spamRestoredMessages: { message: revision } } })).toEqual({ privacy: { spamRestoredMessages: { message: revision } } });
  }
  for (const revision of ["r".repeat(65), false, 123, null, {}]) {
    expect(cacheable({ privacy: { spamRestoredMessages: { valid: "revision", malformed: revision } } })).toEqual({});
  }
});

it("retains all three friend request choices and rejects unknown or malformed choices", () => {
  const choices = { everyone: false, mutual: true, server: false };
  expect(cacheable({ privacy: { friendRequests: choices } })).toEqual({ privacy: { friendRequests: choices } });
  for (const malformed of [{ unknown: true }, { ...choices, extra: false }, { everyone: "false" }]) {
    expect(cacheable({ privacy: { friendRequests: malformed } })).toEqual({});
  }
});

it.each(["sensitiveMedia", "disturbingMedia"])("retains scope-specific %s choices and rejects unknown scopes or modes", field => {
  const choices = { friendDMs: "show", otherDMs: "blur", channels: "block" };
  expect(cacheable({ privacy: { [field]: choices } })).toEqual({ privacy: { [field]: choices } });
  for (const malformed of [{ unknown: "show" }, { ...choices, extra: "show" }, { channels: "SHOW" }, { friendDMs: false }]) {
    expect(cacheable({ privacy: { [field]: malformed } })).toEqual({});
  }
});

it("retains valid neighboring fields while dropping a malformed dictionary", () => {
  expect(cacheable({ privacy: { serverDMDefault: false, ignoredUsers: { invalid: "true" }, friendRequests: {} } })).toEqual({
    privacy: { serverDMDefault: false, friendRequests: {} },
  });
});
