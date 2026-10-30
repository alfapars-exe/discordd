// Local-only test host. Never deploy this fixture proxy as production infrastructure.
import http from 'node:http';
import net from 'node:net';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../hichat_native_proof/build/web/',import.meta.url));
const mime={'.html':'text/html','.js':'text/javascript','.wasm':'application/wasm','.json':'application/json','.css':'text/css','.png':'image/png','.ttf':'font/ttf','.otf':'font/otf'};
const server=http.createServer(async(req,res)=>{
  res.setHeader('Cross-Origin-Opener-Policy','same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy','require-corp');
  res.setHeader('Cache-Control','no-store');
  if(req.url.startsWith('/api/')){
    const upstream=http.request({host:'127.0.0.1',port:19090,path:req.url,method:req.method,headers:{...req.headers,host:'127.0.0.1:19090',origin:'http://localhost'}},incoming=>{res.writeHead(incoming.statusCode,incoming.headers);incoming.pipe(res);});
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
