const {_electron}=require('../e2e/node_modules/playwright');
const fs=require('fs'),path=require('path');const base=process.env.STARTUP_BENCH_DIR||path.join(require('os').tmpdir(),'hichat-startup-benchmark');fs.mkdirSync(base,{recursive:true});
const user={id:'startup-user',username:'startup_test',display_name:'Startup Test',avatar_url:null,status:'online',custom_status:null,created_at:'2026-01-01T00:00:00Z',email:null,language:'tr',dm_privacy:'friends_only',is_platform_admin:false,has_seen_download_prompt:true,has_seen_welcome:true};
const servers=[{id:'startup-server',name:'Startup Test Server',icon_url:null}];
const cats=[{category:{id:'startup-category',name:'Test Channels',position:0},channels:[{id:'startup-channel',server_id:'startup-server',name:'startup-general',type:'text',category_id:'startup-category',topic:null,position:0,user_limit:0,bitrate:64000,created_at:user.created_at,effective_permissions:1048575}]}];
const jwt=['e30',Buffer.from(JSON.stringify({sub:user.id,user_id:user.id,sid:'startup-session',session_id:'startup-session',exp:Math.floor(Date.now()/1000)+86400})).toString('base64url'),'mock'].join('.');
(async()=>{const label=process.argv[2],exe=process.argv[3],rounds=Number(process.argv[4]||5);const results=[];const profile=path.join(base,label+'-profile');
for(let i=0;i<rounds;i++){
 const t=Date.now(),reqs=[],errors=[];let app;
 try{
 app=await _electron.launch({executablePath:exe,args:['--user-data-dir='+profile],timeout:90000,env:{...process.env,ELECTRON_FORCE_PROD:'1'}});
 const ctx=app.context();
 await ctx.addInitScript(({user,servers,cats,jwt})=>{
 window.__startupRequests=[]; const original=window.fetch;
 window.fetch=async(input,options={})=>{
 const url=typeof input==='string'?input:input.url; const u=new URL(url,location.href);
 if(!u.pathname.startsWith('/api/'))return original(input,options);
 const p=u.pathname.slice(4);window.__startupRequests.push({path:p,t:performance.now()});await new Promise(r=>setTimeout(r,250));let d=[];let status=200;
 const headers=new Headers(options.headers);
 if(p==='/users/me'){if(!headers.get('Authorization')){status=401;d=null}else d=user;}
 else if(p==='/auth/refresh')d={access_token:jwt,refresh_token:'',user};
 else if(p==='/auth/ws-ticket')d={ticket:'startup-test'};
 else if(p==='/servers')d=servers;
 else if(p==='/servers/startup-server')d={...servers[0],owner_id:user.id,invite_required:true,e2ee_enabled:true,livekit_instance_id:null,afk_timeout_minutes:0,member_count:1,created_at:user.created_at};
 else if(p==='/servers/startup-server/channels')d=cats;
 else if(p.endsWith('/roles'))d=[{id:'everyone',server_id:'startup-server',name:'@everyone',permissions:1048575,position:0,is_default:true,color:null}];
 else if(p.endsWith('/members'))d=[{...user,roles:[{id:'everyone',name:'@everyone',permissions:1048575,position:0,is_default:true}]}];
 else if(p.includes('preferences'))d={};
 else if(p.endsWith('/count'))d={count:0,unread_count:0,badge_unread_count:0};
 else if(p.includes('unread'))d=[];
 else if(p==='/friends/requests')d={incoming:[],outgoing:[]};
 else if(p.includes('/spam/decisions'))d={entries:[],next_cursor:''};
 return new Response(JSON.stringify(status===200?{success:true,data:d}:{success:false,error:'unauthorized'}),{status,headers:{'Content-Type':'application/json'}});
 };
 },{user,servers,cats,jwt});
 await ctx.routeWebSocket('**/ws**',ws=>{setTimeout(()=>ws.send(JSON.stringify({op:'ready',d:{servers,online_user_ids:[user.id],muted_server_ids:[],muted_channel_ids:[],pref_status:'online',voice_epoch:'startup',game_activity_epoch:'startup'}})),250);ws.onMessage(()=>{});});
 const p=await app.firstWindow();p.on('pageerror',e=>errors.push(e.message));p.on('console',m=>{if(m.type()==='error')console.log('renderer:',m.text().slice(0,1800))});
 const main=app.windows().find(p=>p.url().startsWith('app://'))||await app.waitForEvent('window',{timeout:30000}).catch(async()=>{return (await app.windows()).find(p=>p.url().startsWith('app://'))||p;});
 await main.waitForURL('app://**',{timeout:30000});
 // First window may already be the main window. Use the actual app:// renderer.
 const page=main.url().startsWith('app://')?main:(await app.windows()).find(p=>p.url().startsWith('app://'));
 if(!page)throw Error('No main renderer');
 await app.evaluate(({BrowserWindow})=>new Promise(resolve=>{const win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('app://'));if(!win||win.isVisible())resolve();else win.once('show',resolve);}));
 const windowMs=Date.now()-t;const renderStart=Date.now();await page.reload();
 await page.locator('.server-rail').waitFor({timeout:30000});const interactiveMs=Date.now()-renderStart;
 await page.locator('[data-keyboard-reorder-id="startup-server"]').first().click();
 await page.getByText('startup-general',{exact:true}).first().waitFor({timeout:30000});const channelMs=Date.now()-renderStart;
 const preview=await page.evaluate(()=>performance.getEntriesByName('startup.preview').map(x=>x.startTime)[0]??null);
 results.push({round:i,windowMs,interactiveMs,channelMs,previewMs:preview,requests:await page.evaluate(()=>window.__startupRequests),errors});console.log({round:i,windowMs,interactiveMs,channelMs,previewMs:preview,errors});
 }catch(e){console.log('FAIL',e.message);if(app)for(const p of app.windows())console.log(await p.title(),(await p.locator('body').innerText()).slice(0,900));console.log('requests',reqs,'errors',errors);throw e;}
 finally{if(app)await app.evaluate(({app})=>app.exit(0)).catch(()=>{});}
 fs.writeFileSync(path.join(base,label+'.json'),JSON.stringify(results,null,2));
}
})().catch(e=>{console.error(e);process.exitCode=1});
