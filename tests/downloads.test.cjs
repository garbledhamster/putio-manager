const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { DownloadQueue } = require("../dist/core/downloads");
test("queue finalizes without overwriting and never cleans up a collision", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "putio-test-"));
  try {
    let cleanup = 0;
    const q = new DownloadQueue(
      () => 1,
      () => {},
      async () => new Response("payload"),
    );
    const file = { id: "1", name: "one.txt", size: 7 };
    await q.enqueue(
      file,
      dir,
      async () => "http://fixture",
      async () => cleanup++,
    );
    while (q.jobs[0].status === "queued" || q.jobs[0].status === "downloading" ||
      q.jobs[0].status === "finalizing")
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(
      await fs.readFile(path.join(dir, "one.txt"), "utf8"),
      "payload",
    );
    assert.equal(cleanup, 1);
    await q.enqueue(
      { ...file, id: "2" },
      dir,
      async () => "http://fixture",
      async () => cleanup++,
    );
    while (q.jobs[1].status === "queued" || q.jobs[1].status === "downloading" ||
      q.jobs[1].status === "finalizing")
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(q.jobs[1].status, "skipped");
    assert.equal(cleanup, 1);
    await assert.rejects(
      q.enqueue({ ...file, name: "../bad" }, dir, async () => ""),
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("parallel jobs can create the same new directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "putio-race-"));
  try {
    const dir = path.join(root, "new", "shared");
    const queue = new DownloadQueue(
      () => 10,
      () => {},
      async () => new Response("data"),
    );
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        queue.enqueue(
          { id: String(i), name: `file-${i}.txt`, size: 4 },
          dir,
          async () => "http://fixture",
          undefined,
          root,
        ),
      ),
    );
    while (
      queue.jobs.some((job) => ["queued", "downloading", "finalizing"].includes(job.status))
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(
      queue.jobs.filter((job) => job.status === "completed").length,
      10,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("finalizing is an explicit cancellation boundary", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "putio-finalize-"));
  try {
    let cleaned = 0;
    let observed = false;
    let queue;
    queue = new DownloadQueue(
      () => 1,
      () => {
        const job = queue?.jobs[0];
        if (job?.status === "finalizing") {
          observed = true;
          queue.cancel([job.id]);
        }
      },
      async () => new Response("data"),
    );
    await queue.enqueue(
      { id: "1", name: "done.txt", size: 4 },
      dir,
      async () => "http://fixture",
      async () => cleaned++,
    );
    while (!["completed", "failed", "canceled"].includes(queue.jobs[0].status))
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(observed, true);
    assert.equal(queue.jobs[0].status, "completed");
    assert.equal(cleaned, 1);
    let canceledCleanup = 0;
    let q2;
    q2 = new DownloadQueue(
      () => 1,
      () => {
        if (q2?.jobs[0]?.bytesReceived) q2.cancel();
      },
      async () => new Response("data"),
    );
    await q2.enqueue(
      { id: "2", name: "cancel.txt", size: 4 },
      dir,
      async () => "http://fixture",
      async () => canceledCleanup++,
    );
    while (!["completed", "failed", "canceled"].includes(q2.jobs[0].status))
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(q2.jobs[0].status, "canceled");
    assert.equal(canceledCleanup, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("existing files skip network across repeated queues", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "putio-existing-"));
  let calls = 0;
  try {
    await fs.writeFile(path.join(dir, "existing.txt"), "old");
    for (let attempt = 0; attempt < 2; attempt++) {
      const queue = new DownloadQueue(
        () => 1,
        () => {},
        async () => {
          calls++;
          return new Response("new");
        },
      );
      const file = { id: "1", name: "existing.txt", size: 3 };
      await queue.enqueue(
        file,
        dir,
        async () => {
          calls++;
          return "http://fixture";
        },
        async () => {
          calls++;
        },
      );
      while (
        !["completed", "failed", "canceled", "skipped"].includes(
          queue.jobs[0].status,
        )
      )
        await new Promise((r) => setTimeout(r, 10));
      assert.equal(queue.jobs[0].status, "skipped");
      await queue.enqueue(file, dir, async () => {
        calls++;
        return "http://fixture";
      });
      assert.equal(queue.jobs.length, 1);
    }
    assert.equal(calls, 0);
    assert.equal(
      await fs.readFile(path.join(dir, "existing.txt"), "utf8"),
      "old",
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("trusted root alias is allowed but descendant links are rejected", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "putio-alias-"));
  const root = path.join(base, "root");
  const alias = path.join(base, "alias");
  const outside = path.join(base, "outside");
  try {
    await fs.mkdir(root);
    await fs.mkdir(outside);
    try {
      await fs.symlink(
        root,
        alias,
        process.platform === "win32" ? "junction" : "dir",
      );
      await fs.symlink(
        outside,
        path.join(root, "nested"),
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (e) {
      if (e.code === "EPERM" || e.code === "EACCES") {
        t.skip("Symlink creation unavailable");
        return;
      }
      throw e;
    }
    const queue = new DownloadQueue(
      () => 2,
      () => {},
      async () => new Response("data"),
    );
    await queue.enqueue(
      { id: "1", name: "ok.txt", size: 4 },
      alias,
      async () => "http://fixture",
    );
    await queue.enqueue(
      { id: "2", name: "bad.txt", size: 4 },
      path.join(alias, "nested"),
      async () => "http://fixture",
      undefined,
      alias,
    );
    while (
      queue.jobs.some(
        (j) =>
          !["completed", "failed", "canceled", "skipped"].includes(j.status),
      )
    )
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(queue.jobs[0].status, "completed");
    assert.equal(queue.jobs[1].status, "failed");
    await assert.rejects(fs.access(path.join(outside, "bad.txt")));
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});
test('aggregate and per-job rates pace concurrent streams and abort promptly', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'rate-test-')); t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const q = new DownloadQueue(()=>2,()=>{},async()=>new Response(Buffer.alloc(100)),async()=>{},()=>200);
  const started=Date.now();
  await q.enqueue({id:'1',name:'a',size:100},dir,async()=> 'http://fixture',undefined,dir,undefined,{speedLimitBytesPerSecond:100});
  await q.enqueue({id:'2',name:'b',size:100},dir,async()=> 'http://fixture',undefined,dir,undefined,{speedLimitBytesPerSecond:0});
  while(q.jobs.some(j=>!['completed','failed'].includes(j.status))) await new Promise(r=>setTimeout(r,20));
  assert.ok(Date.now()-started >= 850); assert.ok(q.jobs.every(j=>j.status==='completed'));
  const slow = new DownloadQueue(()=>1,()=>{},async()=>new Response(Buffer.alloc(100)),async()=>{},()=>1);
  await slow.enqueue({id:'3',name:'c',size:100},dir,async()=> 'http://fixture');
  await new Promise(r=>setTimeout(r,50)); const cancelAt=Date.now(); slow.cancel();
  while(slow.jobs[0].status==='downloading') await new Promise(r=>setTimeout(r,10));
  assert.equal(slow.jobs[0].status,'canceled'); assert.ok(Date.now()-cancelAt<500);
});
test('queued download rejects a trusted root replaced by a junction', async t => {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'queue-root-')); t.after(()=>fs.rm(dir,{recursive:true,force:true})); const root=path.join(dir,'root'), outside=path.join(dir,'outside'); await fs.mkdir(root); await fs.mkdir(outside);
 let requested=0; const q=new DownloadQueue(()=>1,()=>{},async()=>{requested++;return new Response('data')}); q.paused=true;
 await q.enqueue({id:'1',name:'file.txt',size:4},root,async()=> 'http://fixture'); await fs.rename(root,path.join(dir,'original')); await fs.symlink(outside,root,'junction');
 q.paused=false; q.pump(); while(['queued','downloading'].includes(q.jobs[0].status)) await new Promise(r=>setTimeout(r,10));
 assert.equal(q.jobs[0].status,'failed'); assert.equal(requested,0); assert.deepEqual(await fs.readdir(outside),[]);
});
test('root replaced while download source waits cannot write or clean up outside', async t => {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'wait-root-')); t.after(()=>fs.rm(dir,{recursive:true,force:true})); const root=path.join(dir,'root'), outside=path.join(dir,'outside'); await fs.mkdir(root); await fs.mkdir(outside); await fs.writeFile(path.join(outside,'sentinel'),'keep');
 let release, started; const entered=new Promise(r=>started=r); let requested=0, cleaned=0;
 const q=new DownloadQueue(()=>1,()=>{},async()=>{requested++;return new Response('data')});
 await q.enqueue({id:'1',name:'file.txt',size:4},root,async()=>{started(); await new Promise(r=>release=r); return 'http://fixture';},async()=>{cleaned++});
 await entered; await fs.rename(root,path.join(dir,'original')); await fs.symlink(outside,root,'junction'); release();
 while(['queued','downloading','finalizing','cleaning'].includes(q.jobs[0].status)) await new Promise(r=>setTimeout(r,10));
 assert.equal(q.jobs[0].status,'failed'); assert.equal(requested,1); assert.equal(cleaned,0); assert.deepEqual(await fs.readdir(outside),['sentinel']); assert.equal(await fs.readFile(path.join(outside,'sentinel'),'utf8'),'keep');
});
