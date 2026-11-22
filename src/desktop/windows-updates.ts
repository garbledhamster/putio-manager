import { promises as fs, constants } from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import os from 'node:os';
import {stableVersion, compareVersions} from './update-release';
import { DesktopUpdateFailure } from "./update-errors";
import { downloadUpdateAsset, privateUpdateDirectory, verifyUpdateFile } from "./update-transfer";
import { readWindowsInstallValue, validateWindowsUpdateJob, type WindowsUpdateJob } from "./update-windows-helper";
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
interface CacheFileIdentity {dev:number;ino:number}
interface TerminalWindowsReceipt {
  version:string;
  phase:'updated'|'failed'|'restart-required';
  errorCode?:DesktopUpdateError;
  bootTime?:number;
}
const windowsReceiptErrors:readonly DesktopUpdateError[]=['download-invalid','app-busy','installer-busy','installer-cancelled','installer-failed','restart-required'];
const sameCacheFile=(first:CacheFileIdentity,second:CacheFileIdentity)=>first.dev===second.dev&&first.ino===second.ino;
async function readCacheRecord(filename:string,limit:number):Promise<{value:unknown;time:number}>{
  const before=await fs.lstat(filename);
  if(!before.isFile()||before.isSymbolicLink()||before.size<1||before.size>limit)throw Error('download-invalid');
  const handle=await fs.open(filename,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{
    const opened=await handle.stat();
    if(!opened.isFile()||!sameCacheFile(before,opened)||opened.size!==before.size)throw Error('download-invalid');
    const bytes=Buffer.alloc(limit+1);
    let received=0;
    while(received<bytes.length){const chunk=await handle.read(bytes,received,bytes.length-received,null);if(!chunk.bytesRead)break;received+=chunk.bytesRead;}
    const after=await fs.lstat(filename);
    if(received!==before.size||!after.isFile()||after.isSymbolicLink()||!sameCacheFile(before,after)||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)throw Error('download-invalid');
    return{value:JSON.parse(bytes.subarray(0,received).toString('utf8')),time:before.mtimeMs};
  }finally{await handle.close();}
}
function terminalWindowsReceipt(value:unknown):TerminalWindowsReceipt|undefined{
  if(!value||typeof value!=='object'||Array.isArray(value))return;
  const receipt=value as Record<string,unknown>;
  if(receipt.schema!==1||!stableVersion(receipt.version))return;
  if(receipt.phase==='updated'&&receipt.verified===true)return{version:receipt.version,phase:'updated'};
  if(receipt.verified!==false)return;
  if(receipt.phase==='failed'&&windowsReceiptErrors.includes(receipt.errorCode as DesktopUpdateError))return{version:receipt.version,phase:'failed',errorCode:receipt.errorCode as DesktopUpdateError};
  if(receipt.phase==='restart-required'&&receipt.errorCode==='restart-required')return{version:receipt.version,phase:'restart-required',errorCode:'restart-required',bootTime:typeof receipt.bootTime==='number'&&Number.isFinite(receipt.bootTime)?receipt.bootTime:undefined};
}
async function cleanTerminalWindowsPayload(root:string,rootIdentity:CacheFileIdentity,directory:string,directoryIdentity:CacheFileIdentity,receipt:TerminalWindowsReceipt):Promise<void>{
  // A directory name or receipt alone does not establish ownership of payloads.
  const job=validateWindowsUpdateJob((await readCacheRecord(path.join(directory,'handoff.json'),16384)).value);
  const lock=await fs.lstat(path.join(directory,'handoff.lock'));
  if(job.targetVersion!==receipt.version||!lock.isFile()||lock.isSymbolicLink()||lock.nlink!==1)return;
  for(const name of['verified-update.msi','node.exe','apply-update.js']){
    try{
      const currentRoot=await fs.lstat(root),currentDirectory=await fs.lstat(directory);
      if(!currentRoot.isDirectory()||currentRoot.isSymbolicLink()||!sameCacheFile(rootIdentity,currentRoot)||await fs.realpath(root)!==root||!currentDirectory.isDirectory()||currentDirectory.isSymbolicLink()||!sameCacheFile(directoryIdentity,currentDirectory)||await fs.realpath(directory)!==directory||(process.platform!=='win32'&&(currentDirectory.mode&0o077)!==0))return;
      const filename=path.join(directory,name),before=await fs.lstat(filename);
      if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1)continue;
      const after=await fs.lstat(filename);
      if(after.isFile()&&!after.isSymbolicLink()&&sameCacheFile(before,after)&&after.nlink===1)await fs.unlink(filename);
    }catch{/* A mapped Node executable may remain locked until the helper exits. Retry next launch. */}
  }
  // Keep the receipt, job and lock: the helper may still be finishing its relaunch.
}
/** Controlled receipts are hints; the actual running application version remains authoritative. */
export async function readWindowsUpdateOutcome(userDataDirectory:string,currentVersion:string):Promise<{phase:'updated'|'failed'|'restart-required';errorCode?:DesktopUpdateError}|undefined>{
  if(!path.isAbsolute(userDataDirectory)||!stableVersion(currentVersion))return;
  const root=path.resolve(userDataDirectory,'desktop-updates');
  try{
    const rootInfo=await fs.lstat(root);
    if(!rootInfo.isDirectory()||rootInfo.isSymbolicLink()||await fs.realpath(root)!==root||(process.platform!=='win32'&&(rootInfo.mode&0o022)!==0))return;
    let latest:{receipt:TerminalWindowsReceipt;time:number;name:string}|undefined;
    // Scan all entries with constant retained memory; an arbitrary first-64
    // window could hide the newest receipt and strand old installer payloads.
    for await(const entry of await fs.opendir(root)){
      if(!entry.isDirectory()||entry.isSymbolicLink()||!/^windows-[a-zA-Z0-9]+$/.test(entry.name))continue;
      try{
        const directory=path.join(root,entry.name),info=await fs.lstat(directory);
        if(!info.isDirectory()||info.isSymbolicLink()||await fs.realpath(directory)!==directory)continue;
        const record=await readCacheRecord(path.join(directory,'receipt.json'),4096),receipt=terminalWindowsReceipt(record.value);
        if(!receipt)continue;
        await cleanTerminalWindowsPayload(root,rootInfo,directory,info,receipt).catch(()=>{});
        if(!latest||record.time>latest.time||record.time===latest.time&&entry.name>latest.name)latest={receipt,time:record.time,name:entry.name};
      }catch{/* Incomplete, changed and foreign cache records are not update evidence. */}
    }
    const receipt=latest?.receipt;
    if(!receipt||compareVersions(currentVersion,receipt.version)>0)return;
    if(receipt.phase==='updated')return receipt.version===currentVersion?{phase:'updated'}:undefined;
    if(receipt.phase==='restart-required'){
      const bootTime=Date.now()-os.uptime()*1000;
      if(receipt.bootTime!==undefined&&bootTime>receipt.bootTime+120000)return receipt.version===currentVersion?{phase:'updated'}:undefined;
      return{phase:'restart-required',errorCode:'restart-required'};
    }
    return{phase:'failed',errorCode:receipt.errorCode};
  }catch{}
}
