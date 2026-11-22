const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {checkDesktopRelease,updateAssetName,compareVersions,stableVersion,updateResponse,updateBytes}=require('../dist/desktop/update-release.js');
const {DesktopUpdater}=require('../dist/desktop/app-updates.js');
const {privateUpdateDirectory,downloadUpdateAsset,verifyUpdateFile}=require('../dist/desktop/update-transfer.js');
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const controller=()=>new AbortController();
function feed({platform='windows',arch='x64',version='2.3.0',mutateManifest,wrongKey=false}={}){
  const pair=crypto.generateKeyPairSync('ed25519');
  const name=updateAssetName(version,platform,arch),payload=Buffer.from('generated fixture update');
  const item={name,bytes:payload.length,sha256:digest(payload)};
  if(platform==='macos')item.ed25519=crypto.sign(null,payload,pair.privateKey).toString('base64');
  const manifest={schema:1,version,assets:[item]};
  mutateManifest?.(manifest);
  const bytes=Buffer.from(JSON.stringify(manifest)+'\n');
  const signing=wrongKey?crypto.generateKeyPairSync('ed25519').privateKey:pair.privateKey;
  const sig=Buffer.from(crypto.sign(null,bytes,signing).toString('base64')+'\n');
  const base=`https://github.com/garbledhamster/putio-manager/releases/download/v${version}/`;
  const manifestName=`PutioManager-${version}-updates.json`;
  const values=new Map([[base+name,payload],[base+manifestName,bytes],[base+manifestName+'.sig',sig]]);
  const assets=[...values].map(([url,value])=>({name:url.slice(base.length),size:value.length,digest:'sha256:'+digest(value),state:'uploaded',browser_download_url:url}));
  const release={tag_name:'v'+version,draft:false,prerelease:false,assets,body:'CANARY_PRIVATE_TEXT'};
  const calls=[];
  const fetcher=async(url,options)=>{
    calls.push({url,options});
    if(url.endsWith('/releases/latest'))return new Response(JSON.stringify(release));
    if(!values.has(url))throw Error('unexpected request');
    return new Response(values.get(url));
  };
  const opts={currentVersion:'2.2.0',platform:platform==='windows'?'win32':platform==='macos'?'darwin':'linux',arch,publicKey:pair.publicKey.export({format:'pem',type:'spki'}),fetcher};
  return {opts,release,assets,values,calls,item,payload,base,manifestName};
}
for(const platform of ['windows','macos','linux'])for(const arch of ['x64','arm64']){
 test(`signed fixed-feed selection matches ${platform}/${arch}`,async()=>{
  const fixture=feed({platform,arch});
  const result=await checkDesktopRelease(fixture.opts,controller().signal);
  assert.equal(result.asset.name,fixture.item.name);assert.equal(result.asset.sha256,fixture.item.sha256);
  assert.equal(result.asset.ed25519,fixture.item.ed25519);
  assert.ok(!JSON.stringify(result).includes('CANARY_PRIVATE_TEXT'));
  assert.ok(fixture.calls.every(call=>call.options.credentials==='omit'&&call.options.redirect==='manual'&&!('Authorization'in call.options.headers)));
 });
}
test('stable versions are bounded for MSI and downgrade comparison is numeric',()=>{
 for(const value of ['2.2.0','0.0.0','255.255.65535'])assert.ok(stableVersion(value));
 for(const value of ['2.2.0-beta','02.2.0','256.1.0','1.256.0','1.0.65536','../2.2.0','CANARY_PRIVATE_TEXT'])assert.equal(stableVersion(value),false);
 assert.equal(compareVersions('2.10.0','2.9.9'),1);assert.equal(compareVersions('2.2.0','2.2.0'),0);
});
test('an older existing unsigned release is current, not an installation candidate',async()=>{
 const f=feed({version:'2.1.0'});f.release.assets=[];
 assert.equal(await checkDesktopRelease(f.opts,controller().signal),undefined);assert.equal(f.calls.length,1);
});
test('wrong signing key fails even when GitHub byte digests agree',async()=>{
 const f=feed({wrongKey:true});await assert.rejects(checkDesktopRelease(f.opts,controller().signal),error=>error.updateCode==='signature-invalid');
});
test('missing and corrupt signatures cannot fall back to unsigned updates',async()=>{
 for(const kind of ['missing','bad']){
  const f=feed();
  if(kind==='missing')f.release.assets=f.release.assets.filter(asset=>!asset.name.endsWith('.sig'));
  else{const value=Buffer.from('not a signature');f.values.set(f.base+f.manifestName+'.sig',value);const asset=f.assets.find(a=>a.name.endsWith('.sig'));asset.size=value.length;asset.digest='sha256:'+digest(value)}
  await assert.rejects(checkDesktopRelease(f.opts,controller().signal));
 }
});
test('signed manifest cannot mismatch its version, size, checksum, architecture or safe filename',async()=>{
 const mutations=[m=>m.version='2.4.0',m=>m.assets[0].bytes++,m=>m.assets[0].sha256='a'.repeat(64),m=>m.assets[0].name='PutioManager-2.3.0-windows-arm64-setup.msi',m=>m.assets[0].name='../CANARY_PRIVATE_TEXT'];
 for(const mutateManifest of mutations){const f=feed({mutateManifest});await assert.rejects(checkDesktopRelease(f.opts,controller().signal))}
});
test('Mac requires a canonical 64-byte archive signature in the authenticated descriptor',async()=>{
 const mutations=[m=>delete m.assets[0].ed25519,m=>m.assets[0].ed25519='invalid',m=>m.assets[0].ed25519=Buffer.alloc(63).toString('base64'),m=>m.assets[0].ed25519=Buffer.alloc(64).toString('base64').replace(/==$/,'B=')];
 for(const mutateManifest of mutations){const f=feed({platform:'macos',mutateManifest});await assert.rejects(checkDesktopRelease(f.opts,controller().signal),error=>error.updateCode==='release-invalid')}
});
test('draft, prerelease, duplicate, foreign-host, missing-digest and oversize API assets are rejected',async()=>{
 const mutations=[f=>f.release.draft=true,f=>f.release.prerelease=true,f=>f.release.assets.push({...f.release.assets[0]}),f=>f.release.assets[0].browser_download_url='https://untrusted.example/installer.msi',f=>delete f.release.assets[0].digest,f=>f.release.assets[0].size=3*1024**3];
 for(const mutate of mutations){const f=feed();mutate(f);await assert.rejects(checkDesktopRelease(f.opts,controller().signal))}
});
test('redirects stay on exact HTTPS hosts and carry no account headers',async()=>{
 let count=0;
 await assert.rejects(updateResponse('https://github.com/fixture',controller().signal,async()=>{count++;return new Response(null,{status:302,headers:{location:'http://127.0.0.1/private'}})}));
 assert.equal(count,1);
 count=0;await assert.rejects(updateResponse('https://github.com/fixture',controller().signal,async()=>{count++;return new Response(null,{status:302,headers:{location:'https://github.com/fixture'}})}));assert.equal(count,6);
});
test('metadata limits and failed requests do not include raw provider diagnostics',async()=>{
 await assert.rejects(updateBytes('https://github.com/fixture',2,controller().signal,async()=>new Response('oversized')));
 const f=feed();f.opts.fetcher=async()=>{throw Error('CANARY_PRIVATE_TEXT /private/profile?token=secret')};
 await assert.rejects(checkDesktopRelease(f.opts,controller().signal),error=>!String(error).includes('CANARY_PRIVATE_TEXT')&&error.updateCode==='network');
});
function service({prepare,beforeInstall,releaseCheck,supported=true,onStatus}={}){
 const calls=[];
 const release={version:'2.3.0',platform:'windows',arch:'x64',asset:{name:'fixture',url:'fixture',bytes:1,sha256:'a'.repeat(64)},assets:[]};
 const adapter={supported,prepare:prepare??(async(_r,_s,progress)=>{calls.push('prepare');progress({phase:'ready',percent:100});return{version:'2.3.0',id:'fixture'}}),handoff:async()=>{calls.push('handoff')},cancel:async()=>{calls.push('cancel')}};
 const updater=new DesktopUpdater({currentVersion:'2.2.0',platform:'win32',arch:'x64',adapter,releaseCheck:releaseCheck??(async()=>release),beforeInstall:beforeInstall??(async()=>{calls.push('close')}),onStatus});
 return{updater,calls,adapter,release};
}
test('verified prepare precedes successful engine closure, then installer handoff',async()=>{
 const f=service();await f.updater.install();assert.deepEqual(f.calls,['prepare','close','handoff']);assert.equal(f.updater.status().phase,'installing');
});
test('failed shutdown aborts native preparation and never starts installation',async()=>{
 const f=service({beforeInstall:async()=>{throw Error('CANARY_PRIVATE_TEXT')}});const state=await f.updater.install();
 assert.equal(state.errorCode,'shutdown-unconfirmed');assert.ok(!f.calls.includes('handoff'));assert.ok(f.calls.includes('cancel'));assert.ok(!JSON.stringify(state).includes('CANARY_PRIVATE_TEXT'));
});
test('concurrent checks and update clicks are single-flight',async()=>{
 let resolveCheck,checks=0,prepares=0;
 const f=service({releaseCheck:()=>{checks++;return new Promise(resolve=>{resolveCheck=resolve})},prepare:async()=>{prepares++;return{version:'2.3.0',id:'fixture'}}});
 const first=f.updater.check(),second=f.updater.check();assert.equal(first,second);resolveCheck(f.release);await first;
 await Promise.all([f.updater.install(),f.updater.install()]);assert.equal(checks,1);assert.equal(prepares,1);assert.equal(f.calls.filter(v=>v==='handoff').length,1);
});
test('cancellation before preparation completes cannot close work or install',async()=>{
 const f=service({prepare:async(_r,signal)=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('installer-cancelled')),{once:true}))});
 await f.updater.check();const installing=f.updater.install();await f.updater.cancel();await installing;
 assert.equal(f.updater.status().phase,'cancelled');assert.ok(!f.calls.includes('handoff'));assert.ok(!f.calls.includes('close'));
});
test('private or non-finite progress and diagnostics cannot enter public state',async()=>{
 const seen=[];
 const f=service({onStatus:s=>seen.push(s),prepare:async(_r,_s,progress)=>{progress({phase:'downloading',percent:NaN,private:'CANARY_PRIVATE_TEXT'});progress({phase:'downloading',percent:Infinity});throw Error('CANARY_PRIVATE_TEXT /private/path')}});
 const result=await f.updater.install();assert.equal(result.phase,'failed');assert.ok(!JSON.stringify(seen).includes('CANARY_PRIVATE_TEXT'));assert.ok(seen.every(v=>v.progressPercent===undefined||Number.isFinite(v.progressPercent)));
});
test('unsupported installs may check releases but cannot start a replacement',async()=>{
 const f=service({supported:false});assert.equal((await f.updater.check()).phase,'available');assert.equal((await f.updater.install()).errorCode,'unsupported-installation');assert.ok(!f.calls.includes('prepare'));
});
test('a prepared result for another version is rejected before engine closure',async()=>{
 const f=service({prepare:async()=>({version:'9.0.0',id:'fixture'})});assert.equal((await f.updater.install()).errorCode,'download-invalid');assert.ok(!f.calls.includes('close'));
});
test('a failed handoff clears transient restartRequired before another check',async()=>{
 const f=service();f.adapter.handoff=async()=>{throw Error('installer-failed')};
 const failed=await f.updater.install();assert.equal(failed.phase,'failed');assert.equal(failed.restartRequired,false);
 const checked=await f.updater.check();assert.equal(checked.phase,'available');assert.equal(checked.restartRequired,false);
});
test('download is exclusively staged, verified and rejects corruption without retained partial bytes',async t=>{
 const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'putio-update-fixture-'));
 t.after(async()=>{if(path.dirname(temporary)!==path.resolve(os.tmpdir())||!path.basename(temporary).startsWith('putio-update-fixture-'))throw Error('Unexpected fixture path');await fs.rm(temporary,{recursive:true,force:true})});
 const f=feed(),dir=await privateUpdateDirectory(temporary,'windows-'),signal=controller().signal;
 const asset={...f.item,url:f.base+f.item.name};
 const file=await downloadUpdateAsset(asset,dir,signal,()=>{},async()=>new Response(f.payload));
 await verifyUpdateFile(file,asset);await fs.writeFile(file,'modified');await assert.rejects(verifyUpdateFile(file,asset));
 const badDir=await privateUpdateDirectory(temporary,'windows-');
 await assert.rejects(downloadUpdateAsset(asset,badDir,signal,()=>{},async()=>new Response(Buffer.alloc(f.payload.length,1))));
 assert.deepEqual(await fs.readdir(badDir),[]);
 const declaredDir=await privateUpdateDirectory(temporary,'windows-');
 await assert.rejects(downloadUpdateAsset(asset,declaredDir,signal,()=>{},async()=>new Response(f.payload,{headers:{'content-length':'99999'}})));
 assert.deepEqual(await fs.readdir(declaredDir),[]);
});
test('failed transfer cleanup preserves substituted files, directories and unknown contents',async t=>{
 const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'putio-transfer-ownership-'));
 t.after(()=>fs.rm(temporary,{recursive:true,force:true}));
 for(const kind of ['file','directory','unknown']){
  const f=feed(),directory=await privateUpdateDirectory(temporary,'windows-'),filename=path.join(directory,'verified-update.msi');let sentinel,renameBlocked=false;
  await assert.rejects(downloadUpdateAsset({...f.item,url:f.base+f.item.name},directory,controller().signal,()=>{},async()=>{
   if(kind==='directory'){try{await fs.rename(directory,path.join(temporary,'retained-'+kind))}catch(error){if(process.platform==='win32'&&['EPERM','EACCES'].includes(error.code)){renameBlocked=true;throw error}throw error}await fs.mkdir(directory)}
   if(kind==='file')await fs.rename(filename,path.join(temporary,'retained-'+kind));
   if(kind!=='unknown')await fs.writeFile(filename,'foreign generated payload');
   sentinel=path.join(directory,'unknown-sentinel');await fs.writeFile(sentinel,'generated sentinel');
   throw Error('generated transfer failure');
  }));
  if(renameBlocked){t.diagnostic('Windows refused renaming an open transfer directory; substitution regression runs on native Linux/macOS CI.');continue}
  assert.equal(await fs.readFile(sentinel,'utf8'),'generated sentinel');
  if(kind!=='unknown')assert.equal(await fs.readFile(filename,'utf8'),'foreign generated payload');
  else await assert.rejects(fs.access(filename));
 }
});
