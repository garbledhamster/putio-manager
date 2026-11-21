const {test}=require('node:test'); const assert=require('node:assert/strict');
const {integrationStatus,setStartup,setMagnet,validMagnet,submitMagnet,MagnetQueue}=require('../dist/desktop/platform');
test('startup and registration require operating-system confirmation',()=>{
 let startup=false,magnet=false; const adapter={startupSupported:true,magnetSupported:true,getStartup:()=>startup,setStartup:v=>startup=v,getMagnet:()=>magnet,setMagnet:v=>(magnet=v,true)};
 setStartup(adapter,true); assert.equal(integrationStatus(adapter).startupEnabled,true); assert.equal(setMagnet(adapter,true).magnetRegistered,true);
 adapter.setStartup=()=>{}; assert.throws(()=>setStartup(adapter,false),/did not confirm/); adapter.setMagnet=()=>false; assert.throws(()=>setMagnet(adapter,false),/did not confirm/);
 adapter.startupSupported=false; assert.throws(()=>setStartup(adapter,true),/not supported/);
});
test('magnet validation and engine failure do not expose the link',async()=>{
 const link='magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=private';
 assert.equal(validMagnet(link),true); for(const bad of ['https://example.com','magnet:?xt=bad','magnet:?xt=urn:btih:bad','magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567\n']) assert.equal(validMagnet(bad),false);
 let seen; await submitMagnet(link,async value=>{seen=value}); assert.equal(seen,link);
 await assert.rejects(()=>submitMagnet('magnet:?private',async()=>{}),error=>!error.message.includes('private'));
 await assert.rejects(()=>submitMagnet(link,async()=>{throw new Error('failure')}),/failure/);
});

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; }
// A turn lets the queue finish its bookkeeping after a handler resolves.
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test('cold launch and later instance events queue in order until engine is ready',{timeout:5000},async()=>{
 const seen=[]; const handled=deferred();
 const queue=new MagnetQueue(async link=>{seen.push(link); if(seen.length===3) handled.resolve(); return true;});
 queue.receive(['exe','magnet:?cold']); assert.deepEqual(seen,[]); queue.start(); queue.receive(['exe','magnet:?second']); queue.receive(['magnet:?open-url']);
 await handled.promise; assert.deepEqual(seen,['magnet:?cold','magnet:?second','magnet:?open-url']);
});

test('duplicate launch events submit once, while failed submissions can be retried',{timeout:5000},async()=>{
 const seen=[]; const releaseFirst=deferred(), firstStarted=deferred(), failedOnce=deferred(), failedTwice=deferred();
 const queue=new MagnetQueue(async link=>{
  seen.push(link);
  if(link==='magnet:?same'){ firstStarted.resolve(); await releaseFirst.promise; return true; }
  if(seen.length===2) failedOnce.resolve(); else if(seen.length===3) failedTwice.resolve();
  return false;
 });
 queue.receive(['magnet:?same']); queue.receive(['magnet:?same']); queue.start(); await firstStarted.promise;
 queue.receive(['magnet:?same']); releaseFirst.resolve(); await nextTurn();
 queue.receive(['magnet:?same']); assert.deepEqual(seen,['magnet:?same']);
 queue.receive(['magnet:?failed']); await failedOnce.promise; await nextTurn();
 queue.receive(['magnet:?failed']); await failedTwice.promise; await nextTurn();
 assert.deepEqual(seen,['magnet:?same','magnet:?failed','magnet:?failed']);
});
