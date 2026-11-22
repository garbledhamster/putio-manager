// Standalone helper: copy the compiled file and Node runtime outside the installed app.
// Runtime imports must remain Node built-ins so MSI can replace every application file.
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import os from 'node:os';
const execute = promisify(execFile);
const version = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,4})$/.test(value) && value.split('.').every((v,i)=>Number(v)<=(i===2?65535:255));
export interface WindowsUpdateJob {
  schema: 1; targetVersion: string; currentVersion: string; arch: "x64" | "arm64";
  parentPid: number; bytes: number; sha256: string; installDirectory: string; previousExecutable: string;
}
export interface WindowsInstallReceipt { schema: 1; version: string; phase: "updated" | "failed" | "restart-required"; errorCode?: string; verified: boolean; bootTime?:number }
export function windowsInstallerResult(code: number): "success" | "restart-required" | "installer-busy" | "installer-cancelled" | "installer-failed" {
  return code === 0 ? "success" : code === 3010 || code === 1641 ? "restart-required" : code === 1618 ? "installer-busy" : code === 1602 ? "installer-cancelled" : "installer-failed";
}
export function validateWindowsUpdateJob(input: unknown): WindowsUpdateJob {
  const job = input as WindowsUpdateJob;
  if (!job || typeof job !== "object" || Array.isArray(job) || job.schema !== 1 || !version(job.targetVersion) || !version(job.currentVersion) || !["x64", "arm64"].includes(job.arch) || !Number.isSafeInteger(job.parentPid) || job.parentPid <= 0 || !Number.isSafeInteger(job.bytes) || job.bytes <= 0 || job.bytes > 2 * 1024 ** 3 || !/^[a-f0-9]{64}$/.test(job.sha256) || typeof job.installDirectory !== "string" || !path.isAbsolute(job.installDirectory) || path.basename(job.installDirectory).toLowerCase() !== "putiomanager" || typeof job.previousExecutable !== "string" || !path.isAbsolute(job.previousExecutable) || path.basename(job.previousExecutable).toLowerCase() !== "putiomanager.exe") throw Error("download-invalid");
  const a=job.targetVersion.split('.').map(Number),b=job.currentVersion.split('.').map(Number);
  if(a[0]<b[0]||a[0]===b[0]&&(a[1]<b[1]||a[1]===b[1]&&a[2]<=b[2]))throw Error("release-invalid");
  return { schema:1,targetVersion:job.targetVersion,currentVersion:job.currentVersion,arch:job.arch,parentPid:job.parentPid,bytes:job.bytes,sha256:job.sha256,installDirectory:path.resolve(job.installDirectory),previousExecutable:path.resolve(job.previousExecutable) };
}
const systemExecutable=(name:"reg.exe"|"msiexec.exe")=>path.win32.join(process.env.SystemRoot||"C:\\Windows","System32",name);
export async function readWindowsInstallValue(arch: "x64" | "arm64", name: "InstalledVersion" | "InstallLocation" | "ProductCode"): Promise<string | undefined> {
  try {
    const result=await execute(systemExecutable("reg.exe"),["query",`HKCU\\Software\\PutioManager\\Installer\\application\\${arch}`,"/v",name,"/reg:64"],{windowsHide:true,timeout:5000,maxBuffer:16384});
    return result.stdout.split(/\r?\n/).map(line=>line.match(new RegExp(`^\\s*${name}\\s+REG_SZ\\s+(.+?)\\s*$`))?.[1]).find(Boolean);
  } catch {return undefined}
}
async function verifyInstaller(filename:string,job:WindowsUpdateJob):Promise<void>{
  const before=await fs.lstat(filename);
  if(!before.isFile()||before.isSymbolicLink()||before.size!==job.bytes)throw Error("download-invalid");
  const handle=await fs.open(filename,'r');
  try {
    const opened=await handle.stat();if(opened.dev!==before.dev||opened.ino!==before.ino||opened.size!==before.size)throw Error("download-invalid");
    const hash=createHash('sha256');for await(const chunk of handle.createReadStream({autoClose:false}))hash.update(chunk);
    const after=await fs.lstat(filename);
    if(after.isSymbolicLink()||after.dev!==before.dev||after.ino!==before.ino||after.size!==before.size||after.mtimeMs!==before.mtimeMs||hash.digest('hex')!==job.sha256)throw Error("download-invalid");
  } finally {await handle.close()}
}
async function waitForParent(pid:number):Promise<void>{
  if(pid===process.pid)throw Error("app-busy");
  const deadline=Date.now()+60000;
  while(Date.now()<deadline){try{process.kill(pid,0)}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return;throw Error('app-busy')};await new Promise(resolve=>setTimeout(resolve,100))}
  // Never terminate a process: a reused PID must only cause a controlled wait failure.
  throw Error('app-busy');
}
async function installMsi(filename:string,job:WindowsUpdateJob):Promise<number>{
  try{await execute(systemExecutable('msiexec.exe'),['/i',filename,'/qn','/norestart','REBOOT=ReallySuppress',`INSTALLFOLDER=${job.installDirectory}`],{windowsHide:true,timeout:30*60*1000,maxBuffer:65536});return 0}
  catch(error){const code=(error as {code?:unknown}).code;return typeof code==='number'?code:1603}
}
async function executableVersion(filename:string):Promise<string|undefined>{
  try{
    const output=await execute(filename,['--app-update','status'],{windowsHide:true,timeout:25000,maxBuffer:32768});
    const line=output.stdout.split(/\r?\n/).find(value=>value.startsWith('{"ok":'));
    const result=line?JSON.parse(line):undefined;
    return result?.ok===true&&version(result.value?.currentVersion)?result.value.currentVersion:undefined;
  }catch{return undefined}
}
export interface WindowsHelperDependencies {
  platform?:string;
  waitParent?(pid:number):Promise<void>;
  install?(filename:string,job:WindowsUpdateJob):Promise<number>;
  registry?(arch:"x64"|"arm64",name:"InstalledVersion"|"InstallLocation"|"ProductCode"):Promise<string|undefined>;
  verifyVersion?(filename:string):Promise<string|undefined>;
  relaunch?(filename:string):void;
  ready?():void;
}
export async function applyWindowsUpdate(jobFile:string,dependencies:WindowsHelperDependencies={}):Promise<WindowsInstallReceipt>{
  if((dependencies.platform??process.platform)!=='win32'||!path.isAbsolute(jobFile)||path.basename(jobFile)!=='handoff.json')throw Error('unsupported-installation');
  const directory=path.dirname(jobFile),info=await fs.lstat(directory),file=await fs.lstat(jobFile);
  if(!info.isDirectory()||info.isSymbolicLink()||!file.isFile()||file.isSymbolicLink()||file.size>16384||await fs.realpath(directory)!==path.resolve(directory))throw Error('download-invalid');
  const job=validateWindowsUpdateJob(JSON.parse(await fs.readFile(jobFile,'utf8')));
  const lock=await fs.open(path.join(directory,'handoff.lock'),'wx',0o600);await lock.close();
  const installer=path.join(directory,'verified-update.msi');
  const registry=dependencies.registry??readWindowsInstallValue;
  const launch=dependencies.relaunch??(filename=>{const child=spawn(filename,[],{detached:true,windowsHide:true,stdio:'ignore',shell:false});child.on('error',()=>{});child.unref()});
  let receipt:WindowsInstallReceipt={schema:1,version:job.targetVersion,phase:'failed',errorCode:'installer-failed',verified:false};
  const write=async()=>{receipt.bootTime=Date.now()-os.uptime()*1000;const temporary=path.join(directory,`receipt-${randomUUID()}.tmp`);await fs.writeFile(temporary,JSON.stringify(receipt)+'\n',{flag:'wx',mode:0o600});await fs.rename(temporary,path.join(directory,'receipt.json'))};
  try{
    await verifyInstaller(installer,job);
    dependencies.ready?.();
    await(dependencies.waitParent??waitForParent)(job.parentPid);
    await verifyInstaller(installer,job);
    const result=windowsInstallerResult(await(dependencies.install??installMsi)(installer,job));
    if(result==='restart-required'){receipt={schema:1,version:job.targetVersion,phase:'restart-required',errorCode:'restart-required',verified:false};await write();return receipt}
    if(result!=='success')throw Error(result);
    const actualVersion=await registry(job.arch,'InstalledVersion'),location=await registry(job.arch,'InstallLocation'),product=await registry(job.arch,'ProductCode');
    const executable=path.join(job.installDirectory,'PutioManager.exe');
    if(actualVersion!==job.targetVersion||!location||path.resolve(location).toLowerCase()!==job.installDirectory.toLowerCase()||!product||!/^\{[0-9a-f-]{36}\}$/i.test(product))throw Error('installer-failed');
    const installed=await fs.lstat(executable);
    if(!installed.isFile()||installed.isSymbolicLink()||await(dependencies.verifyVersion??executableVersion)(executable)!==job.targetVersion)throw Error('installer-failed');
    receipt={schema:1,version:job.targetVersion,phase:'updated',verified:true};await write();launch(executable);return receipt;
  }catch(error){
    const allowed=new Set(['download-invalid','app-busy','installer-busy','installer-cancelled','installer-failed']);
    const code=error instanceof Error&&allowed.has(error.message)?error.message:'installer-failed';
    receipt={schema:1,version:job.targetVersion,phase:'failed',errorCode:code,verified:false};await write();
    // Recover only the known previous application. Never launch an arbitrary receipt path.
    try{const previous=await fs.lstat(job.previousExecutable);if(previous.isFile()&&!previous.isSymbolicLink())launch(job.previousExecutable)}catch{}
    return receipt;
  }
}
if(require.main===module){
  process.stdout.on('error',()=>{});process.stderr.on('error',()=>{});
  const args=process.argv.slice(2);
  if(args.length!==2||args[0]!=='--job')process.exitCode=1;
  else void applyWindowsUpdate(args[1],{ready:()=>process.stdout.write('{"schema":1,"phase":"waiting-for-application"}\n')}).then(result=>{process.exitCode=result.phase==='updated'?0:1},()=>{process.exitCode=1});
}
