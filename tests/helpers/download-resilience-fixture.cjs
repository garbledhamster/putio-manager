const {privateTemp}=require('./private-staging-fixture.cjs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createEngine } = require('../../dist/engine/engine');
const { startRemoteServer } = require('../../dist/server/server');
const { RemoteEngine } = require('../../dist/remote/client');
const credentials = { available: () => false, encrypt: () => { throw Error('unexpected'); }, decrypt: () => { throw Error('unexpected'); } };
async function withEngine(t, mode, scenario) {
  const dir = scenario.staging ? await privateTemp(path.join(os.tmpdir(), 'resilience-')) : await fs.mkdtemp(path.join(os.tmpdir(), 'resilience-'));
  const root = path.join(dir, 'root'); await fs.mkdir(root);
  const stage = scenario.staging ? path.join(dir, 'stage') : undefined; if(stage) await fs.mkdir(stage);
  let deleted = [];
  const file = {id:1,parent_id:0,name:'file.bin',file_type:'FILE',...scenario.file};
  const parentFolderId=String(scenario.parentFolder?.id ?? 2);
  const transport = async (input, init = {}) => {
    const p = new URL(input).pathname;
    if (p === '/account/info') return Response.json({status:'OK'});
    if (p === '/files/list') { const parent=scenario.parentFolder && new URL(input).searchParams.get('parent_id')===parentFolderId; if(parent) scenario.onFolderList?.(); const children=scenario.parentFolderChildren?.filter(child=>!deleted.includes(String(child.id))); return Response.json({status:'OK',files:parent ? (children ?? (scenario.parentFolderHasFiles ? [file] : [])) : [file]}); }
    if (p === '/files/1') return scenario.fileResponse ? scenario.fileResponse(file,init) : Response.json({status:'OK',file:scenario.onFile ? scenario.onFile(file) : file});
    if (p === '/files/2' && scenario.secondFile) return Response.json({status:'OK',file:{id:2,parent_id:0,name:'second.bin',file_type:'FILE',...scenario.secondFile}});
    if (p === `/files/${parentFolderId}` && scenario.parentFolder) return Response.json({status:'OK',file:{id:Number(parentFolderId),parent_id:0,name:'parent',file_type:'FOLDER',size:0}});
    if (p === '/files/2/url' && scenario.secondFile) return Response.json({status:'OK',url:'http://fixture.test/second'});
    if (p === '/second' && scenario.secondFile) return scenario.secondResponse ? scenario.secondResponse(init) : new Response('data');
    if (p === '/files/3' && scenario.thirdFile) return Response.json({status:'OK',file:{id:3,parent_id:0,name:'third.bin',file_type:'FILE',...scenario.thirdFile}});
    if (p === '/files/3/url' && scenario.thirdFile) return Response.json({status:'OK',url:'http://fixture.test/third'});
    if (p === '/third' && scenario.thirdFile) return scenario.thirdResponse ? scenario.thirdResponse(init) : new Response('data');
    if (p === '/files/1/url') return Response.json({status:'OK',url:'http://fixture.test/bytes'});
    if (p === '/files/delete') { const deletedId=String(init.body.get('file_ids'));deleted.push(deletedId); if (scenario.onDelete) { const result = await scenario.onDelete(deletedId); if (result) return result; } return Response.json({status:'OK'}); }
    if (p === '/zips/create') return Response.json({status:'OK',zip_id:scenario.zipCreate ? scenario.zipCreate() : 9});
    if (/^\/zips\/\d+$/.test(p)) { const id=Number(p.split('/').pop()); return Response.json({status:'OK',zip_status:'DONE',url:'http://fixture.test/bytes/'+id,missing_files:[],...scenario.zip,...(scenario.zipResponse?.(id) ?? {})}); }
    if (p === '/bytes' || p.startsWith('/bytes/')) { if (scenario.onBytes) await scenario.onBytes(root); return scenario.response ? scenario.response(init,Number(p.split('/').pop())) : new Response(scenario.bytes ?? 'data'); }
    throw Error('Unexpected fixture route: '+p);
  };
  const options = {stateDirectory:path.join(dir,'state'),credentials,token:'fixture',apiBase:'http://fixture.test/',transport,downloadRuntime:scenario.downloadRuntime,roots:[{id:'root',label:'Root',path:root}],...(stage?{stagingDirectory:stage,stagedCloseAdapter:scenario.stagedCloseAdapter}:{})};
  let engine = await createEngine(options), client = engine, server;
  if (mode === 'remote') { const token='a'.repeat(43); server=await startRemoteServer(engine,{host:'127.0.0.1',port:0,clientToken:token}); client=new RemoteEngine({url:`http://127.0.0.1:${server.address.port}`,token}); }
  t.after(async()=>{ if(server) { await client.close(); await server.close(); } await engine.close(); await fs.rm(dir,{recursive:true,force:true}); });
  await client.execute('selectDownloadRoot',['root']);
  if(stage) await client.execute('saveSettings',[{stageDownloads:true,stagingMaxBytes:scenario.stagingMaxBytes ?? 1024*1024,stagingMinimumFreeBytes:0}]);
  const fixture = {client,root,stage,dir,deleted, recoveryIntent(jobId) { return engine.queue.recovery[jobId]?.intent; }, anchorReleaseState(jobId) { const delivery=engine.queue.recovery[jobId]?.delivery; return {stage:delivery?.stageAnchorRelease,destination:delivery?.destinationAnchorRelease}; }, retryDiagnostics(jobId,runtime) { const q=engine.queue, record=q?.recovery?.[jobId], scalar=value=>Number.isFinite(value)?value:null, pending=q?.pendingRetries; return {active:scalar(q?.active?.size),pendingRetries:scalar(typeof pending==='number'?pending:pending?.size),intent:['run','paused','canceled'].includes(record?.intent)?record.intent:null,paused:typeof q?.paused==='boolean'?q.paused:null,stopping:typeof q?.stopping==='boolean'?q.stopping:null,wakeGeneration:scalar(q?.wakeGeneration),now:scalar(typeof runtime?.now==='function'?runtime.now():null),nextDeadline:scalar(typeof runtime?.nextDeadline==='function'?runtime.nextDeadline():null)}; }, async disconnectClient() { if(mode!=='remote')throw Error('remote only'); await client.close(); }, async reconnectClient() { const token='a'.repeat(43);client=new RemoteEngine({url:`http://127.0.0.1:${server.address.port}`,token});fixture.client=client; }, async restart(beforeCreate, overrides={}) {
    if(server) { await client.close(); await server.close(); server=undefined; }
    await engine.close(); if(beforeCreate) await beforeCreate(); Object.assign(options,overrides); engine=await createEngine(options); client=engine;
    if(mode==='remote') {const token='a'.repeat(43); server=await startRemoteServer(engine,{host:'127.0.0.1',port:0,clientToken:token});client=new RemoteEngine({url:`http://127.0.0.1:${server.address.port}`,token});}
    fixture.client=client;
  }};
  return fixture;
}
async function terminal(client) {
  const end=Date.now()+5000;
  let last=null;
  while(Date.now()<end) { const started=performance.now(),job=(await client.getSnapshot()).jobs[0],latency=performance.now()-started; last={status:['queued','downloading','copying','finalizing','cleaning','restarting','waiting','recovering','completed','unverified','canceled','paused','interrupted','needs-attention','failed'].includes(job?.status)?job.status:null,bytes:Number.isFinite(job?.bytesReceived)?job.bytesReceived:null,retryAt:typeof job?.retryAt==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(job.retryAt)?job.retryAt:null,retryCount:Number.isFinite(job?.attemptCount)?job.attemptCount:null,lastGetSnapshotMs:Math.round(latency*1000)/1000}; if(job && !['queued','downloading','copying','finalizing','cleaning','restarting','waiting','recovering'].includes(job.status)) return job; await new Promise(r=>setTimeout(r,15)); }
  throw Error(`timed out waiting for terminal job ${JSON.stringify(last)}`);
}
module.exports={withEngine,terminal};

function controlledRuntime() {
 let now=Date.UTC(2026,0,1), pending=[];
 return { now:()=>now, random:()=>0, delay:(ms,signal)=>ms <= 0 ? Promise.resolve() : new Promise((resolve,reject)=>{
  const item={at:now+ms,resolve,reject}; pending.push(item);
  if(signal) signal.addEventListener('abort',()=>{pending=pending.filter(p=>p!==item);reject(new DOMException('Aborted','AbortError'));},{once:true});
 }), nextDeadline(){return pending.length ? Math.min(...pending.map(p=>p.at)) : undefined;}, advance(ms){now+=ms; const due=pending.filter(p=>p.at<=now);pending=pending.filter(p=>p.at>now);due.forEach(p=>p.resolve());} };
}
module.exports.controlledRuntime=controlledRuntime;
