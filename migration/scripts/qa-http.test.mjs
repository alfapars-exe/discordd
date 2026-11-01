import {test} from 'node:test';
import assert from 'node:assert/strict';
import {apiPath,requestHeaders,responseHeaders} from './qa-http.mjs';
test('fixture routes cannot replace the destination or escape the API prefix',()=>{
 for(const input of ['https://example.invalid/api/devices','//example.invalid/api/devices','/api/../../admin','/admin'])assert.throws(()=>apiPath(input));
 assert.equal(apiPath('/api/devices'),'/api/devices');
 assert.equal(apiPath('/api/servers/uuid/channels?name=a%26b'),'/api/servers/uuid/channels?name=a%26b');
 assert.equal(apiPath('/api/servers/a%2Fb'),'/api/servers/a%2Fb');
});
test('fixture request headers use a fixed host and allowlist',()=>{
 const h=requestHeaders({host:'example.invalid',authorization:'Bearer synthetic',cookie:'synthetic=1',location:'https://example.invalid','x-unsafe':'ignored'});
 assert.equal(h.host,'127.0.0.1:19090');assert.equal(h.authorization,'Bearer synthetic');assert.equal(h['x-unsafe'],undefined);assert.equal(h.location,undefined);
});
test('fixture responses reject redirects and preserve only session cookies',()=>{
 const headers=new Map();let status,ended=false;const res={setHeader:(n,v)=>headers.set(n,v),writeHead:s=>status=s,end:()=>ended=true};
 assert.equal(responseHeaders({statusCode:302,headers:{location:'https://example.invalid'}},res),false);assert.equal(status,502);assert.equal(ended,true);assert.equal(headers.has('Location'),false);
 assert.equal(responseHeaders({statusCode:200,headers:{'set-cookie':['session=synthetic'],location:'ignored'}},res),true);assert.deepEqual(headers.get('Set-Cookie'),['session=synthetic']);
});
