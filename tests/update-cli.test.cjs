const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {createRequire}=require('node:module');
const {EventEmitter}=require('node:events');
const control=require('../dist/desktop/desktop-update-control');
const {updateAction,publicUpdateStatus,performUpdateAction}=require('../dist/desktop/update-cli');
const {DesktopUpdater}=require('../dist/desktop/app-updates');
const state=()=>({schema:1,source:'github',platform:'windows',currentVersion:'2.2.0',capability:'automatic',phase:'available',availableVersion:'2.3.0',message:'GENERATED_PRIVATE_DIAGNOSTIC',nextAction:'GENERATED_PRIVATE_DIAGNOSTIC',restartRequired:false});
async function temporary(t){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'putio-control-fixture-'));t.after(async()=>{assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('putio-control-fixture-'));await fs.rm(directory,{recursive:true,force:true})});return directory}
test('CLI action vocabulary is exact and unknown arguments are never echoed',()=>{for(const verb of['status','check','install','cancel'])assert.equal(updateAction([verb]),verb);for(const args of[[],['status','private'],['https://private.invalid'],['INSTALL'],['install','--path=/private']])assert.throws(()=>updateAction(args),/update-failed/)});
test('CLI rejects a non-string phase even when its coercion resembles a known status',()=>{assert.throws(()=>publicUpdateStatus({...state(),phase:['available']}),/update-failed/)});
test('CLI status selects fields and derives controlled copy, progress and errors',()=>{const safe=publicUpdateStatus({...state(),path:'/GENERATED_PRIVATE',token:'fixture-private-sentinel',progressPercent:Infinity});assert.ok(!JSON.stringify(safe).includes('PRIVATE'));assert.equal(safe.progressPercent,undefined);assert.equal(publicUpdateStatus({...state(),progressPercent:999}).progressPercent,100);for(const patch of[{schema:2},{currentVersion:'2.2.0 PRIVATE'},{phase:'PRIVATE'},{platform:'PRIVATE'}])assert.throws(()=>publicUpdateStatus({...state(),...patch}));const failed=publicUpdateStatus({...state(),phase:'failed',errorCode:'signature-invalid'});assert.match(failed.message,/signature/);assert.ok(!JSON.stringify(failed).includes('PRIVATE'))});
test('private requests bind an opaque nonce to one exact verb and a bounded response',async t=>{const root=await temporary(t);const id=await control.createUpdateRequest(root,'check');assert.match(id,/^control-[0-9a-f-]{36}$/);assert.equal(await control.consumeUpdateRequest(root,id),'check');await assert.rejects(control.consumeUpdateRequest(root,id));await control.replyUpdateRequest(root,id,{ok:true,value:publicUpdateStatus(state())});assert.equal((await control.waitUpdateResponse(root,id)).value.phase,'available');assert.deepEqual(await fs.readdir(path.join(root,'desktop-updates')),[]);for(const bad of['../private','control-../../private',undefined])await assert.rejects(control.consumeUpdateRequest(root,bad))});
test('private requests reject arbitrary action, extra fields and symlink substitutions',async t=>{const root=await temporary(t);for(const bad of[{schema:1,action:'private'},{schema:1,action:'check',path:'/private'}]){const id=await control.createUpdateRequest(root,'check');await fs.writeFile(path.join(root,'desktop-updates',id,'request.json'),JSON.stringify(bad));await assert.rejects(control.consumeUpdateRequest(root,id));await control.removeUpdateRequest(root,id)}});
test('trusted profile aliases resolve canonically while request-directory links remain rejected',async t=>{
 const root=await temporary(t),profile=path.join(root,'profile'),alias=path.join(root,'profile-alias');await fs.mkdir(profile);
 try{await fs.symlink(profile,alias,process.platform==='win32'?'junction':'dir')}catch(error){if(process.platform==='win32'&&error.code==='EPERM'){t.skip('Directory links require host privileges');return}throw error}
 const id=await control.createUpdateRequest(alias,'status');assert.equal(await control.consumeUpdateRequest(alias,id),'status');await control.removeUpdateRequest(alias,id);
 const request=await control.createUpdateRequest(profile,'status'),directory=path.join(profile,'desktop-updates',request),renamed=directory+'-owned';await fs.rename(directory,renamed);await fs.symlink(renamed,directory,process.platform==='win32'?'junction':'dir');await assert.rejects(control.consumeUpdateRequest(alias,request));
});
test('primary install reply acknowledges accepted work without waiting for application exit',async()=>{let finish;const current=state(),service={status:()=>current,install:()=>new Promise(resolve=>{finish=resolve})};const result=await performUpdateAction(service,'install',true);assert.equal(result.accepted,true);assert.equal(result.value.phase,'available');finish(current)});
test('primary install reply does not acknowledge an immediately unsupported installation as accepted',async()=>{
 const service=new DesktopUpdater({currentVersion:'2.2.0',platform:'win32',arch:'x64',adapter:{supported:false,prepare:async()=>{throw Error('Must not prepare unsupported installation')},handoff:async()=>{throw Error('Must not hand off unsupported installation')}},beforeInstall:async()=>{throw Error('Must not close an unsupported installation')}});
 const result=await performUpdateAction(service,'install',true);assert.equal(result.ok,false);assert.notEqual(result.accepted,true);assert.equal(result.value.errorCode,'unsupported-installation');
});
test('CLI distinguishes a required restart after uncertain native handoff from an ordinary failure',async()=>{
 const release={version:'2.3.0',platform:'windows',arch:'x64',asset:{name:'generated',url:'generated',bytes:1,sha256:'0'.repeat(64)},assets:[]};
 for(const code of['restart-required','installer-failed']){
  const service=new DesktopUpdater({currentVersion:'2.2.0',platform:'win32',arch:'x64',releaseCheck:async()=>release,adapter:{supported:true,prepare:async()=>({version:release.version,id:'generated'}),handoff:async()=>{throw Error(code)}},beforeInstall:async()=>{}});
  const result=await performUpdateAction(service,'install');assert.equal(result.ok,false);assert.equal(result.value.errorCode,code);assert.equal(result.value.restartRequired,code==='restart-required');
 }
});
test('accepted install requests during a pending release check queue one verified installation',async()=>{
 let finishCheck,finishHandoff,prepares=0,closures=0,handoffs=0;
 const release={version:'2.3.0',platform:'windows',arch:'x64',asset:{name:'generated',url:'generated',bytes:1,sha256:'0'.repeat(64)},assets:[]};
 const handedOff=new Promise(resolve=>{finishHandoff=resolve});
 const service=new DesktopUpdater({currentVersion:'2.2.0',platform:'win32',arch:'x64',releaseCheck:()=>new Promise(resolve=>{finishCheck=resolve}),adapter:{supported:true,prepare:async()=>{prepares++;return{version:release.version,id:'generated'}},handoff:async()=>{handoffs++;finishHandoff()}},beforeInstall:async()=>{closures++}});
 const checking=service.check();
 const replies=await Promise.all([performUpdateAction(service,'install',true),performUpdateAction(service,'install',true)]);
 assert.ok(replies.every(reply=>reply.ok&&reply.accepted));
 finishCheck(release);await checking;
 await Promise.race([handedOff,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Accepted update never began installation.')),1000);timer.unref()})]);
 assert.equal(prepares,1);assert.equal(closures,1);assert.equal(handoffs,1);
});
async function mainFixture(t,args,{primary=false,updaterFactory,previousOutcome,platform='win32',nativeAdapterFactory}={}){
 const root=await temporary(t),outputs=[],calls=[],app=new EventEmitter();
 const completed=new Promise(resolve=>{app.exit=code=>{calls.push(['exit',code]);resolve()}});
 Object.assign(app,{setName:name=>calls.push(['name',name]),isPackaged:true,getVersion:()=> '2.2.0',getPath:()=>root,whenReady:()=>Promise.resolve(),releaseSingleInstanceLock:()=>calls.push(['release']),requestSingleInstanceLock:data=>{calls.push(['lock',data]);if(primary){setImmediate(async()=>{await control.consumeUpdateRequest(root,data.putioUpdateRequest);await control.replyUpdateRequest(root,data.putioUpdateRequest,{ok:true,value:{...state(),phase:'downloading',progressPercent:42}})});return false}return true}});
 const stdout=new EventEmitter(),stderr=new EventEmitter();stdout.write=(line,callback)=>{outputs.push(line);if(callback)setImmediate(()=>{calls.push(['stdout-flushed']);callback()});return true};stderr.write=()=>{};
 const actualRequire=createRequire(path.resolve('dist/desktop/main.js'));
 const forbidden=()=>{calls.push(['forbidden']);throw Error('GUI, engine or credential access in update CLI')};
 const context={exports:{},__dirname:path.resolve('dist/desktop'),process:{argv:['fixture','fixture',...args],stdout,stderr,platform,arch:'x64',resourcesPath:path.join(root,'resources'),execPath:path.join(root,'PutioManager.exe'),env:{}},console:{log:line=>outputs.push(line),error:forbidden},Buffer,setTimeout,clearTimeout,setImmediate,AbortController,AbortSignal,require:name=>{
  if(name==='electron')return{app,BrowserWindow:forbidden,dialog:{},ipcMain:{handle:forbidden},safeStorage:{isEncryptionAvailable:forbidden},shell:{},Tray:forbidden,nativeImage:{},Menu:{},clipboard:{}};
  if(name==='../engine/engine')return{createEngine:forbidden,EngineStartupFailure:class extends Error{}};
  if(name==='../remote/client')return{RemoteEngine:forbidden};
  if(name==='./windows-updates')return{createWindowsUpdateAdapter:()=>({supported:true,prepare:forbidden,handoff:forbidden}),readWindowsUpdateOutcome:async()=>previousOutcome};
  if(name==='./platform-updates')return{createNativeUpdateAdapter:()=>nativeAdapterFactory?nativeAdapterFactory({app,calls,outputs}):({supported:true,prepare:forbidden,handoff:forbidden}),readNativeUpdateOutcome:async()=>previousOutcome};
  if(name==='./app-updates'&&updaterFactory)return{DesktopUpdater:class{constructor(options){return updaterFactory({root,app,calls,options})}}};
  return actualRequire(name);
 }};
 vm.runInNewContext(await fs.readFile('dist/desktop/main.js','utf8'),context);
 await Promise.race([completed,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Fixture did not exit')),5000);timer.unref()})]);
 return{output:outputs.join(''),calls};
}
test('real main update status starts no window, engine or credentials',async t=>{const result=await mainFixture(t,['--app-update','status']);const output=JSON.parse(result.output);assert.equal(output.ok,true);assert.equal(output.value.currentVersion,'2.2.0');assert.ok(result.calls.some(x=>x[0]==='release'));assert.equal(result.calls.at(-1)[1],0)});
test('real main exposes authoritative running version successfully when a previous update failed',async t=>{
 const result=await mainFixture(t,['--app-update','status'],{previousOutcome:{phase:'failed',errorCode:'installer-failed'}});
 const output=JSON.parse(result.output);assert.equal(output.ok,true);assert.equal(output.value.phase,'failed');assert.equal(output.value.currentVersion,'2.2.0');assert.equal(output.value.errorCode,'installer-failed');assert.equal(result.calls.at(-1)[1],0);
});
test('real main recovers controlled Mac and Linux outcomes without account or engine access',async t=>{
 for(const platform of ['darwin','linux'])for(const previousOutcome of [{phase:'updated'},{phase:'failed',errorCode:'signature-invalid'},{phase:'restart-required',errorCode:'restart-required'}]){
  const result=await mainFixture(t,['--app-update','status'],{platform,previousOutcome});
  const output=JSON.parse(result.output);assert.equal(output.ok,true);assert.equal(output.value.phase,previousOutcome.phase==='restart-required'?'failed':previousOutcome.phase);assert.equal(output.value.restartRequired,previousOutcome.phase==='restart-required');assert.equal(output.value.currentVersion,'2.2.0');assert.equal(output.value.errorCode,previousOutcome.errorCode);assert.ok(!result.calls.some(call=>call[0]==='forbidden'));
 }
});

test('standalone CLI native handoff failure never probes GUI credential storage',async t=>{
 const result=await mainFixture(t,['--app-update','install'],{updaterFactory:({options})=>new DesktopUpdater({...options,
  releaseCheck:async()=>({version:'2.3.0',platform:'windows',arch:'x64',asset:{name:'generated',url:'generated',bytes:1,sha256:'0'.repeat(64)},assets:[]}),
  adapter:{supported:true,prepare:async()=>({version:'2.3.0',id:'generated'}),handoff:async()=>{throw Error('installer-failed')}}
 })});
 assert.equal(JSON.parse(result.output).value.errorCode,'installer-failed');assert.ok(!result.calls.some(call=>call[0]==='forbidden'));
});
test('Mac CLI flushes one acknowledgement before a native installer can terminate its host',async t=>{
 let acknowledgedBeforeNative=false,flushedBeforeNative=false;
 const result=await mainFixture(t,['--app-update','install'],{platform:'darwin',
  updaterFactory:({options})=>new DesktopUpdater({...options,releaseCheck:async()=>({version:'2.3.0',platform:'macos',arch:'x64',asset:{name:'generated',url:'generated',bytes:1,sha256:'0'.repeat(64)},assets:[]})}),
  nativeAdapterFactory:({app,calls,outputs})=>({supported:true,prepare:async()=>({version:'2.3.0',id:'generated'}),handoff:async()=>{
   const lines=outputs.join('').trim().split('\n');acknowledgedBeforeNative=lines.length===1&&JSON.parse(lines[0]).accepted===true;flushedBeforeNative=calls.some(call=>call[0]==='stdout-flushed');
   app.exit(0);await new Promise(()=>{});
  }})
 });
 assert.equal(acknowledgedBeforeNative,true);assert.equal(flushedBeforeNative,true);assert.equal(JSON.parse(result.output).value.phase,'installing');assert.ok(!result.calls.some(call=>call[0]==='forbidden'));
});
test('real main forwards status to the primary instance without opening its window',async t=>{const result=await mainFixture(t,['--app-update','status'],{primary:true});const output=JSON.parse(result.output);assert.equal(output.value.phase,'downloading');assert.equal(output.value.progressPercent,42);assert.ok(!result.output.includes('PRIVATE'))});
test('standalone CLI install answers a second update status request while preparing',async t=>{
 let observed;
 const result=await mainFixture(t,['--app-update','install'],{updaterFactory:({root,app})=>{
  const current={...state(),phase:'downloading',progressPercent:42};
  return{status:()=>current,install:async()=>{
   const id=await control.createUpdateRequest(root,'status');
   app.emit('second-instance',{},['fixture','--app-update','status'],'',{putioUpdateRequest:id});
   const response=path.join(root,'desktop-updates',id,'response.json'),deadline=Date.now()+1000;
   while(Date.now()<deadline){try{observed=JSON.parse(await fs.readFile(response,'utf8'));break}catch(error){if(error.code!=='ENOENT')throw error}await new Promise(resolve=>setTimeout(resolve,10))}
   await control.removeUpdateRequest(root,id);return current;
  }};
 }});
 assert.equal(JSON.parse(result.output).ok,true);assert.equal(observed?.ok,true);assert.equal(observed?.value?.phase,'downloading');assert.equal(observed?.value?.progressPercent,42);
});
test('real main rejects invalid or combined agent/update commands before account access',async t=>{for(const args of[['--app-update','status','PRIVATE'],['--agent','--app-update','status']]){const result=await mainFixture(t,args);assert.equal(JSON.parse(result.output).ok,false);assert.ok(!result.output.includes('PRIVATE'));assert.equal(result.calls.at(-1)[1],1)}});
