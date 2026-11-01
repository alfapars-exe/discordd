import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
const resolveClient=createRequire(new URL('../../client/package.json',import.meta.url));
const {build}=await import(pathToFileURL(resolveClient.resolve('vite')).href);
const root=fileURLToPath(new URL('../../',import.meta.url));
await build({configFile:false,root,resolve:{alias:{'@noble':root+'/client/node_modules/@noble',idb:root+'/client/node_modules/idb/build/index.js'}},cacheDir:root+'/migration/.local/legacy-chat-vite-cache',define:{'import.meta.env.VITE_SERVER_URL':JSON.stringify('http://127.0.0.1:18080'),'import.meta.env.DEV':'true',__APP_VERSION__:JSON.stringify('local-chat-interop')},build:{outDir:root+'/migration/.local/source-bundle',emptyOutDir:false,lib:{entry:root+'/migration/scripts/legacy-chat-entry.ts',name:'HichatLegacyChatFixture',formats:['es'],fileName:()=>'legacy-chat.js'},rollupOptions:{output:{inlineDynamicImports:true}}}});
