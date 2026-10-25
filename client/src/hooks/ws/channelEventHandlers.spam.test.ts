import {beforeEach,expect,it,vi} from 'vitest';
import {handleChannelEvent} from './channelEventHandlers';
import {useAuthStore} from '../../stores/authStore';
import {useFriendStore} from '../../stores/friendStore';
import {usePreferencesStore} from '../../stores/preferencesStore';
import {useMessageStore} from '../../stores/messageStore';
import {useReadStateStore} from '../../stores/readStateStore';
import {useServerStore} from '../../stores/serverStore';
import {useChannelStore} from '../../stores/channelStore';
import {useUIStore} from '../../stores/uiStore';
import {clearTokens,getAuthGeneration} from '../../api/client';
import {showNotification} from '../../utils/notifications';
import {speakIncomingMessage} from '../../utils/textToSpeech';
import {recordSpam} from '../../api/spam';
import type {WSMessage,Message} from '../../types';
vi.mock('../../utils/notifications',()=>({showNotification:vi.fn()}));
vi.mock('../../utils/textToSpeech',()=>({speakIncomingMessage:vi.fn()}));
vi.mock('../../utils/sounds',()=>({playNotificationSound:vi.fn()}));
vi.mock('../../api/spam',()=>({recordSpam:vi.fn(async()=>({success:true}))}));
const message={id:'pending-channel',user_id:'peer',channel_id:'channel',server_id:'server',content:'https://trusted.test@evil.test',edited_at:null,created_at:'2026-10-25T00:00:00Z',author:{id:'peer',username:'Peer'}} as Message;
const event={op:'message_create',server_id:'server',d:message} as WSMessage;
beforeEach(()=>{
 vi.clearAllMocks();clearTokens();useAuthStore.setState({user:{id:'viewer'} as never});
 usePreferencesStore.setState({data:{privacy:{spamFilter:'nonfriends'}}});
 useFriendStore.setState({ownerId:'viewer',authGeneration:getAuthGeneration(),friendsStatus:'loading',friends:[]});
 useMessageStore.setState({messagesByChannel:{},handleMessageCreate:vi.fn((value)=>useMessageStore.setState({messagesByChannel:{channel:[value]}}))});
 useReadStateStore.setState({incrementUnread:vi.fn(),registerChannel:vi.fn(),markAsRead:vi.fn()});
 useServerStore.setState({activeServerId:'server',isServerMuted:()=>false});
 useChannelStore.setState({mutedChannelIds:new Set()});
 useUIStore.setState({destination:{type:'home'},panels:{},activePanelId:'none'} as never);
});
it('holds channel plaintext cues until a complete friend list confirms the sender',async()=>{
 const pending=handleChannelEvent(event);await Promise.resolve();expect(showNotification).not.toHaveBeenCalled();expect(recordSpam).not.toHaveBeenCalled();
 useFriendStore.setState({friendsStatus:'ready',friends:[{user_id:'peer'} as never]});await pending;
 expect(showNotification).toHaveBeenCalledWith(expect.objectContaining({body:message.content}));expect(speakIncomingMessage).toHaveBeenCalledOnce();expect(recordSpam).not.toHaveBeenCalled();
});
it('keeps generic arrival and unread on failure without classifying an unknown relation as nonfriend',async()=>{
 useFriendStore.setState({friendsStatus:'idle',fetchFriends:vi.fn(async()=>{useFriendStore.setState({friendsStatus:'error'});})});
 await handleChannelEvent(event);
 expect(useReadStateStore.getState().incrementUnread).toHaveBeenCalledWith('channel');expect(speakIncomingMessage).not.toHaveBeenCalled();expect(recordSpam).not.toHaveBeenCalled();
 expect(vi.mocked(showNotification).mock.calls[0][0].body).not.toContain('evil.test');
});
it('rejects obsolete source completion after a message edit while waiting',async()=>{
 const pending=handleChannelEvent(event);await Promise.resolve();
 useMessageStore.setState({messagesByChannel:{channel:[{...message,edited_at:'changed',content:'replacement'}]}});
 useFriendStore.setState({friendsStatus:'ready',friends:[{user_id:'peer'} as never]});await pending;
 expect(showNotification).not.toHaveBeenCalled();expect(speakIncomingMessage).not.toHaveBeenCalled();expect(recordSpam).not.toHaveBeenCalled();
});
