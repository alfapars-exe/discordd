import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {useAuthStore} from '../stores/authStore';
import {useFriendStore} from '../stores/friendStore';
import {usePreferencesStore} from '../stores/preferencesStore';
import {clearTokens,getAuthGeneration} from '../api/client';
import {getMessageSpamDisposition,shouldSuppressMessagePreview,ensureSpamRelationshipReady,resolveMessageSpamDisposition} from './messageSpamPolicy';
vi.mock('../api/preferences',()=>({getPreferences:vi.fn(),updatePreferences:vi.fn()}));
const message={id:'spam',user_id:'peer',content:'https://trusted.test@evil.test'};
let fetchFriends:ReturnType<typeof vi.fn<() => Promise<void>>>;
beforeEach(()=>{
 clearTokens();useAuthStore.setState({user:{id:'viewer'} as never});
 usePreferencesStore.setState({data:{privacy:{spamFilter:'nonfriends'}}});
 fetchFriends=vi.fn(async()=>{useFriendStore.setState({friendsStatus:'error'});});
 useFriendStore.setState({ownerId:'viewer',authGeneration:getAuthGeneration(),friendsStatus:'idle',friends:[],fetchFriends});
});
afterEach(()=>{vi.useRealTimers();});
it('distinguishes unknown from complete empty and preserves explicit all/off/self rules',()=>{
 expect(getMessageSpamDisposition(message,'dm')).toBe('pending');expect(shouldSuppressMessagePreview(message,'dm')).toBe(true);
 useFriendStore.setState({friendsStatus:'ready'});expect(getMessageSpamDisposition(message,'dm')).toBe('filter');
 useFriendStore.setState({friends:[{user_id:'peer'} as never]});expect(getMessageSpamDisposition(message,'dm')).toBe('allow');
 usePreferencesStore.setState({data:{privacy:{spamFilter:'all'}}});expect(getMessageSpamDisposition(message,'dm')).toBe('filter');
 expect(getMessageSpamDisposition({...message,user_id:'viewer'},'dm')).toBe('allow');
 usePreferencesStore.setState({data:{privacy:{spamFilter:'off'}}});expect(getMessageSpamDisposition(message,'dm')).toBe('allow');
 expect(fetchFriends).not.toHaveBeenCalled();
});
it('deduplicates concurrent reads and permits explicit retry after failure without recording a nonfriend',async()=>{
 expect(await Promise.all([ensureSpamRelationshipReady(),ensureSpamRelationshipReady()])).toEqual(['pending','pending']);
 expect(fetchFriends).toHaveBeenCalledTimes(1);await ensureSpamRelationshipReady();expect(fetchFriends).toHaveBeenCalledTimes(1);
 fetchFriends.mockImplementation(async()=>{useFriendStore.setState({friendsStatus:'ready',friends:[{user_id:'peer'} as never]});});
 expect(await ensureSpamRelationshipReady(()=>true,true)).toBe('ready');expect(fetchFriends).toHaveBeenCalledTimes(2);
 expect(getMessageSpamDisposition(message,'dm')).toBe('allow');
});
it('joins an existing full list read and bounds hung reads to fifteen seconds',async()=>{
 vi.useFakeTimers();useFriendStore.setState({friendsStatus:'loading'});
 const pending=ensureSpamRelationshipReady();expect(fetchFriends).not.toHaveBeenCalled();
 await vi.advanceTimersByTimeAsync(15000);expect(await pending).toBe('pending');
 expect(getMessageSpamDisposition(message,'dm')).toBe('pending');
});
it('does not release a preview after source or account supersession',async()=>{
 useFriendStore.setState({friendsStatus:'loading'});let current=true;
 const pending=resolveMessageSpamDisposition(message,'dm',()=>current);current=false;
 useFriendStore.setState({friendsStatus:'ready'});expect(await pending).toBe('stale');
 useFriendStore.setState({friendsStatus:'loading'});const account=resolveMessageSpamDisposition(message,'dm');
 clearTokens();useAuthStore.setState({user:{id:'replacement'} as never});useFriendStore.setState({friendsStatus:'ready'});
 expect(await account).toBe('stale');
});
it('rechecks changed mode after waiting and never fetches for immediate decisions',async()=>{
 useFriendStore.setState({friendsStatus:'loading'});const pending=resolveMessageSpamDisposition(message,'dm');
 usePreferencesStore.setState({data:{privacy:{spamFilter:'off'}}});useFriendStore.setState({friendsStatus:'ready'});
 expect(await pending).toBe('allow');expect(fetchFriends).not.toHaveBeenCalled();
});
