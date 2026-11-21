const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {withEngine,terminal,controlledRuntime}=require('./helpers/download-resilience-fixture.cjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function droppedPrefix(){let sent=false;return new ReadableStream({pull(c){if(!sent){sent=true;c.enqueue(new TextEncoder().encode('abcd'));}else c.error(Error('drop'));}},{highWaterMark:0});}
async function waitFor(fn){const end=Date.now()+5000;while(Date.now()<end){const value=await fn();if(value)return value;await sleep(10);}throw Error('fixture timeout');}
for(const mode of ['local','remote']) for(const scenario of ['drop','expired','changed','changed-kind','changed-size','restart']) test(`${mode}: regenerated ZIP ${scenario}`,async t=>{
 const runtime=controlledRuntime(), states=[], requests=[];let creates=0, fileReads=0;
 const f=await withEngine(t,mode,{downloadRuntime:runtime,file:{file_type:'FOLDER',size:1234,updated_at:'old'},onFile:file=>{fileReads++;return {...file,updated_at:scenario==='changed' && fileReads>=3?'new':'old',file_type:scenario==='changed-kind' && fileReads>=3?'FILE':'FOLDER',size:scenario==='changed-size' && fileReads>=3?5678:1234}},zipCreate:()=>++creates,zipResponse:id=>({size:id===1?8:10}),response:(init,id)=>{
  requests.push({id,range:init.headers?.Range});
  if(id===1 && scenario==='expired')return new Response('',{status:403});
  if(id===1)return new Response(droppedPrefix(),{headers:{etag:'"old"'}});
  return new Response('0123456789',{headers:{etag:'"new"'}});
 }});
 let unsubscribe=f.client.subscribe(s=>states.push(...s.jobs.map(j=>j.status)));t.after(()=>unsubscribe());
 const receipt=await f.client.execute('downloadZip',['1',{deleteAfterDownload:true}]);
 if(scenario!=='expired'){
  const waiting=await waitFor(async()=>{const j=(await f.client.getSnapshot()).jobs[0];return j?.status==='waiting'&&j});
  assert.equal(waiting.bytesReceived,4);
  if(scenario==='restart'){unsubscribe();await f.restart();unsubscribe=f.client.subscribe(s=>states.push(...s.jobs.map(j=>j.status)));}
  const job=await waitFor(async()=>{const j=(await f.client.getSnapshot()).jobs[0];return j?.status==='waiting'&&runtime.nextDeadline()===Date.parse(j.retryAt)&&j});
  runtime.advance(Date.parse(job.retryAt)-runtime.now());
 }
 const done=await terminal(f.client);assert.equal(done.id,receipt.jobId);assert.equal((await f.client.getSnapshot()).jobs.length,1);
 if(scenario.startsWith('changed')) {assert.equal(done.status,'needs-attention');assert.equal(requests.length,1);const partial=(await fs.readdir(f.root)).find(n=>n.endsWith('.download'));assert.equal(await fs.readFile(path.join(f.root,partial),'utf8'),'abcd');}
 else {assert.equal(done.status,'completed');assert.equal(done.totalBytes,10);assert.equal(done.verification,'verified');assert.equal(await fs.readFile(path.join(f.root,'file.bin.zip'),'utf8'),'0123456789');assert.deepEqual(requests,[{id:1,range:undefined},{id:2,range:undefined}]);if(scenario!=='expired')assert.ok(states.includes('restarting'));const state=JSON.parse(await fs.readFile(path.join(f.dir,'state','engine.json'),'utf8'));assert.equal(state.recovery[receipt.jobId].source.zipId,'2');assert.equal(state.recovery[receipt.jobId].source.expectedBytes,10);assert.equal(state.recovery[receipt.jobId].source.etag,'"new"');}
 assert.equal(creates,2);assert.deepEqual(f.deleted,[]);
});
for(const mode of ['local','remote']) for(const action of ['pause','cancelDownloads']) test(`${mode}: ${action} settles regenerated ZIP restart before dispatch`,async t=>{
 const runtime=controlledRuntime();let creates=0,blocked=false,persistedIntent=false,release;const gate=new Promise(r=>release=r);const requests=[];const original=fs.open,originalRename=fs.rename;
 fs.open=async(...args)=>{const h=await original(...args);if(String(args[0]).endsWith('.download')&&args[1]==='r+'){const truncate=h.truncate.bind(h);h.truncate=async(...a)=>{blocked=true;await gate;return truncate(...a)};}return h;};
 fs.rename=async(from,to)=>{let matches=false;if(String(to).endsWith('engine.json')){const state=JSON.parse(await fs.readFile(from,'utf8'));matches=Object.values(state.recovery||{}).some(r=>r.intent===(action==='pause'?'paused':'canceled'));}await originalRename(from,to);if(matches)persistedIntent=true;};t.after(()=>{fs.open=original;fs.rename=originalRename;release()});
 const f=await withEngine(t,mode,{downloadRuntime:runtime,file:{file_type:'FOLDER',size:1234,updated_at:'old'},zipCreate:()=>++creates,zipResponse:id=>({size:id===1?8:10}),response:(init,id)=>{requests.push(id);return id===1?new Response(droppedPrefix(),{headers:{etag:'"old"'}}):new Response('0123456789',{headers:{etag:'"new"'}});}});
 const receipt=await f.client.execute('downloadZip',['1',{deleteAfterDownload:true}]);const job=await waitFor(async()=>{const j=(await f.client.getSnapshot()).jobs[0];return j?.status==='waiting'&&runtime.nextDeadline()===Date.parse(j.retryAt)&&j});runtime.advance(Date.parse(job.retryAt)-runtime.now());await waitFor(()=>blocked);
 const stop=f.client.execute(action,action==='pause'?[]:[[receipt.jobId]]);await waitFor(()=>persistedIntent);release();await stop;
 const after=(await f.client.getSnapshot()).jobs[0];assert.equal(after.status,action==='pause'?'paused':'canceled');assert.deepEqual(requests,[1]);assert.deepEqual(f.deleted,[]);await assert.rejects(fs.lstat(path.join(f.root,'file.bin.zip')),{code:'ENOENT'});
});
for(const mode of ['local','remote']) for(const action of ['pause','cancelDownloads']) test(`${mode}: ${action} intent blocks ZIP dispatch while save is held`,async t=>{
 const runtime=controlledRuntime();let creates=0,truncateBlocked=false,saveBlocked=false,releaseTruncate,releaseSave;const truncateGate=new Promise(r=>releaseTruncate=r),saveGate=new Promise(r=>releaseSave=r);const requests=[];const originalOpen=fs.open,originalRename=fs.rename;
 fs.open=async(...args)=>{const h=await originalOpen(...args);if(String(args[0]).endsWith('.download')&&args[1]==='r+'){const truncate=h.truncate.bind(h);h.truncate=async(...a)=>{truncateBlocked=true;await truncateGate;return truncate(...a)};}return h;};
 fs.rename=async(from,to)=>{if(String(to).endsWith('engine.json')){const state=JSON.parse(await fs.readFile(from,'utf8'));if(!saveBlocked&&Object.values(state.recovery||{}).some(r=>r.intent===(action==='pause'?'paused':'canceled'))){saveBlocked=true;await saveGate;}}return originalRename(from,to);};t.after(()=>{fs.open=originalOpen;fs.rename=originalRename;releaseTruncate();releaseSave()});
 const f=await withEngine(t,mode,{downloadRuntime:runtime,file:{file_type:'FOLDER',size:1234,updated_at:'old'},zipCreate:()=>++creates,zipResponse:id=>({size:id===1?8:10}),response:(init,id)=>{requests.push(id);return id===1?new Response(droppedPrefix(),{headers:{etag:'"old"'}}):new Response('0123456789',{headers:{etag:'"new"'}});}});
 const receipt=await f.client.execute('downloadZip',['1',{deleteAfterDownload:true}]);const job=await waitFor(async()=>{const j=(await f.client.getSnapshot()).jobs[0];return j?.status==='waiting'&&runtime.nextDeadline()===Date.parse(j.retryAt)&&j});runtime.advance(Date.parse(job.retryAt)-runtime.now());await waitFor(()=>truncateBlocked);
 const stop=f.client.execute(action,action==='pause'?[]:[[receipt.jobId]]);try{await waitFor(()=>saveBlocked);releaseTruncate();await sleep(150);assert.deepEqual(requests,[1]);}finally{releaseSave();await stop;}
 assert.deepEqual(f.deleted,[]);await assert.rejects(fs.lstat(path.join(f.root,'file.bin.zip')),{code:'ENOENT'});
});
for(const mode of ['local','remote']) for(const scenario of ['file-drop','file-expired','file-old-record','file-changed-kind']) test(`${mode}: regenerated ZIP ${scenario}`,async t=>{
 const runtime=controlledRuntime(),states=[],requests=[];let creates=0,reads=0;
 const f=await withEngine(t,mode,{downloadRuntime:runtime,file:{file_type:'FILE',size:1234,updated_at:'old'},onFile:file=>{reads++;return {...file,file_type:scenario==='file-changed-kind'&&reads>=3?'FOLDER':'FILE'}},zipCreate:()=>++creates,zipResponse:id=>({size:id===1?8:10}),response:(init,id)=>{requests.push({id,range:init.headers?.Range});if(id===1&&scenario==='file-expired')return new Response('',{status:403});if(id===1)return new Response(droppedPrefix(),{headers:{etag:'"old"'}});return new Response('0123456789',{headers:{etag:'"new"'}});}});
 let unsubscribe=f.client.subscribe(s=>states.push(...s.jobs.map(j=>j.status)));t.after(()=>unsubscribe());const receipt=await f.client.execute('downloadZip',['1',{deleteAfterDownload:true}]);
 if(scenario!=='file-expired'){
  const waiting=await waitFor(async()=>{const j=(await f.client.getSnapshot()).jobs[0];return j?.status==='waiting'&&j});assert.equal(waiting.bytesReceived,4);
  if(scenario==='file-old-record'){unsubscribe();await f.restart(async()=>{const p=path.join(f.dir,'state','engine.json'),state=JSON.parse(await fs.readFile(p,'utf8'));delete state.recovery[receipt.jobId].source.sourceIsFolder;await fs.writeFile(p,JSON.stringify(state));});unsubscribe=f.client.subscribe(s=>states.push(...s.jobs.map(j=>j.status)));}
  const job=await waitFor(async()=>{const j=(await f.client.getSnapshot()).jobs[0];return j?.status==='waiting'&&runtime.nextDeadline()===Date.parse(j.retryAt)&&j});runtime.advance(Date.parse(job.retryAt)-runtime.now());
 }
 const done=await terminal(f.client);assert.equal(done.id,receipt.jobId);assert.equal((await f.client.getSnapshot()).jobs.length,1);
 if(scenario==='file-changed-kind'){assert.equal(done.status,'needs-attention');assert.deepEqual(requests,[{id:1,range:undefined}]);const partial=(await fs.readdir(f.root)).find(n=>n.endsWith('.download'));assert.equal(await fs.readFile(path.join(f.root,partial),'utf8'),'abcd');}
 else {assert.equal(done.status,'completed');assert.equal(done.totalBytes,10);assert.equal(done.verification,'verified');assert.equal(await fs.readFile(path.join(f.root,'file.bin.zip'),'utf8'),'0123456789');assert.deepEqual(requests,[{id:1,range:undefined},{id:2,range:undefined}]);if(scenario!=='file-expired')assert.ok(states.includes('restarting'));const state=JSON.parse(await fs.readFile(path.join(f.dir,'state','engine.json'),'utf8'));assert.equal(state.recovery[receipt.jobId].source.zipId,'2');assert.equal(state.recovery[receipt.jobId].source.expectedBytes,10);assert.equal(state.recovery[receipt.jobId].source.etag,'"new"');assert.equal(state.recovery[receipt.jobId].source.sourceIsFolder,false);}
 assert.equal(creates,2);assert.deepEqual(f.deleted,[]);
});
