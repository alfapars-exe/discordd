// Local-only test host. Never deploy this fixture proxy as production infrastructure.
import http from 'node:http';
import net from 'node:net';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {apiPath,requestHeaders,responseHeaders} from './qa-http.mjs';
const root=fileURLToPath(new URL('../hichat_native_proof/build/web/',import.meta.url));
const mime={'.html':'text/html','.js':'text/javascript','.wasm':'application/wasm','.json':'application/json','.css':'text/css','.png':'image/png','.ttf':'font/ttf','.otf':'font/otf'};
const server=http.createServer(async(req,res)=>{
  res.setHeader('Cross-Origin-Opener-Policy','same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy','require-corp');
  res.setHeader('Cache-Control','no-store');
  if(new URL(req.url,'http://127.0.0.1').pathname==='/__qa/synthetic-window'){
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.end('<!doctype html><title>HiChat Synthetic P2P QA</title><body style="background:#224;color:white;font:30px sans-serif">Owned synthetic video capture source <span id="tick"></span><script>setInterval(()=>document.querySelector("#tick").textContent=Date.now(),100)</script>');return;
  }
  if(req.url==='/__qa/handoff-source.html'){
    res.setHeader('Content-Type','text/html');res.end('<title>HiChat handoff QA</title><script type="module" src="/__qa/handoff-source.js"></script>');return;
  }
  if(req.url==='/__qa/legacy-chat.html'){
    res.setHeader('Content-Type','text/html');res.end('<title>Disposable legacy chat interop</title><script type="module" src="/__qa/legacy-chat.js"></script>');return;
  }
  if(req.url==='/__qa/legacy-chat.js'){
    res.setHeader('Content-Type','text/javascript');res.end(await readFile(new URL('../.local/source-bundle/legacy-chat.js',import.meta.url)));return;
  }
  if(req.url==='/__qa/handoff-source.js'){
    res.setHeader('Content-Type','text/javascript');res.end(await readFile(new URL('../.local/source-bundle/handoff-source.js',import.meta.url)));return;
  }
  if(req.url.startsWith('/api/')){
    let route;try{route=apiPath(req.url)}catch{res.writeHead(400);res.end('Invalid fixture route');return}
    const upstream=http.request('http://127.0.0.1:19090',{path:route,method:req.method,headers:requestHeaders(req.headers)},incoming=>{if(responseHeaders(incoming,res))incoming.pipe(res);else incoming.resume();});
    upstream.on('error',()=>{res.writeHead(502);res.end('Local API unavailable');});req.pipe(upstream);return;
  }
  try{
    const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    let file=path.resolve(root,pathname==='/ ' ? 'index.html' : '.'+pathname);
    if(pathname==='/')file=path.join(root,'index.html');
    if(!file.startsWith(root))throw Error('outside root');
    const data=await readFile(file);
    res.setHeader('Content-Type',mime[path.extname(file)]??'application/octet-stream');res.end(data);
  }catch{res.writeHead(404);res.end('Not found');}
});
server.on('upgrade',(req,socket,head)=>{
  if(!req.url.startsWith('/ws?')){socket.destroy();return;}
  const upstream=net.connect(19090,'127.0.0.1',()=>{
    const headers={...req.headers,host:'127.0.0.1:19090',origin:'http://localhost'};
    upstream.write(`GET ${req.url} HTTP/1.1\r\n${Object.entries(headers).map(([k,v])=>`${k}: ${v}`).join('\r\n')}\r\n\r\n`);
    if(head.length)upstream.write(head);socket.pipe(upstream);upstream.pipe(socket);
  });upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());socket.on('close',()=>upstream.destroy());
});
server.listen(18080,'127.0.0.1',()=>console.log('Proof web host: http://127.0.0.1:18080 (loopback only)'));
