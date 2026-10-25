import type {ReactNode} from 'react';
import {collectExpressionMedia} from '../../utils/expressionMedia';
import UnclassifiedMediaGate from './UnclassifiedMediaGate';

type Props={content:string|null;authorId:string;messageId:string;revision:string;sourceKind:'channel'|'dm'|'group';sourceChannelId:string;children:ReactNode};
/** Gate before any GIF/sticker/custom-emoji child mounts. Existing analysis,
 * account-private annotations, retry and reveal lifetime remain shared. */
export default function MessageBodyMediaGate({content,authorId,messageId,revision,sourceKind,sourceChannelId,children}:Props){
 const mediaInputs=collectExpressionMedia(content);
 if(!mediaInputs.length)return children;
 return <UnclassifiedMediaGate privateConversation={sourceKind!=='channel'} sourceKind={sourceKind} sourceChannelId={sourceChannelId} messageId={messageId} revision={revision} authorId={authorId}
  identity={JSON.stringify([sourceKind,sourceChannelId,messageId,'body',mediaInputs])} mediaInputs={mediaInputs}>{children}</UnclassifiedMediaGate>;
}
