import {KLIPY_REGEX} from './messageParsers';
import {CUSTOM_EMOJI_TOKEN,emojiAnimatedUrl,emojiStaticUrl,parseCustomEmojiToken} from './expressionTokens';
import {parseStickerToken,stickerAnimatedUrl,stickerStaticUrl} from './stickerTokens';
import {scanCodeSegments} from './markdownLite';
import type {LocalMediaInput} from '../hooks/useLocalMediaAnalysis';

/** Describes only visual expressions rendered by the existing message parser.
 * Code literals remain text; spoilers retain their parser-owned reveal state.
 * Third-party GIF URLs are descriptors, never permission to fetch/classify them. */
export function collectExpressionMedia(content:string|null):LocalMediaInput[]{
 if(!content)return [];
 const media=new Map<string,LocalMediaInput>();
 const add=(url:string,mimeType:string)=>media.set(url,{url,mimeType});
 const trimmed=content.trim();
 if(KLIPY_REGEX.test(trimmed))add(trimmed,'image/gif');
 const sticker=parseStickerToken(trimmed);
 if(sticker)add(sticker.animated?stickerAnimatedUrl(sticker.id):stickerStaticUrl(sticker.id),sticker.animated?'image/gif':'image/png');
 for(const segment of scanCodeSegments(content)){
  if(segment.kind!=='text')continue;
  for(const match of segment.raw.matchAll(CUSTOM_EMOJI_TOKEN)){
   const emoji=parseCustomEmojiToken(match[0]);
   if(emoji)add(emoji.animated?emojiAnimatedUrl(emoji.id):emojiStaticUrl(emoji.id),emoji.animated?'image/gif':'image/png');
  }
 }
 return [...media.values()];
}
