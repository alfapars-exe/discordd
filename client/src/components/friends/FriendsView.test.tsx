import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import FriendsView from './FriendsView';
import {useFriendStore} from '../../stores/friendStore';
import {useAuthStore} from '../../stores/authStore';
import {getAuthGeneration,clearTokens} from '../../api/client';
vi.mock('react-i18next',async(importOriginal)=>({...await importOriginal<typeof import('react-i18next')>(),useTranslation:()=>({t:(key:string)=>key})}));
vi.mock('./FriendItem',()=>({default:({friendship}:{friendship:{username:string}})=><div>{friendship.username}</div>}));
vi.mock('./PersonalizedSuggestions',()=>({default:()=>null}));
vi.mock('./BlockedList',()=>({default:()=>null}));
vi.mock('./FriendRequestForm',()=>({default:()=>null}));
let fetchFriends:ReturnType<typeof vi.fn<() => Promise<void>>>;
beforeEach(()=>{
 clearTokens();useAuthStore.setState({user:{id:'viewer'} as never});fetchFriends=vi.fn(async()=>{});
 useFriendStore.setState({ownerId:'viewer',authGeneration:getAuthGeneration(),friendsStatus:'idle',friends:[],incoming:[],outgoing:[],fetchFriends,fetchRequests:vi.fn(async()=>{})});
});
afterEach(cleanup);
it('shows loading, error and retry honestly; only complete ready empty shows no friends',()=>{
 render(<FriendsView/>);expect(screen.getByText('loading')).toBeTruthy();expect(screen.queryByText('noFriendsYet')).toBeNull();
 act(()=>useFriendStore.setState({friendsStatus:'error'}));expect(screen.getByRole('alert')).toBeTruthy();expect(screen.queryByText('noFriendsYet')).toBeNull();
 act(()=>useFriendStore.setState({friendsStatus:'ready'}));expect(screen.getByText('noFriendsYet')).toBeTruthy();
});
it('retains only same-account confirmed rows on failure and deduplicates retry clicks',async()=>{
 useFriendStore.setState({friendsStatus:'error',friends:[{id:'f',user_id:'friend',username:'Cached friend',user_status:'online'} as never]});
 render(<FriendsView/>);expect(screen.getByText('Cached friend')).toBeTruthy();expect(screen.getByRole('alert')).toBeTruthy();
 let finish!:()=>void;fetchFriends.mockImplementation(()=>new Promise<void>(resolve=>{finish=resolve;}));
 fireEvent.click(screen.getByText('retry'));fireEvent.click(screen.getByText('retry'));expect(fetchFriends).toHaveBeenCalledTimes(2);
 await act(async()=>{finish();});expect(screen.getByText('Cached friend')).toBeTruthy();
 act(()=>useFriendStore.setState({ownerId:'foreign'}));expect(screen.queryByText('Cached friend')).toBeNull();expect(screen.queryByText('noFriendsYet')).toBeNull();
});
