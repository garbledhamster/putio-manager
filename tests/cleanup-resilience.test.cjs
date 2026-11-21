const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { withEngine, terminal } = require('./helpers/download-resilience-fixture.cjs');

// A completed row must not stay completed if its owned publication changes while stopped.
for (const mode of ['local', 'remote']) {
  test(`${mode}: completed owned output is reverified after same-size corruption`, async t => {
    let downloads = 0;
    const f = await withEngine(t, mode, {
      file: { size: 4, sha1: 'a17c9aaa61e80a1bf71d0d850af4e5baa9800bbd' },
      response: () => { downloads++; return new Response('data'); },
    });
    const receipt = await f.client.execute('downloadFile', ['1']);
    const before = await terminal(f.client);
    assert.equal(before.status, 'completed');
    assert.equal(before.verification, 'verified');
    assert.equal(before.id, receipt.jobId);
    const destination = path.join(f.root, 'file.bin');
    await f.restart(() => fs.writeFile(destination, 'evil'));
    const jobs = (await f.client.getSnapshot()).jobs;
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].id, receipt.jobId);
    assert.equal(jobs[0].status, 'needs-attention');
    assert.equal(await fs.readFile(destination, 'utf8'), 'evil');
    assert.equal(downloads, 1);
    assert.deepEqual(f.deleted, []);
  });
}

// A provider may apply a deletion even when its response never reaches the engine.
for (const mode of ['local', 'remote']) {
  test(`${mode}: lost source deletion response remains unknown without replay`, async t => {
    let downloads = 0, effects = 0;
    const f = await withEngine(t, mode, {
      file: { size: 4 },
      response: () => { downloads++; return new Response('data'); },
      onDelete: async () => { effects++; throw new TypeError('fixture connection lost'); },
    });
    const receipt = await f.client.execute('downloadFile', ['1', { deleteAfterDownload: true }]);
    const before = await terminal(f.client);
    assert.equal(before.status, 'completed');
    assert.equal(before.verification, 'verified');
    assert.equal(before.id, receipt.jobId);
    assert.equal(before.cleanupStatus, 'unknown');
    assert.ok(before.cleanupWarning);
    assert.equal(before.error, undefined);
    assert.equal(await fs.readFile(path.join(f.root, 'file.bin'), 'utf8'), 'data');
    assert.deepEqual(f.deleted, ['1']);
    assert.equal(effects, 1);
    await f.restart();
    await f.client.execute('checkRules');
    if (mode === 'remote') { await f.disconnectClient(); await f.reconnectClient(); }
    const jobs = (await f.client.getSnapshot()).jobs;
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].id, receipt.jobId);
    assert.equal(jobs[0].status, 'completed');
    assert.equal(jobs[0].cleanupStatus, 'unknown');
    assert.ok(jobs[0].cleanupWarning);
    assert.equal(await fs.readFile(path.join(f.root, 'file.bin'), 'utf8'), 'data');
    assert.equal(downloads, 1);
    assert.deepEqual(f.deleted, ['1']);
    assert.equal(effects, 1);
  });
}

// Generated checkpoint: use a real completed publication, then replay it as cleaning.
for (const mode of ['local', 'remote']) {
  test(`${mode}: cleaning checkpoint revalidates missing published output`, async t => {
    let downloads = 0;
    const f = await withEngine(t, mode, {
      file: { size: 4 },
      response: () => { downloads++; return new Response('data'); },
    });
    const receipt = await f.client.execute('downloadFile', ['1']);
    assert.equal((await terminal(f.client)).status, 'completed');
    const destination = path.join(f.root, 'file.bin');
    await f.restart(async () => {
      const statePath = path.join(f.dir, 'state', 'engine.json');
      const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
      state.jobs[0].status = 'cleaning';
      await fs.writeFile(statePath, JSON.stringify(state));
      await fs.unlink(destination);
    });
    const jobs = (await f.client.getSnapshot()).jobs;
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].id, receipt.jobId);
    assert.equal(jobs[0].status, 'needs-attention');
    await assert.rejects(fs.lstat(destination), { code: 'ENOENT' });
    assert.equal(downloads, 1);
    assert.deepEqual(f.deleted, []);
  });
}

for (const mode of ['local', 'remote']) {
  test(`${mode}: definite source refusal preserves verified result and warns separately`, async t => {
    let downloads = 0, effects = 0;
    const f = await withEngine(t, mode, { file: { size: 4 }, response: () => { downloads++; return new Response('data'); }, onDelete: () => new Response('', {status: 403}) });
    const receipt = await f.client.execute('downloadFile', ['1', {deleteAfterDownload: true}]);
    const job = await terminal(f.client);
    assert.equal(job.id, receipt.jobId);
    assert.equal(job.status, 'completed');
    assert.equal(job.verification, 'verified');
    assert.equal(job.cleanupStatus, 'failed');
    assert.ok(job.cleanupWarning);
    assert.equal(job.error, undefined);
    assert.equal(await fs.readFile(path.join(f.root, 'file.bin'), 'utf8'), 'data');
    assert.equal(downloads, 1);
    assert.deepEqual(f.deleted, ['1']);
    assert.equal(effects, 0);
  });
}

for (const mode of ['local', 'remote']) for (const action of ['pause', 'cancelDownloads']) {
  test(`${mode}: ${action} while cleanup marker save waits prevents deletion`, async t => {
    let blocked = false, release;
    const gate = new Promise(resolve => release = resolve);
    const f = await withEngine(t, mode, {file: {size: 4}});
    const rename = fs.rename;
    fs.rename = async (from, to) => {
      if (!blocked && String(to).endsWith('engine.json')) {
        const state = JSON.parse(await fs.readFile(from, 'utf8'));
        if (Object.values(state.recovery || {}).some(r => r.cleanup?.phase === 'in-flight')) { blocked = true; await gate; }
      }
      return rename(from, to);
    };
    t.after(() => { fs.rename = rename; release(); });
    const receipt = await f.client.execute('downloadFile', ['1', {deleteAfterDownload: true}]);
    const end = Date.now() + 3000;
    while (!blocked && Date.now() < end && f.deleted.length === 0) await new Promise(r => setTimeout(r, 10));
    assert.equal(f.deleted.length, 0, 'source deletion must await durable marker');
    assert.equal(blocked, true, 'marker save must be attempted');
    const stop = f.client.execute(action, action === 'cancelDownloads' ? [[receipt.jobId]] : []);
    const expectedIntent = action === 'pause' ? 'paused' : 'canceled';
    const intentDeadline = Date.now() + 3000;
    while (f.recoveryIntent(receipt.jobId) !== expectedIntent && Date.now() < intentDeadline) await new Promise(r => setTimeout(r, 10));
    assert.equal(f.recoveryIntent(receipt.jobId), expectedIntent, 'stop intent must reach the engine before marker release');
    assert.deepEqual(f.deleted, []);
    release(); await stop;
    assert.deepEqual(f.deleted, []);
    assert.equal(await fs.readFile(path.join(f.root, 'file.bin'), 'utf8'), 'data');
  });
}

for (const mode of ['local', 'remote']) for (const evidence of ['size', 'sha1', 'crc32']) {
  test(`${mode}: published output requires saved source ${evidence} consistency`, async t => {
    let downloads = 0;
    const f = await withEngine(t, mode, {file: {size: 4}, response: () => {downloads++; return new Response('data');}});
    const receipt = await f.client.execute('downloadFile', ['1']);
    assert.equal((await terminal(f.client)).status, 'completed');
    await f.restart(async () => {
      const statePath = path.join(f.dir, 'state', 'engine.json');
      const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
      const source = state.recovery[receipt.jobId].source;
      if (evidence === 'size') source.expectedBytes = 5;
      if (evidence === 'sha1') source.sha1 = '0000000000000000000000000000000000000000';
      if (evidence === 'crc32') source.crc32 = '00000000';
      await fs.writeFile(statePath, JSON.stringify(state));
    });
    const job = (await f.client.getSnapshot()).jobs[0];
    assert.equal(job.id, receipt.jobId);
    assert.equal(job.status, 'needs-attention');
    assert.equal(await fs.readFile(path.join(f.root, 'file.bin'), 'utf8'), 'data');
    assert.equal(downloads, 1);
    assert.deepEqual(f.deleted, []);
  });
}

for (const mode of ['local', 'remote']) {
  test(`${mode}: replacement during publication revalidation is not adopted`, async t => {
    const f = await withEngine(t, mode, {file: {size: 4}});
    const receipt = await f.client.execute('downloadFile', ['1']);
    assert.equal((await terminal(f.client)).status, 'completed');
    const destination = path.join(f.root, 'file.bin');
    const lstat = fs.lstat;
    let armed = false, replaced = false;
    fs.lstat = async (...args) => {
      const stat = await lstat(...args);
      if (armed && !replaced && String(args[0]).toLowerCase() === destination.toLowerCase()) {
        replaced = true;
        await fs.rename(destination, destination + '.original');
        await fs.writeFile(destination, 'data');
      }
      return stat;
    };
    t.after(() => {fs.lstat = lstat;});
    await f.restart(() => {armed = true;});
    const job = (await f.client.getSnapshot()).jobs[0];
    assert.equal(replaced, true);
    assert.equal(job.id, receipt.jobId);
    assert.equal(job.status, 'needs-attention');
    assert.equal(await fs.readFile(destination, 'utf8'), 'data');
    assert.deepEqual(f.deleted, []);
  });
}


for (const mode of ['local','remote']) for (const step of ['file','folder']) for (const phase of ['inflight','outcome']) {
 test(`${mode}: ${step} deletion crash at ${phase} never replays`, async t => {
  const os=require('node:os'), {fork}=require('node:child_process'); const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cleanup-crash-')); await fs.mkdir(path.join(dir,'root')); await fs.writeFile(path.join(dir,'provider.json'),JSON.stringify({requests:[],deleted:[],downloads:0})); t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const child=fork(path.join(__dirname,'helpers','cleanup-child.cjs'),[dir,mode,step,phase],{stdio:['ignore','ignore','ignore','ipc']});
  await new Promise((resolve,reject)=>{child.on('message',m=>m==='boundary'?resolve():reject(Error(JSON.stringify(m))));child.on('exit',c=>reject(Error('child exited '+c)));});
  child.kill(); await new Promise(r=>child.once('exit',r));
  const before=JSON.parse(await fs.readFile(path.join(dir,'provider.json'),'utf8')); assert.deepEqual(before.requests,step==='file'?['1']:['1','20']); assert.deepEqual(before.deleted,before.requests); assert.equal(before.downloads,1);
  const {start}=require('./helpers/cleanup-child.cjs'); const runtime=require('./helpers/download-resilience-fixture.cjs').controlledRuntime(); const x=await start(dir,mode,undefined,runtime); t.after(async()=>{if(x.server){await x.client.close();await x.server.close();}await x.engine.close();});
  runtime.advance(600000); await x.client.execute('checkRules'); await x.client.execute('pause'); await x.client.execute('resume'); if(mode==='remote') await x.reconnect();
  const jobs=(await x.client.getSnapshot()).jobs; assert.equal(jobs.length,1); assert.equal(jobs[0].status,'completed'); assert.equal(jobs[0].verification,'verified'); assert.equal(jobs[0].cleanupStatus,'unknown'); assert.ok(jobs[0].cleanupWarning); assert.equal(await fs.readFile(path.join(dir,'root','file.bin'),'utf8'),'data');
  const after=JSON.parse(await fs.readFile(path.join(dir,'provider.json'),'utf8')); assert.deepEqual(after,before);
 });
}

for (const mode of ['local','remote']) for (const phase of ['in-flight','succeeded']) test(`${mode}: cleanup ${phase} save obstruction preserves local output`, async t=>{
 let failed=false,effects=0; const f=await withEngine(t,mode,{file:{size:4},onDelete:()=>{effects++;}}); const rename=fs.rename;
 fs.rename=async(from,to)=>{if(!failed&&String(to).endsWith('engine.json')){const state=JSON.parse(await fs.readFile(from,'utf8'));if(Object.values(state.recovery||{}).some(r=>r.cleanup?.phase===phase)){failed=true;throw Object.assign(new Error('fixture save failure'),{code:'EIO'});}}return rename(from,to);};
 t.after(()=>{fs.rename=rename;});const receipt=await f.client.execute('downloadFile',['1',{deleteAfterDownload:true}]);const job=await terminal(f.client);assert.equal(failed,true);assert.equal(job.id,receipt.jobId);assert.equal(job.status,'completed');assert.equal(job.verification,'verified');assert.equal(job.cleanupStatus,phase==='in-flight'?'not-started':'unknown');assert.ok(job.cleanupWarning);assert.equal(job.error,undefined);assert.equal(await fs.readFile(path.join(f.root,'file.bin'),'utf8'),'data');assert.equal(effects,phase==='in-flight'?0:1);assert.equal(f.deleted.length,effects);fs.rename=rename;await f.restart();const after=(await f.client.getSnapshot()).jobs[0];assert.equal(after.id,receipt.jobId);assert.equal(after.status,'completed');assert.equal(after.cleanupStatus,phase==='in-flight'?'not-started':'unknown');assert.equal(effects,phase==='in-flight'?0:1);
});

for(const mode of ['local','remote']) test(`${mode}: restored rows never trust saved cleanupPending`, async t=>{
 const f=await withEngine(t,mode,{file:{size:4},onDelete:()=>{throw new TypeError('fixture response lost')}});const receipt=await f.client.execute('downloadFile',['1',{deleteAfterDownload:true}]);assert.equal((await terminal(f.client)).cleanupStatus,'unknown');
 await f.restart(async()=>{const file=path.join(f.dir,'state','engine.json'),state=JSON.parse(await fs.readFile(file,'utf8'));state.jobs[0].cleanupPending=true;await fs.writeFile(file,JSON.stringify(state));});
 const job=(await f.client.getSnapshot()).jobs[0];assert.equal(job.id,receipt.jobId);assert.equal(job.status,'completed');assert.equal(job.cleanupStatus,'unknown');assert.notEqual(job.cleanupPending,true);const state=JSON.parse(await fs.readFile(path.join(f.dir,'state','engine.json'),'utf8'));assert.equal(state.jobs[0].cleanupPending,undefined);assert.deepEqual(f.deleted,['1']);
});
