// Loopback proof proxy only; no production imports.
import {createHash} from 'node:crypto';
export function dmFaultFixture() {
 const enabled=process.env.HICHAT_QA_DROP_DM_ACK==='1';
 const hold=process.env.HICHAT_QA_HOLD_FIRST_DM_SENDS==='1';
 const hashes=[];let attempts=0,dropped=false,droppedHash=null,arrivals=0,release;
 const barrier=new Promise(resolve=>{release=resolve;});
 return {
  enabled,
  receipt:()=>({attempts,dropped,identicalFirstRetry:droppedHash!==null&&hashes.filter(hash=>hash===droppedHash).length>=2}),
  async gate(){
   if(!hold || arrivals>=2)return true;
   if(++arrivals===2){release();return true;}
   let timer;
   try{return await Promise.race([barrier.then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),15000);})]);}
   finally{clearTimeout(timer);}
  },
  track(req){
   attempts++;let length=0,digest=null;const chunks=[];
   req.on('data',chunk=>{length+=chunk.length;if(length<=4*1024*1024)chunks.push(chunk);});
   req.on('end',()=>{
    if(length>4*1024*1024)return;
    let body=Buffer.concat(chunks);
    const boundary=/boundary=(?:"([^"]+)"|([^;]+))/i.exec(req.headers['content-type']??'');
    if(boundary)body=Buffer.from(body.toString('latin1').replaceAll(boundary[1]??boundary[2],'FIXTURE_BOUNDARY'),'latin1');
    digest=createHash('sha256').update(body).digest('hex');
    if(hashes.length<100)hashes.push(digest);
   });
   return ()=>digest;
  },
  consume(incoming,res,readHash){
   if(dropped || incoming.statusCode!==201)return false;
   dropped=true;droppedHash=readHash();incoming.on('end',()=>res.destroy());incoming.resume();return true;
  },
 };
}
