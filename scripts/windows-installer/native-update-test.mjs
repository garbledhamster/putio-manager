import fs from 'node:fs/promises';
import { createReadStream, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { buildWindowsInstallers, getWindowsInstallerIdentity, runTool } from './build.mjs';
import { auditWindowsInstallers } from './audit.mjs';
import { requireDisposableWindowsRunner } from './native-fixture.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pause = milliseconds => new Promise(resolve => setTimeout(resolve,milliseconds));
const sameGuid = (a,b) => String(a).replace(/[{}]/g,'').toUpperCase() === String(b).replace(/[{}]/g,'').toUpperCase();
async function sha256(filename) {
  const hash = createHash('sha256');
  for await(const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}
function confined(root,filename) {
  const target=path.resolve(filename),base=path.resolve(root);
  if(!target.startsWith(`${base}${path.sep}`)) throw new Error('Generated update fixture path escaped its CI directory.');
  return target;
}
async function missing(filename) {
  try { await fs.lstat(filename); return false; }
  catch(error) { if(error.code==='ENOENT') return true; throw error; }
}

/** The child loads the installed application's real modules. It changes no production hooks. */
async function runUpdateChild(jobFile) {
  requireDisposableWindowsRunner();
  const job=JSON.parse(await fs.readFile(jobFile,'utf8'));
  const work=confined(process.env.RUNNER_TEMP,path.dirname(jobFile));
  const installed=path.resolve(process.env.LOCALAPPDATA,'Programs','PutioManager');
  const profile=path.resolve(process.env.APPDATA,'putio-manager');
  if(job.schema!==1 || job.installed!==installed || job.profile!==profile || job.arch!==process.arch || !/^\d+\.\d+\.\d+$/.test(job.currentVersion) || !/^\d+\.\d+\.\d+$/.test(job.targetVersion)) throw new Error('Invalid generated native update fixture.');
  const msi=confined(work,job.msi),media=confined(work,job.media);
  const name=`PutioManager-${job.targetVersion}-windows-${process.arch}-setup.msi`;
  const url=`https://github.com/garbledhamster/putio-manager/releases/download/v${job.targetVersion}/${name}`;
  const bytes=(await fs.stat(msi)).size;
  const asset={name,url,bytes,sha256:await sha256(msi)};
  const release={version:job.targetVersion,platform:'windows',arch:process.arch,asset,assets:[asset]};
  // The sole synthetic network boundary serves the exact real MSI at the exact
  // production-trusted URL; the real transfer/hash/helper/registry code runs.
  globalThis.fetch=async(input,init)=>{
    if(input!==url || init?.redirect!=='manual' || init?.credentials!=='omit') throw new Error('Unexpected native update fixture network request.');
    return new Response(Readable.toWeb(createReadStream(msi)),{status:200,headers:{'content-length':String(bytes),'content-type':'application/octet-stream'}});
  };
  const application=path.join(installed,'resources','app','dist');
  const {DesktopUpdater}=require(path.join(application,'desktop','app-updates.js'));
  const {createWindowsUpdateAdapter}=require(path.join(application,'desktop','windows-updates.js'));
  const {createEngine}=require(path.join(application,'engine','engine.js'));
  const credentials={available:()=>false,encrypt:()=>{throw new Error('Fixture credentials are unavailable.');},decrypt:()=>{throw new Error('Fixture credentials are unavailable.');}};
  let engine=await createEngine({stateDirectory:profile,credentials,roots:[{id:'generated',label:'Generated fixture media',path:media}],transport:async()=>{throw new Error('Generated engine must not contact an account.');}});
  await engine.execute('selectDownloadRoot',['generated']);
  await engine.execute('saveSettings',[{parallelDownloads:3,deleteAfterDownload:false,deleteSourceFolders:false}]);
  await engine.execute('pause');
  const snapshot=await engine.getSnapshot();
  if(!snapshot.paused || snapshot.settings.deleteAfterDownload!==false || snapshot.settings.deleteSourceFolders!==false) throw new Error('Generated engine setup was not confirmed.');
  let closed=false;
  const evidenceFile=confined(work,path.join(work,'controller-evidence.json'));
  const context={platform:'win32',arch:process.arch,currentVersion:job.currentVersion,isPackaged:true,resourcesDirectory:path.join(installed,'resources'),applicationDirectory:installed,executablePath:path.join(installed,'PutioManager.exe'),userDataDirectory:profile,
    quitApplication(){
      if(!closed) throw new Error('Native update requested exit before engine closure.');
      writeFileSync(evidenceFile,JSON.stringify({schema:1,engineClosed:true,quitRequested:true,targetVersion:job.targetVersion})+'\n');
      // The real helper waits for this exact parent to exit before msiexec.
      process.exit(0);
    }};
  const updater=new DesktopUpdater({currentVersion:job.currentVersion,platform:'win32',arch:process.arch,adapter:createWindowsUpdateAdapter(context),releaseCheck:async()=>release,
    beforeInstall:async()=>{
      await engine.close(); engine=undefined; closed=true;
      if(!await missing(path.join(profile,'.engine-owner.lock'))) throw new Error('The generated engine still owns its state.');
      writeFileSync(evidenceFile,JSON.stringify({schema:1,engineClosed:true,quitRequested:false,targetVersion:job.targetVersion})+'\n');
    }});
  try {
    if((await updater.check()).phase!=='available') throw new Error('Native update fixture did not find B.');
    await updater.install();
    // Successful handoff exits through context.quitApplication above.
    throw new Error('Native update fixture returned without requesting application exit.');
  } finally { if(engine) await engine.close(); }
}

async function readExecutableProcesses(executable) {
  const statement="$ErrorActionPreference='Stop'; $target=[IO.Path]::GetFullPath($env:PUTIO_FIXTURE_EXECUTABLE); $items=@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -eq $target } | ForEach-Object { [int]$_.ProcessId }); ConvertTo-Json -InputObject $items -Compress";
  const result=await runTool(path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-Command',statement],{env:{PUTIO_FIXTURE_EXECUTABLE:executable}});
  const pids=JSON.parse(result.stdout.replace(/^\uFEFF/,''));
  if(!Array.isArray(pids) || pids.some(pid=>!Number.isSafeInteger(pid)||pid<=0||pid===process.pid)) throw new Error('Invalid generated application process inventory.');
  return pids;
}
async function readOwnedProcesses(installed) { return await readExecutableProcesses(path.join(installed,'PutioManager.exe')); }
async function stopOwnedApplication(installed) {
  for(const pid of await readOwnedProcesses(installed)) {
    try { process.kill(pid); } catch(error) { if(error.code!=='ESRCH') throw error; }
  }
  const deadline=Date.now()+10000;
  while(Date.now()<deadline) {if((await readOwnedProcesses(installed)).length===0)return;await pause(100);}
  throw new Error('The generated installed application did not terminate.');
}
async function appStatus(executable) {
  const result=await runTool(executable,['--app-update','status'],{timeoutMs:35000});
  const lines=result.stdout.split(/\r?\n/).filter(line=>line.startsWith('{"ok":'));
  if(lines.length!==1) throw new Error('The actual installed application returned no controlled version status.');
  const response=JSON.parse(lines[0]);
  if(response.ok!==true || response.value?.schema!==1 || response.value?.platform!=='windows') throw new Error('The installed application update status is invalid.');
  return response.value;
}
async function assertSingleProduct(identity) {
  const statement="$ErrorActionPreference='Stop'; $name='Putio Manager'; $records=@(); foreach($root in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall','HKCU:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) { if(Test-Path -LiteralPath $root) { $records+=@(Get-ChildItem -LiteralPath $root | ForEach-Object { Get-ItemProperty -LiteralPath $_.PSPath } | Where-Object { $_.DisplayName -eq $name } | ForEach-Object { [pscustomobject]@{ productCode=$_.PSChildName; version=$_.DisplayVersion; msi=$_.WindowsInstaller -eq 1 } }) } }; ConvertTo-Json -InputObject $records -Compress";
  const result=await runTool(path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-Command',statement]);
  const records=JSON.parse(result.stdout.replace(/^\uFEFF/,''));
  if(!Array.isArray(records) || records.length!==1 || !records[0].msi || records[0].version!==identity.version || !sameGuid(records[0].productCode,identity.productCode)) throw new Error('The actual application has duplicate or unexpected installer ownership.');
}

export async function runNativeWindowsUpdateTest() {
  requireDisposableWindowsRunner();
  const base=JSON.parse(await fs.readFile('package.json','utf8'));
  const currentVersion=base.version;
  const parts=currentVersion.split('.').map(Number);
  if(parts.length!==3 || parts[2]>=65535) throw new Error('The native update fixture cannot form a next stable patch version.');
  const targetVersion=`${parts[0]}.${parts[1]}.${parts[2]+1}`;
  const arch=process.arch;
  const a=getWindowsInstallerIdentity({version:currentVersion,arch});
  const b=getWindowsInstallerIdentity({version:targetVersion,arch});
  const installed=path.resolve(process.env.LOCALAPPDATA,'Programs','PutioManager');
  const profile=path.resolve(process.env.APPDATA,'putio-manager');
  // Existing data is never adopted by this fixture, even on a hosted runner.
  if(!await missing(installed) || !await missing(profile)) throw new Error('The native update fixture requires a clean application and profile.');
  const {readWindowsInstallValue}=require(path.resolve('dist/desktop/update-windows-helper.js'));
  for(const cpu of ['x64','arm64']) if(await readWindowsInstallValue(cpu,'ProductCode') || await readWindowsInstallValue(cpu,'InstallLocation')) throw new Error('The native update fixture requires clean installer ownership.');
  const source=path.resolve('release',`PutioManager-win32-${arch}`);
  const originalPackage=JSON.parse(await fs.readFile(path.join(source,'resources/app/package.json'),'utf8'));
  if(originalPackage.name!=='putio-manager' || originalPackage.version!==currentVersion || originalPackage.main!=='dist/desktop/main.js') throw new Error('The actual Packager payload does not match the current application.');
  const work=await fs.mkdtemp(path.join(path.resolve(process.env.RUNNER_TEMP),'putio-native-update-'));
  confined(process.env.RUNNER_TEMP,work);
  const media=path.join(work,'generated-media');
  const sentinel='Generated native update preservation fixture.\n';
  let installedByFixture=false,handedOff=false,verified=false,child;
  async function msi(args,allowExitCodes=[0]) { return await runTool(path.join(process.env.SystemRoot,'System32','msiexec.exe'),[...args,'/qn','/norestart','REBOOT=ReallySuppress'],{allowExitCodes}); }
  try {
    const appB=path.join(work,'application-b');
    await fs.cp(source,appB,{recursive:true,verbatimSymlinks:true});
    await fs.writeFile(path.join(appB,'resources/app/package.json'),JSON.stringify({...originalPackage,version:targetVersion},null,2)+'\n');
    const outputA=path.join(work,'installer-a'),outputB=path.join(work,'installer-b');
    const builtA=await buildWindowsInstallers({version:currentVersion,arch,appDirectory:source,outputDirectory:outputA});
    const builtB=await buildWindowsInstallers({version:targetVersion,arch,appDirectory:appB,outputDirectory:outputB});
    for(const options of [{version:currentVersion,appDirectory:source,outputDirectory:outputA},{version:targetVersion,appDirectory:appB,outputDirectory:outputB}]) {
      const audit=await auditWindowsInstallers({...options,arch}); await audit.cleanup();
    }
    await msi(['/i',builtA.msi]); installedByFixture=true;
    await assertSingleProduct(a);
    const executable=path.join(installed,'PutioManager.exe');
    if((await appStatus(executable)).currentVersion!==currentVersion) throw new Error('The actual installed A executable reports the wrong version.');
    await fs.mkdir(profile,{recursive:true}); await fs.mkdir(media);
    await fs.writeFile(path.join(profile,'native-update-preservation.txt'),sentinel);
    await fs.writeFile(path.join(media,'generated-media.txt'),sentinel);
    const jobFile=path.join(work,'fixture-job.json');
    await fs.writeFile(jobFile,JSON.stringify({schema:1,currentVersion,targetVersion,arch,installed,profile,msi:builtB.msi,media})+'\n',{flag:'wx'});
    child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--fixture-child',jobFile],{windowsHide:true,stdio:['ignore','ignore','ignore'],shell:false});
    const exit=await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>{child.kill();reject(new Error('The actual update controller did not hand off in time.'));},120000);
      child.once('error',()=>{clearTimeout(timeout);reject(new Error('The actual update controller fixture could not start.'));});
      child.once('exit',code=>{clearTimeout(timeout);resolve(code);});
    });
    if(exit!==0) throw new Error('The actual update controller fixture failed.');
    handedOff=true;
    const evidence=JSON.parse(await fs.readFile(path.join(work,'controller-evidence.json'),'utf8'));
    if(evidence.engineClosed!==true || evidence.quitRequested!==true || evidence.targetVersion!==targetVersion) throw new Error('The native update handoff did not prove real engine closure.');
    const updateRoot=path.join(profile,'desktop-updates');
    let receipt,receiptDirectory;
    const deadline=Date.now()+180000;
    while(Date.now()<deadline) {
      const directories=(await fs.readdir(updateRoot,{withFileTypes:true})).filter(entry=>entry.isDirectory()&&!entry.isSymbolicLink()&&/^windows-[a-zA-Z0-9]+$/.test(entry.name));
      if(directories.length!==1) throw new Error('The native update helper has an unexpected operation inventory.');
      receiptDirectory=path.join(updateRoot,directories[0].name);
      try { receipt=JSON.parse(await fs.readFile(path.join(receiptDirectory,'receipt.json'),'utf8')); break; } catch(error) { if(error.code!=='ENOENT') throw error; }
      await pause(250);
    }
    if(receipt?.schema!==1 || receipt.phase!=='updated' || receipt.verified!==true || receipt.version!==targetVersion) throw new Error('The real MSI helper did not confirm the update.');
    const launchDeadline=Date.now()+30000;
    let relaunched=false,helperExited=false;
    while(Date.now()<launchDeadline) {
      if((await readOwnedProcesses(installed)).length>0) relaunched=true;
      if((await readExecutableProcesses(path.join(receiptDirectory,'node.exe'))).length===0) helperExited=true;
      if(relaunched&&helperExited) break;
      await pause(100);
    }
    if(!relaunched||!helperExited) throw new Error('The real helper did not finish and relaunch the installed application.');
    if((await appStatus(executable)).currentVersion!==targetVersion) throw new Error('The actual installed B executable reports the wrong version.');
    await assertSingleProduct(b);
    for(const filename of [path.join(profile,'native-update-preservation.txt'),path.join(media,'generated-media.txt')]) if(await fs.readFile(filename,'utf8')!==sentinel) throw new Error('The real update changed generated profile or media.');
    verified=true;
    // Stop only this fixture-owned installed executable and its subprocesses,
    // after the receipt and real B executable have both been verified.
    await stopOwnedApplication(installed);
    await pause(300);
    const {createEngine}=require(path.join(installed,'resources/app/dist/engine/engine.js'));
    const credentials={available:()=>false,encrypt:()=>{throw Error('fixture');},decrypt:()=>{throw Error('fixture');}};
    const engine=await createEngine({stateDirectory:profile,credentials,transport:async()=>{throw Error('No fixture account traffic.');}});
    try { const snapshot=await engine.getSnapshot();if(!snapshot.paused||snapshot.settings.parallelDownloads!==3||snapshot.settings.deleteAfterDownload!==false||snapshot.settings.deleteSourceFolders!==false)throw new Error('The updated real engine did not preserve pause and deletion choices.'); }
    finally { await engine.close(); }
    await msi(['/x',`{${b.productCode}}`]); installedByFixture=false;
    if(!await missing(executable) || await fs.readFile(path.join(profile,'native-update-preservation.txt'),'utf8')!==sentinel || await fs.readFile(path.join(media,'generated-media.txt'),'utf8')!==sentinel) throw new Error('Real application uninstall did not preserve generated user data.');
    console.log('Verified the actual Windows desktop controller, engine shutdown, detached helper, native MSI upgrade, installed B status and preserved generated data.');
    return {ok:true,arch,currentVersion,targetVersion,checks:['real-installed-a','real-controller','real-engine-closure','verified-msi-transfer','detached-helper','real-msi-upgrade','real-installed-b','real-relaunch','one-msi-owner','preserved-profile-media-and-pause']};
  } finally {
    if(child?.exitCode===null) child.kill();
    if(installedByFixture) {
      // A failed detached helper may still be installing. Preserve its operation
      // files until it exits or writes a controlled outcome; hosted CI discards
      // the machine if it cannot be safely recovered in this bounded window.
      if(handedOff) await pause(1000);
      const knownVersion=verified ? targetVersion : await appStatus(path.join(installed,'PutioManager.exe')).then(status=>status.currentVersion).catch(()=>undefined);
      if([currentVersion,targetVersion].includes(knownVersion)) {
        await stopOwnedApplication(installed).catch(()=>{});
        for(const identity of [b,a]) await msi(['/x',`{${identity.productCode}}`],[0,1605,1614]).catch(()=>{});
      }
    }
    // The preflight proved that these did not contain pre-existing user data.
    if(!installedByFixture) {
      for(const directory of [profile,work]) await fs.rm(directory,{recursive:true,force:true});
    }
  }
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(process.argv[2]==='--fixture-child' && process.argv.length===4) {
    await runUpdateChild(process.argv[3]).catch(()=>{console.error('The generated native update child failed.');process.exitCode=1;});
  } else if(process.argv.length===3 && process.argv[2]==='--disposable-ci') {
    await runNativeWindowsUpdateTest().catch(()=>{console.error('Actual Windows native updater verification failed. No private diagnostics were printed.');process.exitCode=1;});
  } else {console.error('Use --disposable-ci only on the disposable hosted repository runner.');process.exitCode=1;}
}
