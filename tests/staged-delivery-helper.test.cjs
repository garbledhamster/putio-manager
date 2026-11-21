const {privateTemp}=require('./helpers/private-staging-fixture.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { copyArtifact, hashArtifact, removeArtifact, createArtifactAnchor } = require('../dist/core/staged-delivery');
const name = () => `.putio-${randomUUID()}.download`;
async function fixture(t) {
  const root = await privateTemp(path.join(os.tmpdir(), 'stage-helper-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stage = path.join(root, 'stage'), destination = path.join(root, 'destination');
  await fs.mkdir(stage,{mode:0o700}); await fs.mkdir(destination,{mode:0o700});
  const source = {root: stage, name: name()};
  const bytes = Buffer.alloc(200000, 0x5a); await fs.writeFile(path.join(stage,source.name),bytes);
  const handle=await fs.open(path.join(stage,source.name),'r+');
  try { source.owned=await createArtifactAnchor(stage,source.name,handle); } finally { await handle.close(); }
  return { source, target: {root: destination, name:name()}, bytes, digest:createHash('sha256').update(bytes).digest('hex') };
}
test('staged copy persists identity before writing and verifies an independent destination hash', async t => {
  const {source,target,bytes,digest}=await fixture(t); let saved, progress=0;
  const result=await copyArtifact(source,target,{length:bytes.length,sha256:digest},new AbortController().signal,async id=>{saved=id;assert.equal((await fs.stat(path.join(target.root,target.name))).size,0)},n=>{progress=n});
  assert.deepEqual(result,saved); assert.equal(progress,bytes.length);
  assert.deepEqual(await hashArtifact({...target,owned:result},new AbortController().signal),{length:bytes.length,sha256:digest});
  await removeArtifact({...target,owned:result}); await assert.rejects(fs.lstat(path.join(target.root,target.name)),{code:'ENOENT'});
  assert.deepEqual(await fs.readFile(path.join(source.root,source.name)),bytes);
});
test('staged copy refuses an existing destination and changed stage bytes', async t => {
  const {source,target,bytes,digest}=await fixture(t); const dest=path.join(target.root,target.name);
  await fs.writeFile(dest,'unowned');
  await assert.rejects(copyArtifact(source,target,{length:bytes.length,sha256:digest},new AbortController().signal,async()=>{},()=>{}),{code:'EEXIST'});
  assert.equal(await fs.readFile(dest,'utf8'),'unowned'); await fs.unlink(dest);
  await fs.writeFile(path.join(source.root,source.name),Buffer.alloc(bytes.length,0x41)); let saved;
  await assert.rejects(copyArtifact(source,target,{length:bytes.length,sha256:digest},new AbortController().signal,async id=>{saved=id},()=>{}),/changed/);
  assert.ok(saved); await removeArtifact({...target,owned:saved});
});
test('owned removal refuses a substituted file', async t => {
  const {source}=await fixture(t); const file=path.join(source.root,source.name);
  await fs.unlink(file); await fs.writeFile(file,'replacement');
  await assert.rejects(removeArtifact(source),/Unsafe/); assert.equal(await fs.readFile(file,'utf8'),'replacement');
});
test('weak or missing anchors never authorize removal or retained accounting', async t => {
  const {retainedStageBytes}=require('../dist/core/staged-delivery'); const {source}=await fixture(t);
  const file=path.join(source.root,source.name),anchor=path.join(source.root,source.owned.anchor.name);
  const weak={...source,owned:{dev:source.owned.dev,ino:source.owned.ino}};
  await assert.rejects(removeArtifact(weak),/ownership/);
  await assert.rejects(retainedStageBytes(source.root,[weak]),/ownership/);
  await fs.unlink(anchor);
  await assert.rejects(removeArtifact(source),/ownership/);
  await assert.rejects(retainedStageBytes(source.root,[source]),/ownership/);
  assert.ok((await fs.stat(file)).isFile());
});
test('anchor-only retained bytes remain charged until release', async t => {
  const {retainedStageBytes,releaseArtifactAnchor}=require('../dist/core/staged-delivery'); const {source,bytes}=await fixture(t);
  await fs.unlink(path.join(source.root,source.name));
  await assert.rejects(retainedStageBytes(source.root,[source]),/missing/);
  assert.equal(await retainedStageBytes(source.root,[{...source,allowMissingMain:true}]),bytes.length);
  await releaseArtifactAnchor(source); await releaseArtifactAnchor(source);
  await assert.rejects(fs.lstat(path.join(source.root,source.owned.anchor.name)),{code:'ENOENT'});
});
test('directory close rejection retains the real handle until proven settlement', async t => {
  const {syncAnchorDirectory,ArtifactCloseUncertain}=require('../dist/core/staged-delivery'); const {source}=await fixture(t);
  let retained,release; const gate=new Promise(r=>release=r);
  const adapter=(handle,role)=>{assert.equal(role,'anchor-directory');const settlement=gate.then(()=>handle.close());return {attempt:Promise.reject(Error('synthetic close failure')),settlement}};
  await assert.rejects(syncAnchorDirectory(source.root,(_role,handle,settlement)=>{retained={handle,settlement}},adapter),error=>error instanceof ArtifactCloseUncertain && error.handle===retained.handle && error.settlement===retained.settlement);
  assert.ok((await retained.handle.stat()).isDirectory()); release(); await retained.settlement;
});
test('anchor release persists intent first and resumes without touching main paths', async t => {
  const {releaseStagedAnchors}=require('../dist/core/downloads'); const {source,target,bytes,digest}=await fixture(t); let destinationOwner;
  await copyArtifact(source,target,{length:bytes.length,sha256:digest},new AbortController().signal,async id=>{destinationOwner=id},()=>{});
  const job={destination:path.join(target.root,'final.bin')}, record={partial:target.name,owned:destinationOwner,delivery:{root:path.dirname(source.root),namespace:path.basename(source.root),name:source.name,owned:source.owned}};
  const main=path.join(source.root,source.name),partial=path.join(target.root,target.name); await fs.unlink(main); await fs.unlink(partial); await fs.writeFile(job.destination,'final sentinel');
  const original=fs.unlink;let interrupted=false;const snapshots=[];
  fs.unlink=async p=>{if(String(p)===path.join(target.root,destinationOwner.anchor.name)&&!interrupted){interrupted=true;throw Object.assign(Error('synthetic interruption'),{code:'EIO'})}return original(p)};
  try { await assert.rejects(releaseStagedAnchors(job,record,async()=>{snapshots.push(structuredClone(record.delivery))}),{code:'EIO'}); } finally { fs.unlink=original; }
  assert.equal(snapshots[0].stageAnchorRelease,'pending'); assert.ok(snapshots.some(snapshot=>snapshot.stageAnchorRelease==='released'&&snapshot.destinationAnchorRelease==='pending'));
  assert.equal(record.delivery.stageAnchorRelease,'released'); assert.equal(record.delivery.destinationAnchorRelease,'pending');
  await fs.writeFile(main,'replacement'); await fs.writeFile(partial,'replacement');
  await releaseStagedAnchors(job,record,async()=>{snapshots.push(structuredClone(record.delivery))});
  assert.equal(record.delivery.destinationAnchorRelease,'released'); assert.equal(await fs.readFile(main,'utf8'),'replacement'); assert.equal(await fs.readFile(partial,'utf8'),'replacement'); assert.equal(await fs.readFile(job.destination,'utf8'),'final sentinel');
  await assert.rejects(fs.lstat(path.join(source.root,source.owned.anchor.name)),{code:'ENOENT'}); await assert.rejects(fs.lstat(path.join(target.root,destinationOwner.anchor.name)),{code:'ENOENT'});
});

test('aborted destination copy settles and leaves the owned stage and partial for recovery', async t => {
  const {source,target,bytes,digest}=await fixture(t); const controller=new AbortController(); let saved;
  await assert.rejects(copyArtifact(source,target,{length:bytes.length,sha256:digest},controller.signal,async id=>{saved=id},n=>{if(n>=65536) controller.abort()}),{name:'AbortError'});
  assert.ok(saved); assert.equal((await fs.stat(path.join(target.root,target.name))).size,65536);
  assert.deepEqual(await fs.readFile(path.join(source.root,source.name)),bytes);
  await removeArtifact({...target,owned:saved});
});

test('parallel reservations account for outstanding promises and retained bytes', async t => {
  const { StageReservations } = require('../dist/core/staged-delivery');
  const {source}=await fixture(t); const ledger=new StageReservations(); let retained=2;
  const attempts=await Promise.allSettled(['first','second'].map(id=>ledger.reserve(id,source.root,5,async()=>retained,10,0)));
  assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);
  const id=attempts[0].status==='fulfilled'?'first':'second';
  retained=7; await ledger.consume(id,5);
  await assert.rejects(ledger.reserve('third',source.root,4,async()=>retained,10,0),/capacity/);
  await ledger.release(id); await ledger.reserve('third',source.root,3,async()=>retained,10,0); await ledger.release('third');
});

test('copy handles short reads and writes with one awaited operation at a time', async t => {
  const {source,target,bytes,digest}=await fixture(t); const original=fs.open; let active=0, maxActive=0, largestRead=0;
  fs.open=async (...args)=>{const h=await original(...args); const read=h.read.bind(h),write=h.write.bind(h);
    h.read=async (buffer,offset,length,position)=>{active++;maxActive=Math.max(maxActive,active);largestRead=Math.max(largestRead,length);try{return await read(buffer,offset,Math.min(length,8192),position)}finally{active--}};
    h.write=async (buffer,offset,length,position)=>{active++;maxActive=Math.max(maxActive,active);try{return await write(buffer,offset,Math.min(length,2048),position)}finally{active--}};return h;};
  try { let owner; await copyArtifact(source,target,{length:bytes.length,sha256:digest},new AbortController().signal,async id=>{owner=id},()=>{}); assert.ok(owner); assert.equal(maxActive,1); assert.ok(largestRead<=65536); assert.deepEqual(await fs.readFile(path.join(target.root,target.name)),bytes); }
  finally { fs.open=original; }
});

test('retained-byte accounting refuses unknown or replaced artifacts',async t=>{
  const {retainedStageBytes}=require('../dist/core/staged-delivery');const {source,bytes}=await fixture(t);
  assert.equal(await retainedStageBytes(source.root,[source]),bytes.length);
  await assert.rejects(retainedStageBytes(source.root,[{...source,owned:undefined}]),/Unsafe/);
  const file=path.join(source.root,source.name);await fs.unlink(file);await fs.writeFile(file,'replacement');
  await assert.rejects(retainedStageBytes(source.root,[source]),/Unsafe/);
});

test('destination reservations share available space with stage reservations on the same device',async t=>{
 const {StageReservations}=require('../dist/core/staged-delivery');const {source,target}=await fixture(t);const original=fs.statfs;fs.statfs=async()=>({bavail:100n,bsize:1n});
 try{const ledger=new StageReservations();await ledger.reserve('stage',source.root,60,async()=>0,100,10);await assert.rejects(ledger.reserveDestination('copy',target.root,31,10),/capacity/);await ledger.reserveDestination('copy',target.root,30,10);await ledger.release('stage');await ledger.release('copy');}
 finally{fs.statfs=original;}
});

test('copy never writes beyond the verified stage length when the stage grows',async t=>{
 const {source,target,bytes,digest}=await fixture(t);let owner;const expected={length:bytes.length,sha256:digest};
 await assert.rejects(copyArtifact(source,target,expected,new AbortController().signal,async id=>{owner=id;await fs.appendFile(path.join(source.root,source.name),Buffer.alloc(1024*1024))},()=>{}),/changed/);
 assert.equal((await fs.stat(path.join(target.root,target.name))).size,bytes.length);await removeArtifact({...target,owned:owner});
});
test('copy reports the artifact role when a close fails',async t=>{
 const {ArtifactCloseUncertain}=require('../dist/core/staged-delivery');const {source,target,bytes,digest}=await fixture(t);const original=fs.open;let originalClose,owner;
 fs.open=async(...args)=>{const h=await original(...args);if(args[1]==='wx'){originalClose=h.close.bind(h);h.close=async()=>{throw Object.assign(Error('synthetic close failure'),{code:'EIO'})}}return h;};
 try{await assert.rejects(copyArtifact(source,target,{length:bytes.length,sha256:digest},new AbortController().signal,async id=>{owner=id},()=>{}),error=>error instanceof ArtifactCloseUncertain&&error.role==='destination');assert.ok(owner);}
 finally{fs.open=original;if(originalClose)await originalClose();}
 await removeArtifact({...target,owned:owner});
});
