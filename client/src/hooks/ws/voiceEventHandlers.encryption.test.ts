import { describe, it, expect, beforeEach, vi } from "vitest";

import { useVoiceStore } from "../../stores/voiceStore";
import { handleVoiceEvent } from "./voiceEventHandlers";
import type { WSHandlerContext } from "./types";

// vi.hoisted: the toastStore factory below runs before top-level consts are
// initialised, so the spy must be created in the hoisted scope (§4 TDZ trap).
const addToast = vi.hoisted(() => vi.fn());

vi.mock("../../api/voice", () => ({}));
vi.mock("../../api/client", () => ({ ensureFreshToken: vi.fn() }));
vi.mock("../../utils/sounds", () => ({
  playJoinSound: vi.fn(),
  playLeaveSound: vi.fn(),
  closeAudioContext: vi.fn(),
}));
vi.mock("../../stores/preferencesStore", () => ({
  usePreferencesStore: { getState: () => ({ set: vi.fn() }) },
}));
vi.mock("../../stores/serverStore", () => ({
  useServerStore: { getState: () => ({ activeServerId: "srv1" }) },
}));
vi.mock("../../stores/channelStore", () => ({
  useChannelStore: { getState: () => ({ categories: [] }) },
}));
vi.mock("../../stores/uiStore", () => ({
  useUIStore: { getState: () => ({ panels: {}, openTab: vi.fn(), setActiveTab: vi.fn() }) },
}));
vi.mock("../../stores/toastStore", () => ({
  useToastStore: { getState: () => ({ addToast }) },
}));
vi.mock("../../stores/authStore", () => ({
  useAuthStore: { getState: () => ({ user: { id: "me" } }) },
}));
// Echoes the key plus its interpolation options so tests can assert which
// key was used and what was interpolated into it.
vi.mock("../../i18n", () => ({
  default: {
    t: (k: string, o?: Record<string, unknown>) => (o ? `${k}|${JSON.stringify(o)}` : k),
  },
}));
vi.mock("../../stores/shared/voiceRecovery", () => ({
  isVoiceRecoveryAllowed: () => false,
  // Partial-mock trap (PROJECT_MEMORY §4): the force-move path also calls
  // clearVoiceRecoveryMark; a factory missing it fails at collect time.
  clearVoiceRecoveryMark: vi.fn(),
}));

const ctx: WSHandlerContext = {sendVoiceJoin:vi.fn()};
beforeEach(()=>useVoiceStore.setState({currentVoiceChannelId:"channel",e2eePassphrase:"initial",e2eeKeyIndex:0,e2eeKeyEpoch:0,e2eeKeyContext:"current"}));
async function rotate(epoch:number,index:number,context="current",passphrase=`epoch-${epoch}`) {
 await handleVoiceEvent({op:"voice_passphrase_rotated",d:{channel_id:"channel",passphrase,key_epoch:epoch,key_index:index,key_context:context}},ctx);
}
describe("authoritative room key rotation",()=>{
 it("accepts a missed full 256-rotation cycle and rejects stale epoch and old incarnation events",async()=>{
  await rotate(256,0); expect(useVoiceStore.getState()).toMatchObject({e2eePassphrase:"epoch-256",e2eeKeyEpoch:256,e2eeKeyIndex:0});
  await rotate(1,1); await rotate(512,0,"retired-room");
  expect(useVoiceStore.getState()).toMatchObject({e2eePassphrase:"epoch-256",e2eeKeyEpoch:256,e2eeKeyContext:"current"});
 });
 it("fails closed for malformed slot/epoch and conflicting material at the same authoritative epoch",async()=>{
  await rotate(256,1); expect(useVoiceStore.getState().e2eePassphrase).toBeNull();
  useVoiceStore.setState({e2eePassphrase:"initial",e2eeKeyIndex:0,e2eeKeyEpoch:0,e2eeKeyContext:"current"});
  await rotate(0,0,"current","conflicting"); expect(useVoiceStore.getState().e2eePassphrase).toBeNull();
 });
});
