import type {ReactNode} from 'react';
import {useAuthStore} from '../../stores/authStore';
import {useFriendStore} from '../../stores/friendStore';
import {useDMStore} from '../../stores/dmStore';
import {useGroupDMStore} from '../../stores/groupDMStore';
import {getAuthGeneration} from '../../api/client';
import type {ReactionGroup} from '../../types';
import {parseReactionKey,emojiAnimatedUrl,emojiStaticUrl} from '../../utils/expressionTokens';
import {reactionMediaScopes} from '../../utils/reactionMediaPolicy';
import UnclassifiedMediaGate from './UnclassifiedMediaGate';

type Props={reaction:ReactionGroup;sourceKind:'channel'|'dm'|'group';sourceChannelId:string;messageId:string;revision:string;messageAuthorId?:string;render:(visible:boolean)=>ReactNode};
/** Presentation controls remain siblings of the reaction toggle, never inside
 * its button. The message author does not determine reaction attribution. */
export default function ReactionMediaGate({reaction,sourceKind,sourceChannelId,messageId,revision,messageAuthorId,render}:Props){
 const viewerId=useAuthStore(state=>state.user?.id),generation=useAuthStore(()=>getAuthGeneration());
 const friends=useFriendStore(state=>state.friends),friendOwner=useFriendStore(state=>state.ownerId),friendGeneration=useFriendStore(state=>state.authGeneration),friendsStatus=useFriendStore(state=>state.friendsStatus);
 const friendsReady=!!viewerId&&friendOwner===viewerId&&friendGeneration===generation&&friendsStatus==="ready";
 const dms=useDMStore(state=>state.channels),dmOwner=useDMStore(state=>state.ownerId),dmGeneration=useDMStore(state=>state.authGeneration),dmLoading=useDMStore(state=>state.isLoading);
 const groups=useGroupDMStore(state=>state.groups),groupOwner=useGroupDMStore(state=>state.ownerId),groupGeneration=useGroupDMStore(state=>state.authGeneration),groupsReady=useGroupDMStore(state=>state.groupsReady);
 let participantIds:string[]=[],participantsReady=false;
 if(sourceKind==='dm'){
  const channel=dms.find(item=>item.id===sourceChannelId);
  participantsReady=!!viewerId&&dmOwner===viewerId&&dmGeneration===generation&&!dmLoading&&!!channel?.other_user?.id;
  if(participantsReady)participantIds=[viewerId!,channel!.other_user.id];
 }else if(sourceKind==='group'){
  const group=groups.find(item=>item.id===sourceChannelId);
  participantsReady=!!viewerId&&groupOwner===viewerId&&groupGeneration===generation&&groupsReady&&!!group?.members.some(member=>member.id===viewerId);
  if(participantsReady)participantIds=group!.members.map(member=>member.id);
 }
 const users=Array.isArray(reaction.users)?reaction.users:[];
 const scopes=reactionMediaScopes({kind:sourceKind,viewerId,users,count:reaction.count,friendIds:friends.map(friend=>friend.user_id),friendsReady,participantIds,participantsReady});
 const parsed=parseReactionKey(reaction.emoji);
 if(!parsed.custom)return render(true);
 if(!sourceChannelId||!messageId)return render(false);
 // The existing annotation API does not support own-authored source messages.
 // This capability check does not exempt their reactions from local filtering.
 const identity=JSON.stringify([sourceKind,sourceChannelId,messageId,'reaction',reaction.emoji,[...users].sort(),reaction.count,scopes]);
 return <UnclassifiedMediaGate privateConversation={sourceKind!=='channel'} sourceKind={sourceKind} sourceChannelId={sourceChannelId} messageId={messageId} revision={revision}
  identity={identity} annotationsEnabled={!!messageAuthorId&&messageAuthorId!==viewerId} mediaScopes={scopes} mediaInputs={[{url:parsed.animated?emojiAnimatedUrl(parsed.id):emojiStaticUrl(parsed.id),mimeType:parsed.animated?'image/gif':'image/png'}]} renderContent={render}/>;
}
