const storageKey="hichat.reminder-attempts.v1";
type Entry={hash:string;id:string;created:number};
const maxAge=368*24*60*60*1000;
function read():Entry[]{
  const raw=localStorage.getItem(storageKey);if(!raw)return [];
  if(raw.length>40000)throw new Error("reminder_attempt_storage_invalid");
  const value:unknown=JSON.parse(raw);
  if(!Array.isArray(value)||value.length>128)throw new Error("reminder_attempt_storage_invalid");
  for(const entry of value){
    if(!entry||typeof entry!=="object"||!/^[a-f0-9]{64}$/.test(entry.hash)||!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(entry.id)||!Number.isSafeInteger(entry.created)||entry.created<0)throw new Error("reminder_attempt_storage_invalid");
  }
  return value.filter(entry=>entry.created>=Date.now()-maxAge&&entry.created<=Date.now()+60000);
}
async function hash(scope:string,payload:string){
  if(!scope||payload.length>10000)throw new Error("reminder_attempt_invalid");
  const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify([scope,payload])));
  return Array.from(new Uint8Array(bytes),value=>value.toString(16).padStart(2,"0")).join("");
}
function locked<T>(work:()=>T):Promise<T>{
  return navigator.locks?navigator.locks.request(storageKey,work):Promise.resolve().then(work);
}
/** Persist only an opaque fingerprint and UUID; never source IDs or message text. */
export async function findReminderAttempt(scope:string,payload:string):Promise<string|undefined>{
  const fingerprint=await hash(scope,payload);
  return locked(()=>read().find(entry=>entry.hash===fingerprint)?.id);
}
export async function reminderAttempt(scope:string,payload:string):Promise<string>{
  const fingerprint=await hash(scope,payload);
  return locked(()=>{
    const entries=read(),existing=entries.find(entry=>entry.hash===fingerprint);
    if(existing)return existing.id;
    // Never silently evict an unresolved request and risk creating it twice.
    if(entries.length>=128)throw new Error("reminder_attempt_storage_full");
    const id=crypto.randomUUID();entries.push({hash:fingerprint,id,created:Date.now()});
    localStorage.setItem(storageKey,JSON.stringify(entries));
    return id;
  });
}
export async function forgetReminderAttempt(scope:string,payload:string,id:string):Promise<void>{
  const fingerprint=await hash(scope,payload);
  await locked(()=>{
    const entries=read().filter(entry=>entry.hash!==fingerprint||entry.id!==id);
    if(entries.length)localStorage.setItem(storageKey,JSON.stringify(entries));else localStorage.removeItem(storageKey);
  });
}
