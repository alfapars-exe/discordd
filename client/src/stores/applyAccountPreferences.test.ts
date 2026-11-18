import { beforeEach, expect, it, vi } from "vitest";
import { applyAccountPreferences } from "./applyAccountPreferences";
import type { PreferencesData } from "./preferencesCodec";

const actions=vi.hoisted(()=>({
  settingsReset:vi.fn(),sidebarReset:vi.fn(),voiceReset:vi.fn(),accessibilityReset:vi.fn(),timeReset:vi.fn(),
  theme:vi.fn(),appearance:vi.fn(),sidebar:vi.fn(),voice:vi.fn(),accessibility:vi.fn(),locale:vi.fn(),
}));
vi.mock("./settingsStore",()=>({useSettingsStore:{getState:()=>({resetAccountPreferences:actions.settingsReset,applyFromServer:actions.theme,applyAppearanceFromServer:actions.appearance})}}));
vi.mock("./sidebarStore",()=>({useSidebarStore:{getState:()=>({resetAccountPreferences:actions.sidebarReset,applyFromServer:actions.sidebar})}}));
vi.mock("./voiceStore",()=>({useVoiceStore:{getState:()=>({resetAccountPreferences:actions.voiceReset,applyFromServer:actions.voice})}}));
vi.mock("./accessibilityStore",()=>({useAccessibilityStore:{getState:()=>({resetAccountPreferences:actions.accessibilityReset,applyFromServer:actions.accessibility})}}));
vi.mock("./timeFormatStore",()=>({useTimeFormatStore:{getState:()=>({resetAccountPreferences:actions.timeReset,applyFromServer:actions.locale})}}));
const resetActions=["settingsReset","sidebarReset","voiceReset","accessibilityReset","timeReset"] as const;
const applyActions=["theme","appearance","sidebar","voice","accessibility","locale"] as const;
const data:PreferencesData={theme:"alice",appearance:{uiScale:130},sidebar_sections:{alice:true},voice_settings:{masterVolume:45},accessibility:{reducedMotion:true},locale:{timeFormat:"24h"}};
beforeEach(()=>vi.resetAllMocks());

it("does not reset any destination when the account is already retired",()=>{
  applyAccountPreferences(()=>null,true,true);
  for(const action of Object.values(actions))expect(action).not.toHaveBeenCalled();
});
it.each(resetActions)("stops remaining destination resets after account retirement in %s",boundary=>{
  let current=true;
  actions[boundary].mockImplementationOnce(()=>{current=false;});
  applyAccountPreferences(()=>current?data:null,true,true);
  for(const key of resetActions.slice(resetActions.indexOf(boundary)+1))expect(actions[key]).not.toHaveBeenCalled();
  for(const key of applyActions)expect(actions[key]).not.toHaveBeenCalled();
});
it.each(applyActions.slice(0,-1))("stops remaining preference application after account retirement in %s",boundary=>{
  let current=true;
  actions[boundary].mockImplementationOnce(()=>{current=false;});
  applyAccountPreferences(()=>current?data:null,false,true);
  for(const key of applyActions.slice(applyActions.indexOf(boundary)+1))expect(actions[key]).not.toHaveBeenCalled();
});
it("reads the latest same-account values after a synchronous destination subscriber edits preferences",()=>{
  let latest=structuredClone(data);
  actions.theme.mockImplementationOnce(()=>{latest={...latest,voice_settings:{masterVolume:75}};});
  applyAccountPreferences(()=>structuredClone(latest),false,true);
  expect(actions.voice).toHaveBeenCalledExactlyOnceWith({masterVolume:75});
});

it.each([false, true])("resets destinations in order before applying account values (preserve session=%s)", preserveSessionState => {
  const calls: string[] = [];
  for (const [name, action] of Object.entries(actions)) action.mockImplementation(() => { calls.push(name); });

  applyAccountPreferences(() => data, true, preserveSessionState);

  expect(calls).toEqual([...resetActions, ...applyActions]);
  expect(actions.settingsReset).toHaveBeenCalledExactlyOnceWith(preserveSessionState, expect.any(Function));
  expect(actions.voiceReset.mock.calls).toEqual([preserveSessionState ? [true] : []]);
  for (const name of ["sidebarReset", "accessibilityReset", "timeReset"] as const) {
    expect(actions[name]).toHaveBeenCalledExactlyOnceWith();
  }
  expect(actions.theme).toHaveBeenCalledExactlyOnceWith(data.theme);
  expect(actions.appearance).toHaveBeenCalledExactlyOnceWith(data.appearance);
  expect(actions.sidebar).toHaveBeenCalledExactlyOnceWith(data.sidebar_sections, undefined);
  expect(actions.voice).toHaveBeenCalledExactlyOnceWith(data.voice_settings);
  expect(actions.accessibility).toHaveBeenCalledExactlyOnceWith(data.accessibility);
  expect(actions.locale).toHaveBeenCalledExactlyOnceWith(data.locale);
});

const destinationActions = [...resetActions, ...applyActions];
it.each(destinationActions)("propagates a destination failure at %s before touching later destinations", boundary => {
  const failure = new Error(`subscriber failed at ${boundary}`);
  actions[boundary].mockImplementationOnce(() => { throw failure; });

  expect(() => applyAccountPreferences(() => data, true, true)).toThrow(failure);

  for (const name of destinationActions.slice(destinationActions.indexOf(boundary) + 1)) {
    expect(actions[name]).not.toHaveBeenCalled();
  }
});

it("ends a retired reset without reading or applying a replacement scope", () => {
  const readCurrent = vi.fn()
    .mockReturnValueOnce(data)
    .mockReturnValueOnce(null)
    .mockReturnValue({ theme: "replacement" });

  applyAccountPreferences(readCurrent, true, false);

  expect(readCurrent).toHaveBeenCalledTimes(2);
  expect(actions.settingsReset).toHaveBeenCalledOnce();
  for (const name of [...resetActions.slice(1), ...applyActions]) {
    expect(actions[name]).not.toHaveBeenCalled();
  }
});
