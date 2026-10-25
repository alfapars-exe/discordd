// Bound the entire download/decrypt/inference pipeline, not just worker jobs.
let active=0;
type Waiter={signal:AbortSignal;resolve:(release:()=>void)=>void;reject:(error:Error)=>void;abort:()=>void};
const waiting:Waiter[]=[];
function permit(){
  active++;
  let released=false;
  return()=>{
    if(released)return;released=true;active--;
    const next=waiting.shift();
    if(next){next.signal.removeEventListener("abort",next.abort);next.resolve(permit());}
  };
}
export function acquireMediaAnalysisSlot(signal:AbortSignal):Promise<()=>void>{
  if(signal.aborted)return Promise.reject(new Error("media_analysis_cancelled"));
  if(active<4)return Promise.resolve(permit());
  if(waiting.length>=12)return Promise.reject(new Error("media_analysis_limit"));
  return new Promise((resolve,reject)=>{
    const waiter:Waiter={signal,resolve,reject,abort:()=>{
      const index=waiting.indexOf(waiter);
      if(index>=0){waiting.splice(index,1);reject(new Error("media_analysis_cancelled"));}
    }};
    waiting.push(waiter);signal.addEventListener("abort",waiter.abort,{once:true});
  });
}
