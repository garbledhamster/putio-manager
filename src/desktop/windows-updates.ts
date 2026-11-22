import { promises as fs, constants } from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import os from 'node:os';
import {stableVersion, compareVersions} from './update-release';
import { DesktopUpdateFailure } from "./update-errors";
import { downloadUpdateAsset, privateUpdateDirectory, verifyUpdateFile } from "./update-transfer";
import { readWindowsInstallValue, type WindowsUpdateJob } from "./update-windows-helper";
import type { DesktopUpdateAdapter, NativeUpdateContext, PreparedDesktopUpdate, VerifiedDesktopRelease, DesktopUpdateError } from "./update-types";

export function createWindowsUpdateAdapter(context:NativeUpdateContext):DesktopUpdateAdapter{
  const operations=new Map<string,{prepared:PreparedDesktopUpdate;directory:string;installer:string;release:VerifiedDesktopRelease}>();
  let activeDirectory:string|undefined,handedOff=false;
  const runtime=path.join(context.resourcesDirectory,'update-runtime','node.exe');
  const supported=context.platform==='win32'&&context.isPackaged&&['x64','arm64'].includes(context.arch);
  return{
    supported,
    async prepare(release,signal,progress){
      if(!supported)throw new DesktopUpdateFailure('unsupported-installation');
      if(activeDirectory||handedOff)throw new DesktopUpdateFailure('app-busy');
      if(release.platform!=='windows'||release.arch!==context.arch||release.asset.name!==`PutioManager-${release.version}-windows-${context.arch}-setup.msi`)throw new DesktopUpdateFailure('release-invalid');
      const runtimeInfo=await fs.lstat(runtime);
      if(!runtimeInfo.isFile()||runtimeInfo.isSymbolicLink())throw new DesktopUpdateFailure('unsupported-installation');
      activeDirectory=await privateUpdateDirectory(context.userDataDirectory,'windows-');
      const installer=await downloadUpdateAsset(release.asset,activeDirectory,signal,percent=>progress({phase:'downloading',percent}));
      progress({phase:'verifying'});await verifyUpdateFile(installer,release.asset,signal);
      const prepared={version:release.version,id:randomUUID()};operations.set(prepared.id,{prepared,directory:activeDirectory,installer,release});progress({phase:'ready',percent:100});return prepared;
    },
    async handoff(prepared){
      const operation=operations.get(prepared.id);
      if(!operation||operation.prepared.version!==prepared.version||handedOff)throw new DesktopUpdateFailure('download-invalid');
      await verifyUpdateFile(operation.installer,operation.release.asset);
      const arch=context.arch as 'x64'|'arm64';
      const registered=await readWindowsInstallValue(arch,'InstallLocation');
      const fallback=process.env.LOCALAPPDATA?path.join(process.env.LOCALAPPDATA,'Programs','PutioManager'):undefined;
      const installDirectory=registered&&path.isAbsolute(registered)&&path.basename(path.resolve(registered)).toLowerCase()==='putiomanager'?path.resolve(registered):fallback;
      if(!installDirectory)throw new DesktopUpdateFailure('storage-unavailable');
      const helperSource=path.join(__dirname,'update-windows-helper.js'),helper=path.join(operation.directory,'apply-update.js'),node=path.join(operation.directory,'node.exe');
      await fs.copyFile(helperSource,helper,constants.COPYFILE_EXCL);await fs.copyFile(runtime,node,constants.COPYFILE_EXCL);
      for(const [source,copy]of[[helperSource,helper],[runtime,node]])if(createHash('sha256').update(await fs.readFile(source)).digest('hex')!==createHash('sha256').update(await fs.readFile(copy)).digest('hex'))throw new DesktopUpdateFailure('download-invalid');
      const job:WindowsUpdateJob={schema:1,targetVersion:prepared.version,currentVersion:context.currentVersion,arch,parentPid:process.pid,bytes:operation.release.asset.bytes,sha256:operation.release.asset.sha256,installDirectory,previousExecutable:context.executablePath};
      const jobFile=path.join(operation.directory,'handoff.json');await fs.writeFile(jobFile,JSON.stringify(job)+'\n',{flag:'wx',mode:0o600});
      await new Promise<void>((resolve,reject)=>{
        const child=spawn(node,[helper,'--job',jobFile],{detached:true,windowsHide:true,stdio:['ignore','pipe','pipe'],shell:false});
        let buffer='',settled=false;
        const finish=(ok:boolean)=>{if(settled)return;settled=true;clearTimeout(timeout);if(ok){handedOff=true;child.unref();resolve()}else{child.kill();reject(new DesktopUpdateFailure('installer-failed'))}};
        const timeout=setTimeout(()=>finish(false),30000);
        child.stdout?.on('data',chunk=>{buffer+=String(chunk);if(buffer.length>16384)return finish(false);if(buffer.split(/\r?\n/).some(line=>line==='{"schema":1,"phase":"waiting-for-application"}'))finish(true)});
        child.stderr?.on('data',()=>{});child.on('error',()=>finish(false));child.on('exit',()=>finish(false));
      });
      context.quitApplication();
    },
    async cancel(){
      if(handedOff)return;
      operations.clear();
      if(activeDirectory){
        const directory=activeDirectory;activeDirectory=undefined;
        const root=path.resolve(context.userDataDirectory,'desktop-updates');
        if(path.dirname(directory)!==root||!path.basename(directory).startsWith('windows-'))return;
        const info=await fs.lstat(directory).catch(()=>undefined);
        if(!info?.isDirectory()||info.isSymbolicLink())return;
        for(const name of['verified-update.msi','apply-update.js','node.exe','handoff.json'])await fs.unlink(path.join(directory,name)).catch(()=>{});
        await fs.rmdir(directory).catch(()=>{});
      }
    }
  };
}
/** Controlled receipts are hints; the actual running application version remains authoritative. */
export async function readWindowsUpdateOutcome(userDataDirectory:string,currentVersion:string):Promise<{phase:'updated'|'failed'|'restart-required';errorCode?:DesktopUpdateError}|undefined>{
  const root=path.join(userDataDirectory,'desktop-updates');
  try{
    const names=(await fs.readdir(root,{withFileTypes:true})).filter(entry=>entry.isDirectory()&&!entry.isSymbolicLink()&&/^windows-[a-zA-Z0-9]+$/.test(entry.name)).slice(0,64);
    const items:{file:string;time:number}[]=[];
    for(const entry of names){const file=path.join(root,entry.name,'receipt.json'),info=await fs.lstat(file).catch(()=>undefined);if(info?.isFile()&&!info.isSymbolicLink()&&info.size<4096)items.push({file,time:info.mtimeMs})}
    items.sort((a,b)=>b.time-a.time);
    if(!items[0])return;
    const receipt=JSON.parse(await fs.readFile(items[0].file,'utf8'));
    if(receipt.schema!==1||!stableVersion(receipt.version)||!stableVersion(currentVersion))return;
    const retire=async()=>{await fs.unlink(items[0].file).catch(()=>{})};
    if(compareVersions(currentVersion,receipt.version)>0){await retire();return;}
    if(receipt.phase==='updated'&&receipt.verified===true&&receipt.version===currentVersion)return{phase:'updated'};
    const allowed:DesktopUpdateError[]=['download-invalid','app-busy','installer-busy','installer-cancelled','installer-failed','restart-required'];
    if(receipt.phase==='restart-required'){
      const bootTime=Date.now()-os.uptime()*1000;
      if(typeof receipt.bootTime==='number'&&Number.isFinite(receipt.bootTime)&&bootTime>receipt.bootTime+120000){await retire();return receipt.version===currentVersion?{phase:'updated'}:undefined;}
      return{phase:'restart-required',errorCode:'restart-required'};
    }
    if(receipt.phase==='failed'&&allowed.includes(receipt.errorCode))return{phase:'failed',errorCode:receipt.errorCode};
  }catch{}
}
