import {cp, mkdir, writeFile, lstat} from 'node:fs/promises';
import path from 'node:path';
const platform=process.platform, arch=process.arch;
if (!['win32','darwin','linux'].includes(platform) || !['x64','arm64'].includes(arch)) throw new Error('Unsupported build host.');
const out=path.join('release',`PutioManager-${platform}-${arch}-distribution`);
// Refuse an old output tree so a release cannot silently retain stale files.
try { await lstat(out); throw new Error('Distribution output already exists. Build in a clean checkout.'); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
await mkdir(path.join(out,'headless'),{recursive:true});
for (const name of ['core','engine','remote','server','shared.js']) await cp(path.join('dist',name),path.join(out,'headless',name),{recursive:true});
await cp(process.execPath,path.join(out,platform==='win32'?'node.exe':'node'));
// macOS frameworks contain relative links; keep them relative in the portable copy.
await cp(path.join('release',`PutioManager-${platform}-${arch}`),path.join(out,'desktop'),{recursive:true,verbatimSymlinks:true});
await cp('README.md',path.join(out,'README.md'));
await cp('docs/images',path.join(out,'docs','images'),{recursive:true});
await cp('LICENSE',path.join(out,'LICENSE-PutioManager.txt'));
// Fetch the license from the exact source tag of the Node executable bundled above.
const nodeLicenseUrl = `https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`;
const nodeLicense = await fetch(nodeLicenseUrl);
if (!nodeLicense.ok) throw new Error(`Could not retrieve the bundled Node ${process.version} license.`);
const nodeLicenseText = await nodeLicense.text();
if (!nodeLicenseText.includes('Node.js')) throw new Error('Unexpected Node license response.');
await writeFile(path.join(out,'LICENSE-Node.txt'), nodeLicenseText);
await writeFile(path.join(out,'NODE-PROVENANCE.txt'), `Bundled Node ${process.version}; source license: ${nodeLicenseUrl}\n`);
await writeFile(path.join(out,'launch.cjs'),`const {spawn}=require('node:child_process'); const path=require('node:path'); const args=process.argv.slice(2); let mode; if(args[0]==='--mode'){mode=args[1];args.splice(0,2)} if(!mode) mode=process.platform==='linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY?'headless':'gui'; if(!['gui','headless'].includes(mode)){console.error('Use --mode gui or --mode headless.');process.exit(1)} const gui=process.platform==='win32'?'desktop/PutioManager.exe':process.platform==='darwin'?'desktop/PutioManager.app/Contents/MacOS/PutioManager':'desktop/PutioManager'; const command=mode==='gui'?path.join(__dirname,gui):process.execPath; const child=spawn(command,mode==='gui'?args:[path.join(__dirname,'headless/server/cli.js'),...args],{stdio:'inherit'});child.on('error',()=>{console.error('Could not launch selected mode.');process.exitCode=1});child.on('exit',(code)=>{process.exitCode=code??1});`);
await writeFile(path.join(out,'launch.cmd'),'@echo off\r\n"%~dp0node.exe" "%~dp0launch.cjs" %*\r\n');
await writeFile(path.join(out,'launch'),'#!/bin/sh\nexec "$(dirname "$0")/node" "$(dirname "$0")/launch.cjs" "$@"\n',{mode:0o755});
