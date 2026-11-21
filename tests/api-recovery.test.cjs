const test = require('node:test');
const assert = require('node:assert/strict');
const { PutioApi } = require('../dist/core/api');
const { withEngine, controlledRuntime } = require('./helpers/download-resilience-fixture.cjs');

for (const mode of ['local','remote']) test(`${mode}: provider authorization requires attention without publishing`, async t => {
  let calls=0;
  const f = await withEngine(t, mode, { file:{size:4}, fileResponse:file=>++calls===1 ? Response.json({status:'OK',file}) : new Response('private fixture secret',{status:403}) });
  await f.client.execute('downloadFile',['1',{deleteAfterDownload:true}]);
  const end=Date.now()+3000; let job;
  while(Date.now()<end) { job=(await f.client.getSnapshot()).jobs[0]; if(job?.status==='needs-attention') break; await new Promise(r=>setTimeout(r,10)); }
  assert.equal(job?.status,'needs-attention');
  assert.equal(JSON.stringify(job).includes('private fixture secret'),false);
  assert.deepEqual(f.deleted,[]);
});

test('provider status and Retry-After are safely classified', async () => {
  const runtime=controlledRuntime();
  for (const [status,kind,header,wait] of [[429,'transient','45',45000],[503,'transient','-1',undefined],[401,'authorization',null,undefined],[403,'authorization',null,undefined],[404,'missing',null,undefined]]) {
    const api=new PutioApi(()=> 'fixture', 'http://fixture.test/', async()=>new Response('secret provider body',{status,headers:header?{'Retry-After':header}:{}}),runtime);
    await assert.rejects(api.getFile('1'),error=> {assert.equal(error.kind,kind);assert.equal(error.status,status);assert.equal(error.retryAfterMs,wait);assert.equal(JSON.stringify(error).includes('secret'),false);return true;});
  }
});

test('deadline includes response JSON and cancellation remains user cancellation', async () => {
  const runtime=controlledRuntime();
  const api=new PutioApi(()=> 'fixture','http://fixture.test/',async()=>({ok:true,json:()=>new Promise(()=>{})}),runtime);
  const request=api.getFile('1'); await new Promise(r=>setImmediate(r)); runtime.advance(30000);
  const outcome=await Promise.race([request.then(()=>null,error=>error),new Promise(r=>setTimeout(()=>r('unsettled'),100))]);
  assert.equal(outcome?.kind,'transient');
  const controller=new AbortController(); const canceled=api.getFile('1',controller.signal); controller.abort();
  await assert.rejects(canceled,{name:'AbortError'});
});

test('ZIP polling preserves one archive beyond thirty seconds', async () => {
  let now=Date.UTC(2026,0,1), creates=0, polls=0;
  const runtime={now:()=>now,delay:(ms,signal)=>ms===1000 ? (now+=ms,Promise.resolve()) : new Promise((resolve,reject)=>signal?.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}))};
  const api=new PutioApi(()=> 'fixture','http://fixture.test/',async input=>{
    const p=new URL(input).pathname;
    if(p==='/zips/create') { creates++; return Response.json({status:'OK',zip_id:9}); }
    if(p==='/zips/9') { polls++; return Response.json(polls===32?{status:'OK',zip_status:'DONE',url:'http://fixture.test/archive',size:4,missing_files:[]}:{status:'OK',zip_status:'IN_PROGRESS'}); }
    if(p==='/files/1') return Response.json({status:'OK',file:{id:1,parent_id:0,name:'folder',file_type:'FOLDER',size:10}});
    throw Error('unexpected path');
  },runtime);
  const source=await api.zipSource('1');
  assert.equal(creates,1); assert.equal(polls,32); assert.equal(source.zipId,'9'); assert.equal(source.expectedBytes,4); assert.equal(source.zipContentsVerified,false);
});

test('future Retry-After date is measured against injected clock', async()=>{
 const runtime=controlledRuntime(); const api=new PutioApi(()=> 'fixture','http://fixture.test/',async()=>new Response('',{status:503,headers:{'Retry-After':'Thu, 01 Jan 2026 00:02:00 GMT'}}),runtime);
 await assert.rejects(api.getFile('1'), error=>{assert.equal(error.retryAfterMs,120000);return true;});
});

// Supplemental ZIP acceptance tests characterize the integrated implementation.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createEngine } = require('../dist/engine/engine');
const { startRemoteServer } = require('../dist/server/server');
const { RemoteEngine } = require('../dist/remote/client');

async function until(check) {
  const end=Date.now()+4000;
  while(Date.now()<end) { const result=await check(); if(result) return result; await new Promise(r=>setTimeout(r,10)); }
  throw Error('timed out waiting for ZIP fixture state');
}

async function zipEngine(t,mode,scenario) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'zip-recovery-'));
  const root=path.join(dir,'root'); await fs.mkdir(root);
  const runtime=controlledRuntime(), requests=[], deleted=[];
  const file={id:1,parent_id:0,name:'folder',file_type:'FOLDER',size:9000};
  const transport=async (input,init={})=>{
    const route=new URL(input).pathname;
    requests.push(route);
    if(route==='/files/1') return Response.json({status:'OK',file});
    if(route==='/zips/create') return Response.json({status:'OK',zip_id:9});
    if(route==='/zips/9') return scenario.poll(requests.filter(x=>x==='/zips/9').length,init);
    if(route==='/archive') return new Response('data');
    if(route==='/files/delete') {deleted.push(String(init.body.get('file_ids'))); return Response.json({status:'OK'});}
    throw Error('Unexpected synthetic route');
  };
  const engine=await createEngine({stateDirectory:path.join(dir,'state'),credentials:{available:()=>false,encrypt:()=>{throw Error('unexpected')},decrypt:()=>{throw Error('unexpected')}},token:'fixture',apiBase:'http://fixture.test/',transport,downloadRuntime:runtime,roots:[{id:'root',label:'Root',path:root}]});
  let client=engine,server;
  if(mode==='remote') {const token='a'.repeat(43);server=await startRemoteServer(engine,{host:'127.0.0.1',port:0,clientToken:token});client=new RemoteEngine({url:`http://127.0.0.1:${server.address.port}`,token});}
  t.after(async()=>{if(server){await client.close();await server.close();}await engine.close();await fs.rm(dir,{recursive:true,force:true});});
  await client.execute('selectDownloadRoot',['root']);
  return {client,root,runtime,requests,deleted};
}

for(const mode of ['local','remote']) {
  test(`${mode}: ZIP stays on one archive while readying beyond thirty seconds`,async t=>{
    const f=await zipEngine(t,mode,{poll:n=>Response.json(n===32?{status:'OK',zip_status:'DONE',url:'http://fixture.test/archive',size:4,missing_files:[]}:{status:'OK',zip_status:'IN_PROGRESS'})});
    const started=await f.client.execute('downloadZip',['1',{deleteAfterDownload:true}]);
    for(let poll=1;poll<=31;poll++) {
      await until(()=>f.requests.filter(x=>x==='/zips/9').length===poll && f.runtime.nextDeadline()===f.runtime.now()+1000);
      f.runtime.advance(1000);
    }
    const job=await until(async()=>{const j=(await f.client.getSnapshot()).jobs[0];return j?.status==='completed'&&j;});
    assert.equal(job.id,started.jobId); assert.equal(job.verification,'verified');
    assert.equal(await fs.readFile(path.join(f.root,'folder.zip'),'utf8'),'data');
    assert.equal(f.requests.filter(x=>x==='/zips/create').length,1);
    assert.equal(f.requests.filter(x=>x.startsWith('/zips/')&&x!=='/zips/create').length,32);
    assert.ok(f.requests.filter(x=>x.startsWith('/zips/')&&x!=='/zips/create').every(x=>x==='/zips/9'));
    assert.deepEqual(f.deleted,[]);
  });
  for(const stall of ['headers','json']) test(`${mode}: stalled ZIP ${stall} waits for recovery after its request deadline`,async t=>{
    const f=await zipEngine(t,mode,{poll:()=>stall==='headers'?new Promise(()=>{}):({ok:true,json:()=>new Promise(()=>{})})});
    const started=await f.client.execute('downloadZip',['1',{deleteAfterDownload:true}]);
    await until(()=>f.requests.includes('/zips/9') && f.runtime.nextDeadline()===f.runtime.now()+30000);
    f.runtime.advance(30000);
    const job=await until(async()=>{const j=(await f.client.getSnapshot()).jobs[0];return j?.status==='waiting'&&j;});
    assert.equal(job.id,started.jobId); assert.equal(job.attemptCount,1);
    assert.equal(f.requests.filter(x=>x==='/zips/create').length,1);
    await assert.rejects(fs.lstat(path.join(f.root,'folder.zip')),{code:'ENOENT'}); assert.deepEqual(f.deleted,[]);
  });
  test(`${mode}: cancel during ZIP poll wait prevents another poll and publication`,async t=>{
    const f=await zipEngine(t,mode,{poll:()=>Response.json({status:'OK',zip_status:'IN_PROGRESS'})});
    const started=await f.client.execute('downloadZip',['1',{deleteAfterDownload:true}]);
    await until(()=>f.requests.filter(x=>x==='/zips/9').length===1 && f.runtime.nextDeadline()===f.runtime.now()+1000);
    await f.client.execute('cancelDownloads',[[started.jobId]]);
    f.runtime.advance(60000); await new Promise(r=>setTimeout(r,50));
    const job=(await f.client.getSnapshot()).jobs[0];
    assert.equal(job.id,started.jobId); assert.equal(job.status,'canceled'); assert.equal(job.attemptCount ?? 0,0);
    assert.equal(f.requests.filter(x=>x==='/zips/9').length,1); assert.equal(f.requests.filter(x=>x==='/zips/create').length,1);
    await assert.rejects(fs.lstat(path.join(f.root,'folder.zip')),{code:'ENOENT'}); assert.deepEqual(f.deleted,[]);
  });
}

// Fix round 1: provider body transport failures must remain recoverable.
const http = require('node:http');
async function providerBodyServer(t) {
  const server=http.createServer((req,res)=>{
    if(req.url==='/drop') {res.writeHead(200,{'content-type':'application/json','content-length':'100'});res.write('{"status":"OK",');setTimeout(()=>res.destroy(),10);}
    else {res.writeHead(200,{'content-type':'application/json'});res.end('{invalid json');}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
  return `http://127.0.0.1:${server.address().port}`;
}
test('provider body socket drop is transient while malformed JSON remains invalid',async t=>{
  const url=await providerBodyServer(t);
  for(const [route,kind] of [['drop','transient'],['bad','invalid-response']]) {
    const api=new PutioApi(()=> 'fixture',`${url}/`,(input,init)=>fetch(`${url}/${route}`,init));
    await assert.rejects(api.getFile('1'),error=>{assert.equal(error.kind,kind);assert.equal(JSON.stringify(error).includes(url),false);return true;});
  }
});
for(const mode of ['local','remote']) test(`${mode}: dropped provider JSON body enters recovery without publishing`,async t=>{
  const url=await providerBodyServer(t);let calls=0;
  const f=await withEngine(t,mode,{downloadRuntime:controlledRuntime(),file:{size:4},fileResponse:(file,init)=>++calls===1?Response.json({status:'OK',file}):fetch(`${url}/drop`,init)});
  const started=await f.client.execute('downloadFile',['1',{deleteAfterDownload:true}]);
  const job=await until(async()=>{const j=(await f.client.getSnapshot()).jobs[0];return ['waiting','needs-attention'].includes(j?.status)&&j;});
  assert.equal(job.status,'waiting');assert.equal(job.id,started.jobId);assert.equal(job.attemptCount,1);
  assert.equal(JSON.stringify(job).includes(url),false);assert.deepEqual(f.deleted,[]);
  await assert.rejects(fs.lstat(path.join(f.root,'file.bin')),{code:'ENOENT'});
});

test('caller cancellation after JSON starts drains settlement and rejects late valid data',async()=>{
  let entered,release,settled=false;
  const started=new Promise(r=>entered=r), gate=new Promise(r=>release=r);
  const api=new PutioApi(()=> 'fixture','http://fixture.test/',async()=>({ok:true,json:async()=>{entered();await gate;return {status:'OK',file:{id:1,parent_id:0,name:'file',file_type:'FILE'}};}}));
  const controller=new AbortController();
  const request=api.getFile('1',controller.signal); request.then(()=>{settled=true;},()=>{settled=true;});
  await started; controller.abort(); await new Promise(r=>setImmediate(r));
  assert.equal(settled,false);
  release(); await assert.rejects(request,{name:'AbortError'});
});

test('Retry-After ignores unrepresentable deadlines while preserving valid long waits',async()=>{
  const runtime=controlledRuntime();
  for(const [seconds,expected] of [['8640000000000',undefined],['3000000',3000000000]]) {
    const api=new PutioApi(()=> 'fixture','http://fixture.test/',async()=>new Response('',{status:429,headers:{'Retry-After':seconds}}),runtime);
    await assert.rejects(api.getFile('1'),error=>{assert.equal(error.kind,'transient');assert.equal(error.retryAfterMs,expected);return true;});
  }
});
