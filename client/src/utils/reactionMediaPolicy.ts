import type {MediaScope} from './mediaVisibility';
export type ReactionActorContext={kind:'channel'|'dm'|'group';viewerId:string|undefined;users:readonly string[];count:number;friendIds:readonly string[];friendsReady:boolean;participantIds:readonly string[];participantsReady:boolean};
/** Reaction attribution is independent of the original message author. */
export function reactionMediaScopes(input:ReactionActorContext):MediaScope[]{
 if(input.kind==='channel')return ['channels'];
 const scopes=new Set<MediaScope>(),friends=new Set(input.friendIds),participants=new Set(input.participantIds);
 const actors=[...new Set(input.users.filter(id=>typeof id==='string'&&id.length>0))];
 const incomplete=!input.participantsReady||!input.viewerId||!Number.isSafeInteger(input.count)||input.count<1||actors.length!==input.count||actors.length!==input.users.length||actors.some(id=>!participants.has(id));
 const others=input.kind==='dm'?input.participantIds.filter(id=>id!==input.viewerId):actors.filter(id=>id!==input.viewerId);
 // Self-only reactions still use conversation policy, not the message owner's
 // exemption. For a group this means its loaded other participants' contexts.
 const attributed=others.length?others:input.participantIds.filter(id=>id!==input.viewerId);
 for(const id of attributed){if(input.friendsReady)scopes.add(friends.has(id)?'friendDMs':'otherDMs');else{scopes.add('friendDMs');scopes.add('otherDMs');}}
 if(incomplete||!scopes.size){scopes.add('friendDMs');scopes.add('otherDMs');}
 return [...scopes].sort();
}
