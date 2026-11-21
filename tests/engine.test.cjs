const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createEngine } = require('../dist/engine/engine');
const credentials = { available: () => false, encrypt: () => { throw Error('unexpected'); }, decrypt: () => { throw Error('unexpected'); } };
async function until(fn) { const end = Date.now() + 5000; while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 20)); } throw Error('timed out'); }
test('receipts, pause and queued work survive restart and resume through the engine', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'engine-test-'));
  const downloads = path.join(dir, 'downloads'); await fs.mkdir(downloads);
  let base; let requests = 0;
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/account/info') return res.end(JSON.stringify({status:'OK'}));
    if (req.url === '/files/1') return res.end(JSON.stringify({status:'OK',file:{id:1,parent_id:0,name:'fixture.txt',size:4,file_type:'FILE'}}));
    if (req.url === '/files/1/url?notunnel=1') { requests++; return res.end(JSON.stringify({status:'OK',url:base+'bytes'})); }
    if (req.url === '/bytes') { res.setHeader('Content-Type','text/plain'); return res.end('data'); }
    res.statusCode=404; res.end();
  });
  await new Promise(r => server.listen(0,'127.0.0.1',r)); base = `http://127.0.0.1:${server.address().port}/`;
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); await fs.rm(dir,{recursive:true,force:true}); });
  const options = { stateDirectory: path.join(dir,'state'), credentials, apiBase: base, token:'fixture-only', roots:[{id:'data',label:'Data',path:downloads}] };
  let engine = await createEngine(options);
  await engine.execute('selectDownloadRoot',['data']);
  await engine.execute('pause');
  const receipt = await engine.execute('downloadFile',['1'],'request-1');
  assert.deepEqual(await engine.execute('downloadFile',['1'],'request-1'),receipt);
  await assert.rejects(engine.execute('downloadZip',['1'],'request-1'),/conflicts/);
  assert.equal((await engine.getSnapshot()).jobs[0].status,'queued');
  await assert.rejects(engine.execute('saveSettings',[{downloadDirectory:dir}]),/outside/);
  await assert.rejects(engine.execute('selectDownloadRoot',['data','../escape']),/relative/);
  await engine.close();
  engine = await createEngine(options);
  assert.equal((await engine.getSnapshot()).paused,true);
  assert.deepEqual(await engine.execute('downloadFile',['1'],'request-1'),receipt);
  assert.equal(requests,0);
  await engine.execute('resume');
  await until(async () => (await engine.getSnapshot()).jobs[0].status === 'completed');
  assert.equal(await fs.readFile(path.join(downloads,'fixture.txt'),'utf8'),'data');
  assert.equal(requests,1);
  const state = await fs.readFile(path.join(dir,'state','engine.json'),'utf8');
  assert.equal(state.includes('fixture-only'),false);
  await engine.close();
});

test('engine rejects a live duplicate and recovers a stale same-host owner', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'engine-lock-'));
  t.after(() => fs.rm(dir,{recursive:true,force:true}));
  const opts = {stateDirectory:dir,credentials};
  let first = await createEngine(opts);
  await assert.rejects(createEngine(opts), /already owned/);
  await first.close();
  await fs.writeFile(path.join(dir,'.engine-owner.lock'), JSON.stringify({pid:2147483647,host:os.hostname(),nonce:'dead-fixture'}));
  first = await createEngine(opts);
  await assert.rejects(createEngine(opts), /already owned/);
  await first.close();
});

test('close drains a delayed download request and a delayed scan without starting work', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'engine-close-'));
  const target = path.join(dir,'target'); await fs.mkdir(target);
  t.after(() => fs.rm(dir,{recursive:true,force:true}));
  const gates = new Map(); let started = []; let sources = 0;
  const json = data => new Response(JSON.stringify(data), {status:200,headers:{'Content-Type':'application/json'}});
  const file = {id:1,parent_id:0,name:'fixture.txt',size:4,file_type:'FILE'};
  const transport = async url => {
    const pathname = new URL(url).pathname;
    if (pathname === '/account/info') return json({status:'OK'});
    if (pathname === '/files/1' || pathname === '/files/list') {
      started.push(pathname);
      await new Promise(resolve => gates.set(pathname,resolve));
      return json(pathname === '/files/1' ? {status:'OK',file} : {status:'OK',files:[file]});
    }
    sources++; return json({status:'OK',url:'http://invalid.test/bytes'});
  };
  const opts = {stateDirectory:path.join(dir,'state'),credentials,apiBase:'http://fixture.test/',token:'fixture',transport,roots:[{id:'root',label:'Root',path:target}]};
  let engine = await createEngine(opts);
  await engine.execute('selectDownloadRoot',['root']);
  const pending = engine.execute('downloadFile',['1']);
  const handled = pending.catch(() => {});
  await until(() => started.includes('/files/1'));
  let closed = false; const closing = engine.close().then(() => { closed = true; });
  await new Promise(r => setTimeout(r,25)); assert.equal(closed,false);
  gates.get('/files/1')(); await closing; await handled;
  assert.equal(sources,0); assert.equal((await engine.getSnapshot()).jobs.length,0);
  engine = await createEngine(opts);
  await engine.execute('addRule',[{folderId:'0',folderName:'Folder',downloadDirectory:target,extensions:[],minSizeBytes:0,keepFolderStructure:false}]);
  const scan = engine.execute('checkRules').catch(() => {});
  await until(() => started.includes('/files/list'));
  const closingScan = engine.close(); gates.get('/files/list')(); await closingScan; await scan;
  assert.equal(sources,0); assert.equal((await engine.getSnapshot()).jobs.length,0);
  assert.deepEqual(await fs.readdir(target),[]);
});

test('noncredential settings do not turn a rejected saved token into a connected account', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'engine-auth-'));
  t.after(() => fs.rm(dir,{recursive:true,force:true}));
  const engine = await createEngine({stateDirectory:dir,credentials,token:'fixture',apiBase:'http://fixture.test/',transport:async () => new Response('',{status:401})});
  await until(async () => (await engine.getSnapshot()).connection.status === 'error');
  const state = await engine.execute('saveSettings',[{showToolTips:false}]);
  assert.equal(state.connection.status,'error');
  await engine.close();
});

test('progress persistence errors are reported without an unhandled rejection', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'engine-progress-'));
  const target = path.join(dir,'target'); await fs.mkdir(target);
  t.after(() => fs.rm(dir,{recursive:true,force:true}));
  const json = data => new Response(JSON.stringify(data),{status:200});
  let streamController;
  const transport = async url => {
    const u = new URL(url);
    if (u.pathname === '/account/info') return json({status:'OK'});
    if (u.pathname === '/files/1') return json({status:'OK',file:{id:1,parent_id:0,name:'slow.bin',size:8,file_type:'FILE'}});
    if (u.pathname === '/files/1/url') return json({status:'OK',url:'http://fixture.test/bytes'});
    if (u.pathname === '/bytes') return new Response(new ReadableStream({start(c) { streamController = c; }}));
    throw Error('unexpected request');
  };
  const stateDir = path.join(dir,'state');
  const engine = await createEngine({stateDirectory:stateDir,credentials,token:'fixture',apiBase:'http://fixture.test/',transport,roots:[{id:'root',label:'Root',path:target}]});
  await engine.execute('selectDownloadRoot',['root']);
  await engine.execute('downloadFile',['1']);
  await until(() => !!streamController);
  await new Promise(r => setTimeout(r,50));
  const obstruction = path.join(stateDir,'engine.json.tmp'); await fs.mkdir(obstruction);
  streamController.enqueue(new TextEncoder().encode('part'));
  await until(async () => (await engine.getSnapshot()).connection.message === 'Could not save engine state.');
  await fs.rm(obstruction,{recursive:true});
  await engine.close();
});

test('local and HTTP clients share pause, receipt, queue and completed bytes behavior', async t => {
  const { startRemoteServer } = require('../dist/server/server');
  const { RemoteEngine } = require('../dist/remote/client');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'engine-parity-'));
  t.after(() => fs.rm(dir,{recursive:true,force:true}));
  const json = data => new Response(JSON.stringify(data),{status:200});
  for (const mode of ['local','remote']) {
    const target = path.join(dir,mode); await fs.mkdir(target);
    const transport = async url => {
      const u = new URL(url);
      if (u.pathname === '/account/info') return json({status:'OK'});
      if (u.pathname === '/files/1') return json({status:'OK',file:{id:1,parent_id:0,name:'file.txt',size:4,file_type:'FILE'}});
      if (u.pathname === '/files/1/url') return json({status:'OK',url:'http://fixture.test/bytes'});
      if (u.pathname === '/bytes') return new Response('data');
      throw Error('unexpected request');
    };
    const engine = await createEngine({stateDirectory:path.join(dir,mode+'-state'),credentials,token:'fixture',apiBase:'http://fixture.test/',transport,roots:[{id:'root',label:'Root',path:target}]});
    let server, client = engine;
    if (mode === 'remote') {
      const token = 'a'.repeat(43); server = await startRemoteServer(engine,{host:'127.0.0.1',port:0,clientToken:token});
      client = new RemoteEngine({url:`http://127.0.0.1:${server.address.port}`,token});
    }
    await client.execute('selectDownloadRoot',['root']); await client.execute('pause');
    const first = await client.execute('downloadFile',['1'],'same-request');
    assert.deepEqual(await client.execute('downloadFile',['1'],'same-request'),first);
    assert.equal((await client.getSnapshot()).jobs[0].status,'queued');
    await client.execute('resume');
    await until(async () => (await client.getSnapshot()).jobs[0].status === 'completed');
    assert.equal(await fs.readFile(path.join(target,'file.txt'),'utf8'),'data');
    if (server) { await client.close(); await server.close(); }
    await engine.close();
  }
});

test('startup failure releases state ownership', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'engine-lock-failure-'));
  t.after(() => fs.rm(dir,{recursive:true,force:true}));
  await fs.writeFile(path.join(dir,'settings.json'),'{invalid');
  await assert.rejects(createEngine({stateDirectory:dir,credentials}), /saved settings/);
  await fs.rm(path.join(dir,'settings.json'));
  const engine = await createEngine({stateDirectory:dir,credentials});
  await engine.close();
});
test('rule destinations, edit, scheduling and resolved queued options survive restart', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'engine-rules-'));
  const root = path.join(dir,'downloads'); await fs.mkdir(root);
  t.after(() => fs.rm(dir,{recursive:true,force:true}));
  let now = new Date('2026-01-01T12:00:00Z'); let lists=0;
  const transport = async url => {
    const pathname = new URL(url).pathname;
    if (pathname === '/account/info') return Response.json({status:'OK'});
    if (pathname === '/files/list') { lists++; return Response.json({status:'OK',files:[{id:1,parent_id:0,name:'movie.mkv',size:400000000,file_type:'FILE'}]}); }
    if (pathname === '/files/1') return Response.json({status:'OK',file:{id:1,parent_id:0,name:'movie.mkv',size:400000000,file_type:'FILE'}});
    throw Error('unexpected fixture request');
  };
  const options = {stateDirectory:path.join(dir,'state'),credentials,roots:[{id:'root',label:'Root',path:root}],token:'fixture',apiBase:'http://fixture.test/',transport,now:()=>now};
  let engine = await createEngine(options); await engine.execute('selectDownloadRoot',['root']);
  await assert.rejects(engine.execute('prepareRuleDirectory',['../escape']),/safe|valid|relative/i);
  await fs.writeFile(path.join(root,'collision'),'x');
  await assert.rejects(engine.execute('prepareRuleDirectory',['collision']),/unsafe/i);
  const destination = await engine.execute('prepareRuleDirectory',['Movies/Nested']);
  let rule = {folderId:'0',folderName:'Movies',downloadDirectory:destination,extensions:[],minSizeBytes:300000000,keepFolderStructure:false,schedule:{kind:'interval',seconds:10},deleteAfterDownload:false,speedLimitBytesPerSecond:25};
  await engine.execute('addRule',[rule]); let snapshot=await engine.getSnapshot(); const ruleId=snapshot.rules[0].id;
  assert.equal(snapshot.timeZone,Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.equal(snapshot.nextRuleRuns[ruleId],new Date(now.getTime()+10000).toISOString());
  await engine.execute('pause'); now=new Date(now.getTime()+30000); await engine.tickSchedules(); assert.equal(lists,0);
  await engine.execute('resume'); now=new Date(now.getTime()+10000); await engine.tickSchedules(); assert.equal(lists,1);
  await until(async()=> (await engine.getSnapshot()).jobs.length === 1);
  await engine.execute('pause'); rule={...rule,keepFolderStructure:true,deleteAfterDownload:true,speedLimitBytesPerSecond:50}; await engine.execute('updateRule',[ruleId,rule]);
  snapshot=await engine.getSnapshot(); assert.equal(snapshot.rules[0].id,ruleId); assert.equal(snapshot.rules[0].keepFolderStructure,true);
  assert.equal(snapshot.jobs[0].deleteAfterDownload,false); assert.equal(snapshot.jobs[0].speedLimitBytesPerSecond,25);
  await engine.close(); engine=await createEngine(options); snapshot=await engine.getSnapshot(); assert.equal(snapshot.rules[0].deleteAfterDownload,true); assert.equal(snapshot.rules[0].speedLimitBytesPerSecond,50); assert.equal(snapshot.jobs[0].deleteAfterDownload,false); await engine.close();
});
test('overlapping scans retain different due rules without concurrent traversal', async () => {
  const { RuleScanner } = require('../dist/core/rules'); let release; const seen=[]; let active=0, max=0;
  const scanner = new RuleScanner(async id => { active++; max=Math.max(max,active); seen.push(id); if(id==='1') await new Promise(r=>release=r); active--; return []; },async()=>{});
  const make = id=>({id,folderId:id,folderName:id,downloadDirectory:'C:/fixture',extensions:[],minSizeBytes:0,keepFolderStructure:false});
  const first=scanner.scan([make('1')]); await until(()=>!!release); const second=scanner.scan([make('2')]); release(); await Promise.all([first,second]); assert.deepEqual(seen,['1','2']); assert.equal(max,1);
});
test('daily schedules skip nonexistent DST time and run repeated time only once', async t => {
  const old=process.env.TZ; process.env.TZ='America/New_York'; t.after(()=>{if(old===undefined) delete process.env.TZ; else process.env.TZ=old;});
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'engine-dst-')); t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const root=path.join(dir,'root'); await fs.mkdir(root); let now=new Date('2026-03-08T06:00:00Z');
  const engine=await createEngine({stateDirectory:path.join(dir,'state'),credentials,roots:[{id:'root',label:'Root',path:root}],now:()=>now}); t.after(()=>engine.close());
  await engine.execute('selectDownloadRoot',['root']);
  await engine.execute('addRule',[{folderId:'0',folderName:'DST',downloadDirectory:root,extensions:[],minSizeBytes:0,keepFolderStructure:false,schedule:{kind:'daily',time:'02:30'}}]);
  let snap=await engine.getSnapshot(), rule=snap.rules[0]; assert.equal(snap.nextRuleRuns[rule.id],'2026-03-09T06:30:00.000Z');
  now=new Date('2026-11-01T04:00:00Z'); await engine.execute('updateRule',[rule.id,{...rule,schedule:{kind:'daily',time:'01:30'}}]);
  snap=await engine.getSnapshot(); assert.equal(snap.nextRuleRuns[rule.id],'2026-11-01T05:30:00.000Z');
  now=new Date('2026-11-01T05:30:00Z'); await engine.tickSchedules(); snap=await engine.getSnapshot(); assert.equal(snap.nextRuleRuns[rule.id],'2026-11-02T06:30:00.000Z');
});
test('unrelated settings and rule edits preserve existing schedule deadlines', async t => {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'schedule-deadline-')); t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const root=path.join(dir,'root'); await fs.mkdir(root); let now=new Date('2026-01-01T12:00:00Z');
 const e=await createEngine({stateDirectory:path.join(dir,'state'),credentials,roots:[{id:'root',label:'Root',path:root}],now:()=>now}); t.after(()=>e.close()); await e.execute('selectDownloadRoot',['root']);
 const base={folderId:'0',folderName:'one',downloadDirectory:root,extensions:[],minSizeBytes:0,keepFolderStructure:false};
 await e.execute('addRule',[{...base,schedule:{kind:'interval',seconds:60}}]); await e.execute('addRule',[{...base,folderName:'two'}]);
 let s=await e.getSnapshot(); const [first,second]=s.rules; const firstDue=s.nextRuleRuns[first.id],secondDue=s.nextRuleRuns[second.id];
 now=new Date('2026-01-01T12:00:59Z'); await e.execute('saveSettings',[{showToolTips:false}]); await e.execute('updateRule',[first.id,{...first,folderName:'edited'}]);
 s=await e.getSnapshot(); assert.equal(s.nextRuleRuns[first.id],firstDue); assert.equal(s.nextRuleRuns[second.id],secondDue);
 await e.execute('saveSettings',[{autoDownloadInterval:120}]); s=await e.getSnapshot(); assert.equal(s.nextRuleRuns[first.id],firstDue); assert.equal(s.nextRuleRuns[second.id],'2026-01-01T12:02:59.000Z');
 await e.execute('updateRule',[first.id,{...first,schedule:{kind:'interval',seconds:90}}]); s=await e.getSnapshot(); assert.equal(s.nextRuleRuns[first.id],'2026-01-01T12:02:29.000Z');
 await e.execute('removeRule',[second.id]); s=await e.getSnapshot(); assert.equal(s.nextRuleRuns[first.id],'2026-01-01T12:02:29.000Z'); assert.equal(s.nextRuleRuns[second.id],undefined);
});

test('local rule destination rejects a selected root replaced with a junction', async t => {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'engine-root-')); t.after(()=>fs.rm(dir,{recursive:true,force:true})); const root=path.join(dir,'root'), outside=path.join(dir,'outside'); await fs.mkdir(root); await fs.mkdir(outside);
 const e=await createEngine({stateDirectory:path.join(dir,'state'),credentials}); t.after(()=>e.close()); e.allowDirectory(root); await e.execute('saveSettings',[{downloadDirectory:root}]);
 await fs.rename(root,path.join(dir,'original')); await fs.symlink(outside,root,'junction');
 await assert.rejects(e.execute('prepareRuleDirectory',['Movies']),/unsafe/i); assert.deepEqual(await fs.readdir(outside),[]);
});
test('configured root accepts its original trusted alias but rejects a child junction', async t => {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'root-alias-')); t.after(()=>fs.rm(dir,{recursive:true,force:true})); const physical=path.join(dir,'physical'), alias=path.join(dir,'alias'), outside=path.join(dir,'outside'); await fs.mkdir(physical); await fs.mkdir(outside); await fs.symlink(physical,alias,'junction');
 const e=await createEngine({stateDirectory:path.join(dir,'state'),credentials,roots:[{id:'root',label:'Root',path:alias}]}); t.after(()=>e.close());
 await e.execute('addRule',[{folderId:'0',folderName:'alias',downloadDirectory:alias,extensions:[],minSizeBytes:0,keepFolderStructure:false}]);
 assert.equal((await e.getSnapshot()).rules[0].downloadDirectory,await fs.realpath(physical));
 await fs.symlink(outside,path.join(physical,'escape'),'junction'); await assert.rejects(e.execute('saveSettings',[{downloadDirectory:path.join(alias,'escape')}]),/unsafe/i);
});
test('legacy queued jobs using the trusted root alias restore safely', async t => {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'restore-alias-')); t.after(()=>fs.rm(dir,{recursive:true,force:true})); const physical=path.join(dir,'physical'), alias=path.join(dir,'alias'); await fs.mkdir(physical); await fs.symlink(physical,alias,'junction');
 const transport=async url=> { const p=new URL(url).pathname; if(p==='/account/info') return Response.json({status:'OK'}); if(p==='/files/1') return Response.json({status:'OK',file:{id:1,parent_id:0,name:'file',size:4,file_type:'FILE'}}); throw Error('unexpected'); };
 const options={stateDirectory:path.join(dir,'state'),credentials,roots:[{id:'root',label:'Root',path:alias}],token:'fixture',apiBase:'http://fixture.test/',transport};
 let e=await createEngine(options); await e.execute('selectDownloadRoot',['root']); await e.execute('pause'); await e.execute('downloadFile',['1']); await e.close();
 const filename=path.join(dir,'state','engine.json'); const state=JSON.parse(await fs.readFile(filename,'utf8')); const desc=state.descriptions[state.jobs[0].id]; desc.root=alias; desc.dir=alias; await fs.writeFile(filename,JSON.stringify(state));
 e=await createEngine(options); t.after(()=>e.close()); assert.equal((await e.getSnapshot()).jobs[0].status,'queued');
});
test('local root accepts Windows short and mixed-case trusted paths', {skip:process.platform!=='win32'}, async t => {
 const {execFileSync}=require('node:child_process'); const dir=await fs.mkdtemp(path.join(os.tmpdir(),'root path with long name ')); t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const root=path.join(dir,'download folder with long name'); await fs.mkdir(root);
 const short=execFileSync('cmd.exe',['/d','/c',`for %I in ("${root}") do @echo %~sI`],{encoding:'utf8',windowsVerbatimArguments:true}).trim().replace(/^"|"$/g,''); assert.ok(path.isAbsolute(short));
 const e=await createEngine({stateDirectory:path.join(dir,'state'),credentials}); t.after(()=>e.close()); e.allowDirectory(short); const snap=await e.execute('saveSettings',[{downloadDirectory:short.toUpperCase()}]);
 assert.equal((await fs.realpath(snap.settings.downloadDirectory)).toLowerCase(),(await fs.realpath(root)).toLowerCase());
});
async function folderCleanupFixture(t, options = {}) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'folder-cleanup-')); const root=path.join(dir,'root'); await fs.mkdir(root);
  const entries=new Map([
    ['10',{id:10,parent_id:0,name:'watch',size:0,file_type:'FOLDER'}],
    ['20',{id:20,parent_id:10,name:'movie',size:0,file_type:'FOLDER'}],
    ['21',{id:21,parent_id:20,name:'feature.mkv',size:400,file_type:'FILE'}],
    ['22',{id:22,parent_id:20,name:'notes.txt',size:1,file_type:'FILE'}],
  ]);
  if(options.nested) { entries.set('19',{id:19,parent_id:10,name:'outer',size:0,file_type:'FOLDER'}); entries.get('20').parent_id=19; }
  if(options.delayScan) entries.set('30',{id:30,parent_id:10,name:'other',size:0,file_type:'FOLDER'});
  if(options.second) entries.set('23',{id:23,parent_id:20,name:'second.mkv',size:400,file_type:'FILE'});
  const deleted=[]; let afterDelete=false, releaseSecond, secondStarted, releaseScan, scanStarted, releaseCleanup, cleanupStarted; const cleanupReady=new Promise(r=>cleanupStarted=r); const secondReady=new Promise(r=>secondStarted=r); const scanReady=new Promise(r=>scanStarted=r);
  const transport=async (input, init={})=>{
    const url=new URL(input), p=url.pathname;
    if(p==='/account/info') return Response.json({status:'OK'});
    if(p==='/files/list') { const parent=url.searchParams.get('parent_id'); if(options.holdCleanup && afterDelete && parent==='20') { options.holdCleanup=false; cleanupStarted(); await new Promise(r=>releaseCleanup=r); } if(options.delayScan && parent==='30') { scanStarted(); await new Promise(r=>releaseScan=r); if(options.failScan) return new Response('',{status:500}); } if(options.failList && afterDelete && parent==='20') return new Response('',{status:500}); return Response.json({status:'OK',files:[...entries.values()].filter(f=>String(f.parent_id)===parent)}); }
    if(p==='/files/delete') { const target=String(init.body.get('file_ids')); if((options.failFile && target==='21') || (options.failFolder && target==='20')) return new Response('',{status:500}); deleted.push(target); entries.delete(target); if(target==='21') afterDelete=true; return Response.json({status:'OK'}); }
    const urlMatch=p.match(/^\/files\/(\d+)\/url$/); if(urlMatch) return Response.json({status:'OK',url:`http://fixture.test/bytes/${urlMatch[1]}`});
    const fileMatch=p.match(/^\/files\/(\d+)$/); if(fileMatch && entries.has(fileMatch[1])) return Response.json({status:'OK',file:entries.get(fileMatch[1])});
    if(p.startsWith('/bytes/')) { if(p.endsWith('/23') && options.holdSecond) { secondStarted(); await new Promise(r=>releaseSecond=r); } if(options.failSecond && p.endsWith('/23')) return new Response('',{status:500}); return new Response('data'); }
    return new Response('',{status:404});
  };
  const engine=await createEngine({stateDirectory:path.join(dir,'state'),credentials,token:'fixture',apiBase:'http://fixture.test/',transport,roots:[{id:'root',label:'Root',path:root}]}); t.after(async()=>{ await engine.close(); await fs.rm(dir,{recursive:true,force:true}); });
  await engine.execute('selectDownloadRoot',['root']); await engine.execute('saveSettings',[{deleteAfterDownload:true,deleteSourceFolders:true,parallelDownloads:2}]);
  const rule={folderId:'10',folderName:'watch',downloadDirectory:root,extensions:['mkv'],minSizeBytes:100,keepFolderStructure:false,...options.rule};
  await engine.execute('addRule',[rule]); return {engine,entries,deleted,secondReady,scanReady,cleanupReady,release:()=>releaseSecond?.(),releaseScan:()=>releaseScan?.(),releaseCleanup:()=>releaseCleanup?.(),root,rule};
}
test('automatic cleanup removes eligible source then its folder including excluded leftovers', async t=>{
 const f=await folderCleanupFixture(t); await f.engine.execute('checkRules'); await until(()=>f.deleted.includes('20'));
 assert.deepEqual(f.deleted,['21','20']); assert.ok(!f.deleted.includes('10')); const job=(await f.engine.getSnapshot()).jobs[0]; assert.equal(job.deleteSourceFolders,true);
});
test('keep override, protected watched roots and remaining eligible failures prevent folder deletion', async t=>{
 for(const mode of ['keep','protected','failed']) await t.test(mode,async t=>{
  const f=await folderCleanupFixture(t, mode==='keep'?{rule:{deleteAfterDownload:false}}:mode==='failed'?{second:true,failSecond:true}:{});
  if(mode==='protected') await f.engine.execute('addRule',[{...f.rule,folderId:'20',folderName:'protected',extensions:['none']}]);
  await f.engine.execute('checkRules'); await until(async()=>{const s=await f.engine.getSnapshot(); return s.jobs.length && s.jobs.every(j=>['completed','failed'].includes(j.status));}); await new Promise(r=>setTimeout(r,100));
  assert.ok(!f.deleted.includes('20')); if(mode==='keep') assert.ok(!f.deleted.includes('21')); if(mode==='failed') assert.ok(f.entries.has('23'));
 });
});
test('folder cleanup waits for pending sibling and reports list and delete failures', async t=>{
 await t.test('pending',async t=>{ const f=await folderCleanupFixture(t,{second:true,holdSecond:true}); await f.engine.execute('checkRules'); await f.secondReady; await until(()=>f.deleted.includes('21')); await new Promise(r=>setTimeout(r,80)); assert.ok(!f.deleted.includes('20')); f.release(); await until(()=>f.deleted.includes('20')); });
 for(const mode of ['failList','failFolder','failFile']) await t.test(mode,async t=>{ const f=await folderCleanupFixture(t,{[mode]:true}); await f.engine.execute('checkRules'); await until(async()=>{const j=(await f.engine.getSnapshot()).jobs[0];return j?.status==='completed' && !!j.error;}); assert.ok(!f.deleted.includes('20')); });
});
test('manual cleanup requires no remaining files and respects explicit keep and watched roots', async t=>{
 for(const mode of ['nonempty','empty','keep','protected']) await t.test(mode,async t=>{
  const f=await folderCleanupFixture(t); if(mode!=='nonempty') f.entries.delete('22');
  if(mode==='protected') await f.engine.execute('addRule',[{...f.rule,folderId:'20',folderName:'protected'}]);
  await f.engine.execute('downloadFile',['21',mode==='keep'?{deleteAfterDownload:false,deleteSourceFolders:true}:{deleteSourceFolders:true}]);
  await until(async()=> (await f.engine.getSnapshot()).jobs[0]?.status==='completed');
  if(mode==='empty') await until(()=>f.deleted.includes('20')); else await new Promise(r=>setTimeout(r,100));
  assert.equal(f.deleted.includes('20'),mode==='empty'); assert.equal(f.deleted.includes('21'),mode!=='keep');
 });
});
test('folder candidates are not replayed after an uncertain cleaning restart', async t=>{
 const f=await folderCleanupFixture(t); await f.engine.execute('pause'); await f.engine.execute('downloadFile',['21',{deleteAfterDownload:true,deleteSourceFolders:true}]);
 const before=await f.engine.getSnapshot(); const stateFile=path.join(path.dirname(f.root),'state','engine.json'); await f.engine.close();
 const saved=JSON.parse(await fs.readFile(stateFile,'utf8')); saved.jobs[0].status='cleaning'; await fs.writeFile(stateFile,JSON.stringify(saved));
 // Restart without a provider token: recovery must report uncertainty and not replay deletion.
 const restarted=await createEngine({stateDirectory:path.join(path.dirname(f.root),'state'),credentials,roots:[{id:'root',label:'Root',path:f.root}]});
 const job=(await restarted.getSnapshot()).jobs.find(j=>j.id===before.jobs[0].id); assert.match(job.error,/unknown/i); assert.deepEqual(f.deleted,[]); await restarted.close();
});

test('folder cleanup waits for originating scan and skips it if scan fails', async t=>{
 for(const failScan of [false,true]) await t.test(failScan?'failed scan':'successful scan',async t=>{
  const f=await folderCleanupFixture(t,{delayScan:true,failScan}); const scan=f.engine.execute('checkRules').catch(()=>{}); await f.scanReady; await until(()=>f.deleted.includes('21')); await new Promise(r=>setTimeout(r,80)); assert.ok(!f.deleted.includes('20')); f.releaseScan(); await scan;
  if(!failScan) await until(()=>f.deleted.includes('20')); else { await new Promise(r=>setTimeout(r,100)); assert.ok(!f.deleted.includes('20')); }
 });
});

test('rule edits or removal during a fresh folder scan prevent deletion', async t=>{
 for(const mode of ['edit','remove']) await t.test(mode,async t=>{
  const f=await folderCleanupFixture(t,{holdCleanup:true}); await f.engine.execute('checkRules'); await f.cleanupReady; const rule=(await f.engine.getSnapshot()).rules[0];
  if(mode==='edit') await f.engine.execute('updateRule',[rule.id,{...f.rule,extensions:['txt']}]); else await f.engine.execute('removeRule',[rule.id]);
  f.releaseCleanup(); await new Promise(r=>setTimeout(r,150)); assert.ok(!f.deleted.includes('20'));
 });
});
test('another completed job explicitly keeping its file or folder prevents cross-rule deletion',async t=>{
 for(const mode of ['file','folder']) await t.test(mode,async t=>{
  const f=await folderCleanupFixture(t); const options=mode==='file'?{deleteAfterDownload:false}:{deleteAfterDownload:true,deleteSourceFolders:false};
  await f.engine.execute('downloadFile',['22',options]); await until(async()=> (await f.engine.getSnapshot()).jobs[0]?.status==='completed');
  await f.engine.execute('checkRules'); await until(()=>f.deleted.includes('21')); await new Promise(r=>setTimeout(r,120)); assert.ok(!f.deleted.includes('20'));
 });
});
test('successful sibling candidates coalesce across nested folder deletions',async t=>{
 const f=await folderCleanupFixture(t,{second:true,nested:true}); await f.engine.execute('checkRules'); await until(()=>f.deleted.includes('19')); await new Promise(r=>setTimeout(r,100));
 assert.equal(f.deleted.filter(id=>id==='20').length,1); assert.equal(f.deleted.filter(id=>id==='19').length,1); assert.ok((await f.engine.getSnapshot()).jobs.every(job=>job.status==='completed' && !job.error));
});
