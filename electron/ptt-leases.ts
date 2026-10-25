/** One sender-owned native PTT lease. No media authority or keyboard history. */
export type PTTKind = "guild" | "p2p" | "group";
export type PTTRequest = {kind: PTTKind; source: string; keyCode: string};
export type PTTLease = PTTRequest & {id: string; sender: number};
export type PTTSignal = {leaseId: string; pressed: boolean};
export function validPTTRequest(value: unknown): value is PTTRequest {
 if (!value || typeof value !== "object") return false;
 const v=value as Partial<PTTRequest>;
 return ["guild","p2p","group"].includes(v.kind ?? "") && typeof v.source==="string" && v.source.length>0 && v.source.length<=160 && typeof v.keyCode==="string" && /^[A-Za-z0-9]{1,40}$/.test(v.keyCode);
}
const priority: Record<PTTKind,number>={guild:3,p2p:2,group:1};
export class PTTLeases {
 private lease: PTTLease|null=null;
 constructor(private bind:(key:string|null)=>boolean,private send:(sender:number,signal:PTTSignal)=>void,private uuid:()=>string){}
 acquire(sender:number, request:PTTRequest):string|null {
  if(this.lease && priority[this.lease.kind]>priority[request.kind]) return null;
  const prior=this.lease;
  // Validate/bind first; failed registration cannot steal a working owner.
  if(!this.bind(request.keyCode))return null;
  if(prior)this.send(prior.sender,{leaseId:prior.id,pressed:false});
  const id=this.uuid();this.lease={...request,id,sender};return id;
 }
 release(sender:number,id:string):void {
  if(this.lease?.sender!==sender||this.lease.id!==id)return;
  const old=this.lease;this.lease=null;this.send(sender,{leaseId:old.id,pressed:false});this.bind(null);
 }
 retireSender(sender:number):void {if(this.lease?.sender===sender)this.release(sender,this.lease.id);}
 signal(pressed:boolean):void {const l=this.lease;if(l)this.send(l.sender,{leaseId:l.id,pressed});}
 get active():boolean{return this.lease!==null;}
 clear():void {if(this.lease)this.release(this.lease.sender,this.lease.id);}
}
