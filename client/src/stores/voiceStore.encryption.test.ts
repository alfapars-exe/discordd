import { describe, it, expect, beforeEach, vi } from "vitest";
import { useVoiceStore } from "./voiceStore";
import * as voiceApi from "../api/voice";

// Mock external dependencies that voiceStore imports at module level
vi.mock("../api/voice", () => ({ getVoiceToken: vi.fn() }));
vi.mock("../api/client", () => ({ ensureFreshToken: vi.fn(), getAuthGeneration: () => 1 }));
vi.mock("../utils/sounds", () => ({
  playJoinSound: vi.fn(),
  playLeaveSound: vi.fn(),
  closeAudioContext: vi.fn(),
}));
vi.mock("./preferencesStore", () => ({
  usePreferencesStore: { getState: () => ({ set: vi.fn() }) },
}));
vi.mock("./serverStore", () => ({
  useServerStore: { getState: () => ({ activeServerId: "srv1" }) },
}));
// Identity translator — assertions check the raw i18n key, same pattern as
// apiError.test.ts / voiceEventHandlers.test.ts for this module.
vi.mock("../i18n", () => ({ default: { t: (k: string) => k } }));
const addToast = vi.fn();
vi.mock("./toastStore", () => ({
  useToastStore: { getState: () => ({ addToast }) },
}));

const credentials = (epoch:number,context="room") => ({success:true,data:{token:`token-${epoch}`,url:"wss://local",channel_id:"channel",e2ee_passphrase:`key-${epoch}`,e2ee_key_index:epoch%256,e2ee_key_epoch:epoch,e2ee_key_context:context}});
beforeEach(()=>{vi.mocked(voiceApi.getVoiceToken).mockReset();useVoiceStore.setState({currentVoiceChannelId:"channel",currentVoiceServerId:"srv1",_joinGeneration:3,e2eePassphrase:"key-256",e2eeKeyIndex:0,e2eeKeyEpoch:256,e2eeKeyContext:"room"});});
describe("authoritative voice token replacement",()=>{
 it("accepts reset epoch zero only with a fresh room incarnation and retains newer same-context WS material",async()=>{
  vi.mocked(voiceApi.getVoiceToken).mockResolvedValueOnce(credentials(1));
  await useVoiceStore.getState().refreshVoiceToken("channel");
  expect(useVoiceStore.getState()).toMatchObject({e2eeKeyEpoch:256,e2eePassphrase:"key-256"});
  vi.mocked(voiceApi.getVoiceToken).mockResolvedValueOnce(credentials(0,"recreated"));
  await useVoiceStore.getState().refreshVoiceToken("channel");
  expect(useVoiceStore.getState()).toMatchObject({e2eeKeyEpoch:0,e2eeKeyIndex:0,e2eeKeyContext:"recreated",e2eePassphrase:"key-0"});
 });
 it("does not accept an older HTTP response after a newer request or same-channel new join",async()=>{
  let finish!:(value:ReturnType<typeof credentials>)=>void;
  vi.mocked(voiceApi.getVoiceToken).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const first=useVoiceStore.getState().refreshVoiceToken("channel"); await Promise.resolve();
  vi.mocked(voiceApi.getVoiceToken).mockResolvedValueOnce(credentials(0,"fresh"));
  await useVoiceStore.getState().refreshVoiceToken("channel"); finish(credentials(0,"stale")); expect(await first).toBeNull();
  expect(useVoiceStore.getState().e2eeKeyContext).toBe("fresh");
  vi.mocked(voiceApi.getVoiceToken).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const pending=useVoiceStore.getState().refreshVoiceToken("channel"); await Promise.resolve();
  useVoiceStore.setState({_joinGeneration:4}); finish(credentials(0,"retired-join")); expect(await pending).toBeNull();
  expect(useVoiceStore.getState().e2eeKeyContext).toBe("fresh");
 });
});
