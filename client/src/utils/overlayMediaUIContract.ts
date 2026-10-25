export type OverlayTile = {tileId:string;kind:"camera"|"screen";label?:string};
export type OverlayLease = {session:string;revision:number;tiles:OverlayTile[]};
export type OverlayAvailability = {ready:boolean;visible:boolean;allowedKinds:("camera"|"screen")[];windowGeneration:string};
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
const token=(v:unknown)=>typeof v==="string"&&/^[A-Za-z0-9_-]{1,64}$/.test(v);
export function parseOverlayAvailability(v:unknown):OverlayAvailability|null{
 if(!object(v)||typeof v.ready!=="boolean"||typeof v.visible!=="boolean"||!token(v.windowGeneration)||!Array.isArray(v.allowedKinds)||v.allowedKinds.length>2||new Set(v.allowedKinds).size!==v.allowedKinds.length||!v.allowedKinds.every(k=>k==="camera"||k==="screen"))return null;
 return {ready:v.ready,visible:v.visible,windowGeneration:v.windowGeneration as string,allowedKinds:[...v.allowedKinds].sort()};
}
export function parseOverlayLease(v:unknown):OverlayLease|null{
 if(!object(v)||typeof v.session!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.session)||v.session==="00000000-0000-0000-0000-000000000000"||!Number.isSafeInteger(v.revision)||(v.revision as number)<1||!Array.isArray(v.tiles)||v.tiles.length<1||v.tiles.length>4)return null;
 const seen=new Set(),counts={camera:0,screen:0},tiles:OverlayTile[]=[];
 for(const tile of v.tiles){if(!object(tile)||!token(tile.tileId)||seen.has(tile.tileId)||(tile.kind!=="camera"&&tile.kind!=="screen")||++counts[tile.kind]>2||tile.label!==undefined&&(typeof tile.label!=="string"||tile.label.length>80||[...tile.label].some(c=>c.charCodeAt(0)<32||c.charCodeAt(0)===127)))return null;seen.add(tile.tileId);tiles.push({tileId:tile.tileId as string,kind:tile.kind,...(tile.label?{label:tile.label as string}:{})});}
 return {session:v.session,revision:v.revision as number,tiles};
}
