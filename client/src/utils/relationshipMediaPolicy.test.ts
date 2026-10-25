import {expect,it} from 'vitest';
import {relationshipMediaScopes,type FriendshipSnapshot} from './relationshipMediaPolicy';
import {strictestMediaMode,unknownMediaMode} from './mediaVisibility';
const snapshot:FriendshipSnapshot={ownerId:'owner',authGeneration:1,friendsStatus:'ready',friends:[]};
it('a confirmed empty own snapshot distinguishes nonfriend from cold/failed data',()=>{expect(relationshipMediaScopes('peer','owner',1,snapshot)).toEqual(['otherDMs']);expect(relationshipMediaScopes('peer','owner',1,{...snapshot,friends:[{user_id:'peer'}]})).toEqual(['friendDMs']);});
it.each([{friendsStatus:'idle'},{friendsStatus:'loading'},{friendsStatus:'error'},{ownerId:'other'},{authGeneration:2}] as const)('unknown relationship considers BOTH policies: %j',change=>{expect(relationshipMediaScopes('peer','owner',1,{...snapshot,...change})).toEqual(['friendDMs','otherDMs']);});
it.each([['block','show'],['show','block']] as const)('unknown relationship cannot evade stricter preference %s/%s',(friend,other)=>{const scopes=relationshipMediaScopes('peer','owner',1,{...snapshot,friendsStatus:'error'});expect(strictestMediaMode(scopes.map(scope=>unknownMediaMode({sensitiveMedia:{friendDMs:friend,otherDMs:other},disturbingMedia:{friendDMs:'show',otherDMs:'show'}},scope)))).toBe('block');});
