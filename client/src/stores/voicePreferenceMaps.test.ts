import { expect, it } from "vitest";
import { ownVoicePeerValue, voicePeerVolume } from "./voicePreferenceMaps";

it.each(["toString", "hasOwnProperty", "valueOf"])("uses only own peer values for %s while preserving explicit zero and false", id => {
  expect(voicePeerVolume({}, id)).toBe(100);
  expect(ownVoicePeerValue({}, id)).toBeUndefined();
  expect(voicePeerVolume({ [id]: 0 }, id)).toBe(0);
  expect(ownVoicePeerValue({ [id]: false }, id)).toBe(false);
  expect(voicePeerVolume(Object.create({ [id]: 75 }), id)).toBe(100);
});
