const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { startRemoteServer } = require('../dist/server/server');
const { RemoteEngine } = require('../dist/remote/client');
const token = randomBytes(32).toString('base64url');
function snapshot(revision = 0, epoch = 'one') { return { engine:{id:'a',label:'test',protocolVersion:2,epoch,revision}, connection:{status:'connected'},paused:false,roots:[],settings:{downloadDirectory:'',parallelDownloads:1,autoDownloadInterval:60,deleteAfterDownload:false,showToolTips:true,autoStartApplication:false},hasToken:false,secureStorageAvailable:false,rules:[],jobs:[],scanStatus:'idle' }; }
function engine() { let state = snapshot(); const listeners = new Set(); return { async getSnapshot(){return state}, async execute(command){ if(command==='pause') {state = {...state,paused:true,engine:{...state.engine,revision:state.engine.revision+1}}; for(const f of listeners) f(state);} return {accepted:true};}, subscribe(f){listeners.add(f);f(state);return()=>listeners.delete(f)}, async close(){} }; }
test('authenticated requests, origin denial, bounds, and subscription', async t => {
 const e=engine(), server=await startRemoteServer(e,{host:'127.0.0.1',port:0,clientToken:token}); t.after(()=>server.close());
 const url=`http://127.0.0.1:${server.address.port}`, client=new RemoteEngine({url,token}); t.after(()=>client.close());
 assert.equal((await fetch(url+'/v2/state')).status,401);
 assert.equal((await fetch(url+'/v2/state',{headers:{authorization:`Bearer ${token}`,origin:'https://example.test'}})).status,401);
 assert.equal((await fetch(url+'/v2/commands',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({command:'shell',args:[]})})).status,400);
 assert.equal((await fetch(url+'/v2/commands',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({command:'pause',args:['x'.repeat(70000)]})})).status,413);
 assert.equal((await client.getSnapshot()).paused,false);
 const update = new Promise((resolve,reject)=>{ const timeout=setTimeout(()=>reject(new Error('event timeout')),3000); const unsubscribe=client.subscribe(s=>{if(s.paused){clearTimeout(timeout);unsubscribe();resolve(s)}}); });
 await new Promise(r=>setTimeout(r,100)); await client.execute('pause'); assert.equal((await update).paused,true);
});
test('rejects public bind and weak credential', async()=>{
 await assert.rejects(startRemoteServer(engine(),{host:'0.0.0.0',port:0,clientToken:token}));
 await assert.rejects(startRemoteServer(engine(),{host:'127.0.0.1',port:0,clientToken:'short'}));
});
test('a fresh client loads saved settings after the remote engine restarts', async t => {
 const fs = require('node:fs/promises');
 const os = require('node:os');
 const path = require('node:path');
 const { createEngine } = require('../dist/engine/engine');
 const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-settings-'));
 const root = path.join(dir, 'downloads');
 await fs.mkdir(root);
 const options = {
   stateDirectory: path.join(dir, 'state'),
   credentials: { available: () => false },
   roots: [{ id: 'root', label: 'Downloads', path: root }],
 };
 let engine, server, client;
 t.after(async () => {
   await client?.close();
   await server?.close();
   await engine?.close();
   await fs.rm(dir, { recursive: true, force: true });
 });
 const connect = async () => {
   engine = await createEngine(options);
   server = await startRemoteServer(engine, { host: '127.0.0.1', port: 0, clientToken: token });
   client = new RemoteEngine({ url: `http://127.0.0.1:${server.address.port}`, token });
 };
 await connect();
 const expected = { parallelDownloads: 4, autoDownloadInterval: 240, speedLimitBytesPerSecond: 2048, deleteAfterDownload: true, showToolTips: false };
 await client.execute('selectDownloadRoot', ['root']);
 await client.execute('saveSettings', [expected]);
 const before = await client.getSnapshot();
 await client.close();
 await server.close();
 await engine.close();
 await connect();
 const after = await client.getSnapshot();
 assert.equal(after.engine.id, before.engine.id);
 assert.notEqual(after.engine.epoch, before.engine.epoch);
 assert.equal(after.settings.downloadDirectory, before.settings.downloadDirectory);
 assert.ok(after.settings.downloadDirectory);
 for (const [key, value] of Object.entries(expected)) assert.equal(after.settings[key], value, key);
});
test('protocol mismatch is rejected before commands', async t=>{
 const http=require('node:http'); let submitted=0;
 const server=http.createServer((req,res)=>{ if(req.method==='POST') submitted++; res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify({ok:true,value:{...snapshot(),engine:{...snapshot().engine,protocolVersion:1}}})); });
 await new Promise(r=>server.listen(0,'127.0.0.1',r)); t.after(()=>new Promise(r=>server.close(r)));
 const client=new RemoteEngine({url:`http://127.0.0.1:${server.address().port}`,token}); t.after(()=>client.close());
 await assert.rejects(client.getSnapshot(),/incompatible/);
 await assert.rejects(client.execute('downloadFile',['1',{deleteAfterDownload:false}]),/incompatible/); assert.equal(submitted,0);
});
test('reconnects and resnapshots after server restart with a new epoch', async t => {
 const first=engine(); let server=await startRemoteServer(first,{host:'127.0.0.1',port:0,clientToken:token}); const port=server.address.port;
 const client=new RemoteEngine({url:`http://127.0.0.1:${port}`,token}); t.after(async()=>{await client.close();await server.close()});
 let seenFirst; const initial=new Promise(r=>seenFirst=r); let seenRestart; const restarted=new Promise((r,j)=>{seenRestart=r;setTimeout(()=>j(new Error('reconnect timeout')),5000).unref()});
 client.subscribe(s=>{if(s.engine.epoch==='one') seenFirst(); if(s.engine.epoch==='two') seenRestart(s)});
 await initial; await server.close(); const next=engine(); next.getSnapshot=async()=>snapshot(0,'two'); next.subscribe=f=>{f(snapshot(0,'two'));return()=>{}};
 server=await startRemoteServer(next,{host:'127.0.0.1',port,clientToken:token}); assert.equal((await restarted).engine.epoch,'two');
});
test('known failures receive safe categories and unexpected error text is hidden', async t=>{
 const e=engine(); e.execute=async command=>{ if(command==='pause') throw new Error('Engine is paused.'); if(command==='resume') throw new Error('Could not connect to put.io.'); throw new Error('sentinel-provider-secret'); };
 const server=await startRemoteServer(e,{host:'127.0.0.1',port:0,clientToken:token}); t.after(()=>server.close()); const url=`http://127.0.0.1:${server.address.port}`;
 for(const [command,status,code] of [['pause',409,'conflict'],['resume',502,'provider_unavailable'],['checkRules',500,'command_failed']]) {const response=await fetch(url+'/v2/commands',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({command,args:[]})}); const text=await response.text(); assert.equal(response.status,status); assert.equal(JSON.parse(text).error.code,code); assert.ok(!text.includes('sentinel-provider-secret'));}
 const client=new RemoteEngine({url,token}); t.after(()=>client.close()); await assert.rejects(client.execute('resume'),/could not contact put.io/);
 await Promise.all([server.close(),server.close()]);
});
test('remote rule editing and download options reach and persist on the engine', async t => {
 const fs=require('node:fs/promises'), os=require('node:os'), path=require('node:path');
 const {createEngine}=require('../dist/engine/engine'); const dir=await fs.mkdtemp(path.join(os.tmpdir(),'remote-rule-')); const root=path.join(dir,'root'); await fs.mkdir(root); t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const credentials={available:()=>false,encrypt:()=>{throw Error()},decrypt:()=>{throw Error()}};
 const transport=async url=> { const p=new URL(url).pathname; if(p==='/account/info') return Response.json({status:'OK'}); if(p==='/files/1') return Response.json({status:'OK',file:{id:1,parent_id:0,name:'a.txt',size:1,file_type:'FILE'}}); throw Error('unexpected'); };
 const e=await createEngine({stateDirectory:path.join(dir,'state'),credentials,token:'fixture',transport,apiBase:'http://fixture.test/',roots:[{id:'root',label:'Root',path:root}]});
 const server=await startRemoteServer(e,{host:'127.0.0.1',port:0,clientToken:token}); const client=new RemoteEngine({url:`http://127.0.0.1:${server.address.port}`,token}); t.after(async()=>{await client.close();await server.close();await e.close()});
 await client.execute('selectDownloadRoot',['root']); const destination=await client.execute('prepareRuleDirectory',['Movies']);
 const rule={folderId:'0',folderName:'Movies',downloadDirectory:destination,extensions:[],minSizeBytes:0,keepFolderStructure:false}; await client.execute('addRule',[rule]);
 const id=(await client.getSnapshot()).rules[0].id; await client.execute('updateRule',[id,{...rule,deleteAfterDownload:true,speedLimitBytesPerSecond:40}]);
 await client.execute('pause'); await client.execute('downloadFile',['1',{deleteAfterDownload:false,speedLimitBytesPerSecond:23}]); const state=await client.getSnapshot();
 assert.equal(state.rules[0].deleteAfterDownload,true); assert.equal(state.rules[0].speedLimitBytesPerSecond,40); assert.equal(state.jobs[0].deleteAfterDownload,false); assert.equal(state.jobs[0].speedLimitBytesPerSecond,23);
});

test('legacy v1 server cannot receive a v2 download command', async t=>{
 const http=require('node:http'); let posts=0;
 const legacy=http.createServer((req,res)=>{if(req.method==='POST') posts++; res.writeHead(404,{'content-type':'application/json'}); res.end(JSON.stringify({ok:false}));});
 await new Promise(r=>legacy.listen(0,'127.0.0.1',r)); t.after(()=>new Promise(r=>legacy.close(r)));
 const client=new RemoteEngine({url:`http://127.0.0.1:${legacy.address().port}`,token}); t.after(()=>client.close());
 await assert.rejects(client.execute('downloadFile',['1',{deleteAfterDownload:false}]),/incompatible/); assert.equal(posts,0);
});
for (const [field,value] of [['retryAt',123],['attemptCount',-1],['attemptCount',1.5]]) test(`remote client rejects malformed ${field} recovery state`,async t=>{
 const http=require('node:http');const job={id:'job',fileId:'1',name:'file',destination:'local',status:'waiting',bytesReceived:0,totalBytes:4,speed:0,addedAt:'2026-01-01T00:00:00Z',[field]:value};const server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,value:{...snapshot(),jobs:[job]}}));});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const client=new RemoteEngine({url:`http://127.0.0.1:${server.address().port}`,token});t.after(()=>client.close());let rejected=false;try{await client.getSnapshot()}catch{rejected=true;}assert.equal(rejected,true);
});
test('remote client rejects malformed cleanupPending snapshot',async t=>{
 const http=require('node:http');const job={id:'job',fileId:'1',name:'file',destination:'local',status:'completed',bytesReceived:4,totalBytes:4,speed:0,addedAt:'2026-01-01T00:00:00Z',cleanupPending:'yes'};const server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,value:{...snapshot(),jobs:[job]}}));});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const client=new RemoteEngine({url:`http://127.0.0.1:${server.address().port}`,token});t.after(()=>client.close());await assert.rejects(client.getSnapshot());
});

for(const [field,value] of [['stageDownloads','yes'],['stagingDirectory',7],['stagingMaxBytes',0],['stagingMinimumFreeBytes',-1]]) test(`remote snapshot rejects invalid ${field}`,()=>{const {isSnapshot}=require('../dist/remote/protocol');const valueSnapshot=snapshot();valueSnapshot.settings[field]=value;assert.equal(isSnapshot(valueSnapshot),false);});
test('remote snapshot accepts an older server without staging settings',()=>{const {isSnapshot}=require('../dist/remote/protocol');const old=snapshot();delete old.settings.stageDownloads;delete old.settings.stagingDirectory;delete old.settings.stagingMaxBytes;delete old.settings.stagingMinimumFreeBytes;assert.equal(isSnapshot(old),true);});
