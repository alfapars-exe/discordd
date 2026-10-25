import {useEffect} from "react";
import {useAuthStore} from "../stores/authStore";
import {useE2EEStore} from "../stores/e2eeStore";
import {useGroupDMStore} from "../stores/groupDMStore";

export function useGroupSendRestoration(){
 const accountId=useAuthStore(state=>state.user?.id);
 const deviceId=useE2EEStore(state=>state.localDeviceId),status=useE2EEStore(state=>state.initStatus);
 const groupsReady=useGroupDMStore(state=>state.groupsReady);
 const signature=useGroupDMStore(state=>JSON.stringify(state.groups.map(group=>group.id).sort()));
 useEffect(()=>{if(accountId)void useGroupDMStore.getState().fetchGroups()},[accountId]);
 useEffect(()=>{if(accountId&&deviceId&&groupsReady&&status==="ready")void useGroupDMStore.getState().restorePendingSends(true)},[accountId,deviceId,status,groupsReady,signature]);
}
