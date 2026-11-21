const test=require('node:test');
const assert=require('node:assert/strict');
const {terminal,withEngine}=require('./helpers/download-resilience-fixture.cjs');

test('terminal timeout reports only safe last-snapshot scalars',async t=>{
 let tick=0,calls=0;t.mock.method(Date,'now',()=>tick++<2?0:6000);
 const client={async getSnapshot(){calls++;return {jobs:[{status:'waiting',bytesReceived:4,retryAt:'2026-01-01T00:00:01.000Z',attemptCount:2,name:'private-name',destination:'private-path',error:'private-error'}]}}};
 await assert.rejects(terminal(client),error=>{const prefix='timed out waiting for terminal job ';assert.ok(error.message.startsWith(prefix));assert.doesNotMatch(error.message,/private/);const data=JSON.parse(error.message.slice(prefix.length));assert.deepEqual(Object.keys(data).sort(),['bytes','lastGetSnapshotMs','retryAt','retryCount','status'].sort());assert.equal(data.status,'waiting');assert.equal(data.bytes,4);assert.equal(data.retryAt,'2026-01-01T00:00:01.000Z');assert.equal(data.retryCount,2);assert.ok(Number.isFinite(data.lastGetSnapshotMs));return true});
 assert.equal(calls,1);
});

test('fixture backend diagnostics use guarded scalar fields',async t=>{
 const f=await withEngine(t,'local',{file:{size:4},bytes:'data'});const data=f.retryDiagnostics('absent',{});
 assert.deepEqual(Object.keys(data).sort(),['active','pendingRetries','intent','paused','stopping','wakeGeneration','now','nextDeadline'].sort());
 assert.equal(data.active,0);assert.equal(data.pendingRetries,null);assert.equal(data.intent,null);assert.equal(data.now,null);assert.equal(data.nextDeadline,null);
});
