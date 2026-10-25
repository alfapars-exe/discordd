import {act,renderHook,waitFor} from "@testing-library/react";
import {beforeEach,expect,it,vi} from "vitest";
import {useGroupSendRestoration} from "./useGroupSendRestoration";
import {useGroupDMStore} from "../stores/groupDMStore";
import {useAuthStore} from "../stores/authStore";
import {useE2EEStore} from "../stores/e2eeStore";
import type {GroupDM} from "../types/groupDM";
const fetchGroups=vi.fn(async()=>{}),restore=vi.fn(async()=>{});
beforeEach(()=>{
 vi.clearAllMocks();useAuthStore.setState({user:{id:"restoration-owner"} as NonNullable<ReturnType<typeof useAuthStore.getState>["user"]>});
 useE2EEStore.setState({localDeviceId:"device",initStatus:"initializing"});
 useGroupDMStore.setState({groups:[],groupsReady:false,fetchGroups,restorePendingSends:restore});
});
it("waits for authenticated groups and a ready device, and does not reread for unread-only changes",async()=>{
 renderHook(()=>useGroupSendRestoration());await waitFor(()=>expect(fetchGroups).toHaveBeenCalledOnce());expect(restore).not.toHaveBeenCalled();
 act(()=>useGroupDMStore.setState({groupsReady:true,groups:[{id:"group",unread_count:0} as GroupDM]}));expect(restore).not.toHaveBeenCalled();
 act(()=>useE2EEStore.setState({initStatus:"ready"}));await waitFor(()=>expect(restore).toHaveBeenCalledWith(true));const count=restore.mock.calls.length;
 act(()=>useGroupDMStore.setState({groups:[{id:"group",unread_count:3} as GroupDM]}));expect(restore).toHaveBeenCalledTimes(count);
 act(()=>useE2EEStore.setState({localDeviceId:"new-device"}));await waitFor(()=>expect(restore).toHaveBeenCalledTimes(count+1));
});
it("fetches fresh groups when the account changes and does not restore an uninitialized replacement account",async()=>{
 renderHook(()=>useGroupSendRestoration());await waitFor(()=>expect(fetchGroups).toHaveBeenCalledOnce());
 act(()=>useAuthStore.setState({user:{id:"replacement"} as NonNullable<ReturnType<typeof useAuthStore.getState>["user"]>}));await waitFor(()=>expect(fetchGroups).toHaveBeenCalledTimes(2));expect(restore).not.toHaveBeenCalled();
});
