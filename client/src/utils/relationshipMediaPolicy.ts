import type {MediaScope} from './mediaVisibility';
export type FriendshipSnapshot={ownerId:string|null;authGeneration:number;friendsStatus:'idle'|'loading'|'ready'|'error';friends:readonly {user_id:string}[]};
/** Absence is nonfriend only in a complete, current account snapshot. Unknown
 * uses both policies because users may configure either category more strictly. */
export function relationshipMediaScopes(userId:string|undefined,viewerId:string|undefined,generation:number,snapshot:FriendshipSnapshot):MediaScope[]{
 if(!userId||!viewerId||snapshot.ownerId!==viewerId||snapshot.authGeneration!==generation||snapshot.friendsStatus!=='ready')return ['friendDMs','otherDMs'];
 return [snapshot.friends.some(friend=>friend.user_id===userId)?'friendDMs':'otherDMs'];
}
export function friendshipSnapshotKey(snapshot:Pick<FriendshipSnapshot,'ownerId'|'authGeneration'|'friendsStatus'>):string{
 return JSON.stringify([snapshot.ownerId,snapshot.authGeneration,snapshot.friendsStatus]);
}
