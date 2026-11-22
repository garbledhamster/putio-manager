const {test}=require('node:test'); const assert=require('node:assert/strict'); const {spawn,spawnSync}=require('node:child_process'); const fs=require('node:fs'); const os=require('node:os'); const path=require('node:path'); const net=require('node:net'); const {randomBytes}=require('node:crypto');
test('headless CLI rejects malformed invocation without printing arguments',()=>{
 const secret='sentinel-secret-that-must-not-appear';
 const p=spawnSync(process.execPath,['dist/server/cli.js','status','--token',secret],{encoding:'utf8'});
 assert.equal(p.status,1); assert.ok(!p.stdout.includes(secret)); assert.ok(!p.stderr.includes(secret));
});
test('real CLI serves, pauses and resumes using protected disposable configuration',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'putio-cli-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const listener=net.createServer(); await new Promise(r=>listener.listen(0,'127.0.0.1',r)); const port=listener.address().port; await new Promise(r=>listener.close(r));
 const clientFile=path.join(dir,'client'),keyFile=path.join(dir,'key'),config=path.join(dir,'config.json');
 fs.writeFileSync(clientFile,randomBytes(32).toString('base64url'),{mode:0o600}); fs.writeFileSync(keyFile,randomBytes(32).toString('base64url'),{mode:0o600});
 fs.writeFileSync(config,JSON.stringify({host:'127.0.0.1',port,stateDirectory:path.join(dir,'state'),roots:[{id:'downloads',label:'Downloads',path:dir}],clientTokenFile:clientFile,credentialKeyFile:keyFile}));
 const server=spawn(process.execPath,['dist/server/cli.js','serve','--config',config],{stdio:['ignore','pipe','pipe']}); t.after(()=>server.kill());
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('server startup timeout')),5000);server.stdout.on('data',d=>{if(String(d).includes('Server ready')){clearTimeout(timer);resolve()}});server.once('exit',()=>{clearTimeout(timer);reject(new Error('server exited'))})});
 for(const [command,expected] of [['pause',true],['status',true],['resume',false],['status',false]]) {
  const proc=spawn(process.execPath,['dist/server/cli.js',command,'--config',config]); let out=''; proc.stdout.on('data',d=>out+=d); const exit=await new Promise(r=>proc.on('exit',r)); assert.equal(exit,0); if(command==='status') assert.equal(JSON.parse(out).value.paused,expected);
 }
 server.kill(); await new Promise(r=>server.once('exit',r));
});
test('CLI reports safe settings and metadata-only storage with staging initially off',async t=>{
 const {privateTemp}=require('./helpers/private-staging-fixture.cjs');const dir=await privateTemp(path.join(os.tmpdir(),'putio-cli-stage-'));let server;t.after(async()=>{if(server&&server.exitCode===null&&server.signalCode===null)await new Promise(resolve=>{server.once('exit',resolve);server.kill()});fs.rmSync(dir,{recursive:true,force:true})});
 const root=path.join(dir,'root'),stage=path.join(dir,'stage');fs.mkdirSync(root);fs.mkdirSync(stage);
 const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
 const clientFile=path.join(dir,'client'),keyFile=path.join(dir,'key'),config=path.join(dir,'config.json');
 fs.writeFileSync(clientFile,randomBytes(32).toString('base64url'),{mode:0o600});fs.writeFileSync(keyFile,randomBytes(32).toString('base64url'),{mode:0o600});
 fs.writeFileSync(config,JSON.stringify({host:'127.0.0.1',port,stateDirectory:path.join(dir,'state'),roots:[{id:'root',label:'Root',path:root}],stagingDirectory:stage,clientTokenFile:clientFile,credentialKeyFile:keyFile}));
 server=spawn(process.execPath,['dist/server/cli.js','serve','--config',config],{stdio:['ignore','pipe','pipe'],windowsHide:true});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('fixture server startup timeout')),5000);server.stdout.on('data',d=>{if(String(d).includes('Server ready')){clearTimeout(timer);resolve()}});server.once('exit',()=>{clearTimeout(timer);reject(Error('fixture server exited'))})});
 const settings=await runPrivateCli(['settings','--config',config],[dir,root,stage]);
 assert.equal(settings.value.stageDownloads,false);assert.equal(Object.hasOwn(settings.value,'stagingDirectory'),false);assert.equal(Object.hasOwn(settings.value,'downloadDirectory'),false);
 const storage=await runPrivateCli(['storage','--config',config],[dir,root,stage]);assert.equal(storage.value.volumes.length,2);
 for(const volume of storage.value.volumes){assert.match(volume.ref,/^volume_[0-9a-f]{24}$/);assert.equal(volume.status,'ok');assert.ok(volume.capacityBytes>0);assert.ok(volume.freeBytes>=0);assert.ok(volume.availableBytes>=0);assert.equal(Object.hasOwn(volume,'path'),false)}
 server.kill();await new Promise(r=>server.once('exit',r));
});

async function runPrivateCli(args, forbidden, expectedExit=0, input, keepInputOpen=false) {
 const child=spawn(process.execPath,['dist/server/cli.js',...args],{stdio:['pipe','pipe','pipe'],windowsHide:true,timeout:20000,env:{...process.env,PUTIO_MANAGER_CONFIG:''}});
 let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
 const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)});if(!keepInputOpen)child.stdin.end(input);
 assert.equal(await exited,expectedExit);for(const item of forbidden)for(const representation of [item,JSON.stringify(item).slice(1,-1)])assert.equal((stdout+stderr).includes(representation),false,'CLI must not reveal fixture-private values');
 if(expectedExit===0)assert.equal(stderr,'');const output=(stdout+stderr).trim();assert.equal(output.split('\n').length,1);return JSON.parse(output);
}

test('real child CLI keeps hostile synthetic remote metadata private across reads and operations',async t=>{
 const http=require('node:http');const {agentJobRef,agentRootRef}=require('../dist/server/agent-cli');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'putio-cli-private-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const sentinel='SENTINEL_PRIVATE_MEDIA_ACCOUNT_2937',privatePath=path.join(dir,sentinel,'movie.mkv'),privateHost=`${sentinel}.example.test`,privateToken=randomBytes(32).toString('base64url');
 const state={engine:{id:sentinel,label:privateHost,epoch:sentinel,revision:1,protocolVersion:2},connection:{status:'connected',message:sentinel},paused:false,
 roots:[{id:sentinel,label:privatePath}],settings:{downloadDirectory:privatePath,stagingDirectory:privatePath,stageDownloads:false,stagingMaxBytes:10000,stagingMinimumFreeBytes:100,parallelDownloads:2,speedLimitBytesPerSecond:0,autoDownloadInterval:60,deleteAfterDownload:false,deleteSourceFolders:false,showToolTips:true,autoStartApplication:false,token:privateToken},
 jobs:[{id:sentinel,fileId:sentinel,name:sentinel,destination:privatePath,status:'failed',bytesReceived:12,totalBytes:120,speed:0,addedAt:'2020-01-01T00:00:00Z',error:`Disk full ${privatePath} https://${privateHost}/?token=${privateToken}`,verification:'unverified',cleanupStatus:'not-required'}],
 rules:[{id:sentinel,folderId:sentinel,folderName:sentinel,downloadDirectory:privatePath,extensions:[],minSizeBytes:0,keepFolderStructure:false}],hasToken:true,secureStorageAvailable:true,scanStatus:sentinel,timeZone:sentinel,nextRuleRuns:{[sentinel]:sentinel},account:{status:'connected',message:sentinel}};
 const commands=[];let requests=0,fail=false;
 const server=http.createServer(async(req,res)=>{requests++;assert.equal(req.headers.authorization,`Bearer ${privateToken}`);res.setHeader('content-type','application/json');
  if(fail){res.statusCode=500;res.end(JSON.stringify({ok:false,error:{code:sentinel,message:`${privatePath} ${privateToken}`}}));return}
  if(req.method==='GET'&&req.url==='/v2/state'){res.end(JSON.stringify({ok:true,value:state}));return}
  assert.equal(req.url,'/v2/commands');let raw='';for await(const chunk of req)raw+=chunk;const command=JSON.parse(raw);commands.push(command);
  if(command.command==='pause')state.paused=true;if(command.command==='resume')state.paused=false;if(command.command==='saveSettings')Object.assign(state.settings,command.args[0]);
  const value=command.command==='storageStatus'?{volumes:[{id:sentinel,kind:'download',status:'ok',capacityBytes:10000,freeBytes:1000,availableBytes:500,path:privatePath,label:sentinel},{id:privateHost,kind:'staging',status:'unavailable',capacityBytes:null,freeBytes:null,availableBytes:null,error:privateToken}]}:{token:privateToken,account:sentinel,path:privatePath,state};
  res.end(JSON.stringify({ok:true,value}));
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const config=path.join(dir,'config.json'),clientFile=path.join(dir,'client'),keyFile=path.join(dir,'key');fs.writeFileSync(clientFile,privateToken,{mode:0o600});fs.writeFileSync(keyFile,randomBytes(32).toString('base64url'),{mode:0o600});
 fs.writeFileSync(config,JSON.stringify({host:'127.0.0.1',port:server.address().port,stateDirectory:path.join(dir,'state'),roots:[{id:sentinel,label:sentinel,path:dir}],clientTokenFile:clientFile,credentialKeyFile:keyFile,label:privateHost}));
 const forbidden=[sentinel,privatePath,privateHost,privateToken,dir,clientFile,keyFile];const cli=(args=[],exit=0,input)=>runPrivateCli([...args,'--config',config],forbidden,exit,input);
 for(const command of [[],['status'],['downloads'],['analytics'],['settings'],['roots'],['storage']])assert.equal((await cli(command)).ok,true);
 const downloaded=(await cli(['downloads'])).value.jobs[0];assert.equal(downloaded.ref,agentJobRef(sentinel));assert.equal(downloaded.errorCategory,'storage-full');
 assert.equal((await cli(['pause'])).value.paused,true);assert.equal((await cli(['resume'])).value.paused,false);assert.equal((await cli(['check-rules'])).ok,true);
 const ref=agentJobRef(sentinel);assert.equal((await cli(['retry',ref])).value.accepted,true);assert.equal((await cli(['cancel',ref])).value.accepted,true);
 state.jobs[0].status='completed';state.jobs[0].verification='verified';state.jobs[0].stagingWarning=`Staged copy could not be removed ${privatePath}`;delete state.jobs[0].error;
 assert.equal((await cli(['cleanup',ref])).value.accepted,true);
 assert.equal((await cli(['root-select',agentRootRef(sentinel)])).value.selected,true);
 assert.equal((await cli(['settings-set','--json'],0,JSON.stringify({parallelDownloads:3}))).value.parallelDownloads,3);
 assert.deepEqual(commands.map(c=>c.command),['storageStatus','pause','resume','checkRules','retryDownload','cancelDownloads','retryDownload','selectDownloadRoot','saveSettings']);
 const retry=commands.find(c=>c.command==='retryDownload');assert.deepEqual(retry.args,[sentinel]);assert.match(retry.requestId,/^[0-9a-f-]{36}$/);
 assert.deepEqual(commands.find(c=>c.command==='cancelDownloads').args,[[sentinel]]);
 const before=requests;for(const args of [['status','--raw'],['retry',sentinel],['cancel','--all'],['listFiles','0'],['auth'],['status','--token',privateToken],['agent','serve'],['agent','setup'],['agent','auth']])assert.equal((await cli(args,1)).ok,false);
 assert.equal(fs.existsSync(path.join(dir,'state')),false,'explicit agent mode must not start or configure an engine');
 assert.equal((await runPrivateCli(['settings-set','--raw','--config',config],forbidden,1,undefined,true)).ok,false,'invalid settings flags must exit without waiting for stdin');
 assert.equal((await cli(['settings-set','--json'],1,JSON.stringify({downloadDirectory:privatePath}))).ok,false);assert.equal((await cli(['settings-set','--json'],1,`{"token":"${privateToken}"`)).ok,false);assert.equal(requests,before,'malformed commands must not contact the engine');
 fail=true;assert.equal((await cli(['status'],1)).ok,false);
});
