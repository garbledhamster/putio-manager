import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const WIX_VERSION = '6.0.2';
export const WIX_SOURCE_COMMIT = 'b3f340393117094a75ea8ced77f2357e4aa095e7';
export const WIX_SOURCE_URL = `https://codeload.github.com/wixtoolset/wix/tar.gz/${WIX_SOURCE_COMMIT}`;
export const WIX_SOURCE_ASSET = 'PutioManager-WiX-6.0.2-source.tar.gz';
const here = path.dirname(fileURLToPath(import.meta.url));
const privateSegment = /^(?:user-data|userdata|private-profile|runtime-state|\.git|\.aws|\.ssh|\.codex|project-context)$/i;
const privateFile = /^(?:settings\.json|engine-state\.json|remote-client\.json|server-config\.json|cookies|login data|local state|preferences|\.env(?:\..*)?)$/i;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const xml = value => String(value).replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[character]));
function guid(value) {
  const bytes = createHash('sha256').update(`putio-manager.windows-installer.v1:${value}`).digest().subarray(0,16);
  bytes[6] = (bytes[6] & 15) | 0x50;
  bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = bytes.toString('hex').toUpperCase();
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
function checkedVersion(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('A stable three-field installer version is required.');
  const values = version.split('.').map(Number);
  if (values.some((value,index) => !Number.isSafeInteger(value) || value > [255,255,65535][index])) throw new Error('The version exceeds Windows Installer limits.');
  return version;
}
function checkedArch(arch) { if (!['x64','arm64'].includes(arch)) throw new Error('Unsupported installer architecture.'); return arch; }
function checkedFamily(family = 'application') {
  if (!/^[a-z][a-z0-9-]{0,70}$/.test(family)) throw new Error('Invalid installer family.');
  return family;
}
export function getWindowsInstallerIdentity({version,arch,family}) {
  checkedVersion(version); checkedArch(arch); family = checkedFamily(family);
  const fixture = family !== 'application';
  return {
    version, arch, family,
    upgradeCode:guid(`${family}:${arch}:upgrade`),
    productCode:guid(`${family}:${arch}:product:${version}`),
    bundleUpgradeCode:guid(`${family}:${arch}:bootstrap`),
    installDirectoryName:fixture ? `PutioManagerFixture-${hash(family).slice(0,12)}` : 'PutioManager',
    registryKey:`Software\\PutioManager\\Installer\\${family}\\${arch}`,
    oppositeRegistryKey:`Software\\PutioManager\\Installer\\${family}\\${arch === 'x64' ? 'arm64' : 'x64'}`,
    productName:fixture ? `Putio Manager Fixture ${hash(family).slice(0,12)}` : 'Putio Manager',
  };
}
export function installerAssetNames(version,arch) {
  checkedVersion(version); checkedArch(arch);
  const base = `PutioManager-${version}-windows-${arch}-setup`;
  return {exe:`${base}.exe`,msi:`${base}.msi`};
}
function checkedRelative(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.startsWith('/') || /[:\u0000-\u001f]/.test(name)) throw new Error('Unsafe installer payload path.');
  for (const segment of name.split('/')) {
    if (!segment || ['.','..'].includes(segment) || /[. ]$/.test(segment) || /[<>"|?*]/.test(segment) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)) throw new Error('Unsafe Windows payload name.');
    if (privateSegment.test(segment) || privateFile.test(segment)) throw new Error('Private runtime data cannot enter an installer.');
  }
  return name;
}
function checkedFiles(files) {
  const result = files.map(checkedRelative).sort();
  if (!result.includes('PutioManager.exe') || new Set(result.map(value => value.toLowerCase())).size !== result.length) throw new Error('The payload must contain one unambiguous application executable.');
  return result;
}
const identifier = (prefix,value) => `${prefix}_${hash(value).slice(0,28)}`;
export function generateWindowsInstallerSources({version,arch,files,fixture}) {
  const identity = getWindowsInstallerIdentity({version,arch,family:fixture?.family});
  if (fixture?.failAfterInstallFiles && identity.family === 'application') throw new Error('Fault injection requires a separate fixture family.');
  files = checkedFiles(files);
  const directories = new Set();
  for (const filename of files) {
    let directory = path.posix.dirname(filename);
    while (directory !== '.') { directories.add(directory); directory = path.posix.dirname(directory); }
  }
  const directoryId = directory => directory === '.' ? 'INSTALLFOLDER' : identifier('Directory',directory);
  const directoryXml = [...directories].sort().map(directory => `<DirectoryRef Id="${directoryId(path.posix.dirname(directory))}"><Directory Id="${directoryId(directory)}" Name="${xml(path.posix.basename(directory))}" /></DirectoryRef>`).join('\n');
  const components = files.map(filename => {
    const id = identifier('Component',filename);
    return `<Component Id="${id}" Directory="${directoryId(path.posix.dirname(filename))}" Guid="${guid(`${identity.family}:${arch}:component:${filename.toLowerCase()}`)}" Bitness="always64">
  <File Id="${identifier('File',filename)}" Source="$(var.PayloadDirectory)\\${xml(filename.replaceAll('/','\\'))}" Name="${xml(path.posix.basename(filename))}" KeyPath="no" />
  <RegistryValue Root="HKCU" Key="${xml(identity.registryKey)}\\Components" Name="${id}" Type="integer" Value="1" KeyPath="yes" />
</Component>`;
  }).join('\n');
  const payloadXml = `<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs"><Fragment>${directoryXml}</Fragment><Fragment><ComponentGroup Id="ApplicationPayload">${components}</ComponentGroup></Fragment></Wix>\n`;
  const fault = fixture?.failAfterInstallFiles ? '<CustomAction Id="FixtureFail" Error="Generated fixture rollback" /><InstallExecuteSequence><Custom Action="FixtureFail" After="InstallFiles" Condition="NOT REMOVE" /></InstallExecuteSequence>' : '';
  const packageXml = `<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs"><Package Name="${xml(identity.productName)}" Manufacturer="Putio Manager" Version="${version}" ProductCode="${identity.productCode}" UpgradeCode="${identity.upgradeCode}" Scope="perUser" InstallerVersion="500" Compressed="yes">
<MajorUpgrade Schedule="afterInstallInitialize" DowngradeErrorMessage="A newer version of Putio Manager is installed." />
<MediaTemplate EmbedCab="yes" />
<Property Id="REBOOT" Value="ReallySuppress" />
<Property Id="OPPOSITE_ARCH_INSTALL_LOCATION"><RegistrySearch Id="OppositeArchitectureInstallLocation" Root="HKCU" Key="${xml(identity.oppositeRegistryKey)}" Name="InstallLocation" Type="raw" Bitness="always64" /></Property>
<Launch Condition="Installed OR NOT OPPOSITE_ARCH_INSTALL_LOCATION" Message="Another Windows architecture of Putio Manager is installed. Uninstall that edition before installing this one. Your saved settings and downloads are preserved." />
<InstallExecuteSequence><AppSearch Sequence="50" /><LaunchConditions Sequence="100" /></InstallExecuteSequence>
<StandardDirectory Id="LocalAppDataFolder"><Directory Id="ProgramsDirectory" Name="Programs"><Directory Id="INSTALLFOLDER" Name="${identity.installDirectoryName}" /></Directory></StandardDirectory>
<StandardDirectory Id="ProgramMenuFolder"><Directory Id="ApplicationMenu" Name="${xml(identity.productName)}" /></StandardDirectory>
<Component Id="ApplicationShortcut" Directory="ApplicationMenu" Guid="${guid(`${identity.family}:${arch}:shortcut`)}" Bitness="always64">
<Shortcut Id="StartMenuShortcut" Name="${xml(identity.productName)}" Target="[INSTALLFOLDER]PutioManager.exe" WorkingDirectory="INSTALLFOLDER" />
<RemoveFolder Id="RemoveApplicationMenu" On="uninstall" />
<RegistryValue Root="HKCU" Key="${xml(identity.registryKey)}" Name="Shortcut" Type="integer" Value="1" KeyPath="yes" />
</Component>
<Component Id="InstallationIdentity" Directory="INSTALLFOLDER" Guid="${guid(`${identity.family}:${arch}:installation-identity`)}" Bitness="always64">
<RegistryValue Root="HKCU" Key="${xml(identity.registryKey)}" Name="InstalledVersion" Type="string" Value="${version}" KeyPath="yes" />
<RegistryValue Root="HKCU" Key="${xml(identity.registryKey)}" Name="InstallLocation" Type="string" Value="[INSTALLFOLDER]" />
<RegistryValue Root="HKCU" Key="${xml(identity.registryKey)}" Name="ProductCode" Type="string" Value="[ProductCode]" />
</Component>
<Feature Id="Application" Title="Putio Manager" Level="1"><ComponentGroupRef Id="ApplicationPayload" /><ComponentRef Id="ApplicationShortcut" /><ComponentRef Id="InstallationIdentity" /></Feature>${fault}
</Package></Wix>\n`;
  const bundleXml = `<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs" xmlns:bal="http://wixtoolset.org/schemas/v4/wxs/bal"><Bundle Name="${xml(identity.productName)}" Manufacturer="Putio Manager" Version="${version}" UpgradeCode="${identity.bundleUpgradeCode}" Compressed="yes">
<BootstrapperApplication><bal:WixStandardBootstrapperApplication Theme="hyperlinkLicense" LicenseUrl="https://github.com/garbledhamster/putio-manager/blob/main/LICENSE" /></BootstrapperApplication>
<Chain><MsiPackage Id="ApplicationMsi" SourceFile="$(var.MsiPath)" Compressed="yes" Permanent="yes" Visible="yes" /></Chain>
</Bundle></Wix>\n`;
  return {identity,packageXml,payloadXml,bundleXml};
}

export async function createPayloadManifest(directory) {
  const root = await fs.realpath(directory), entries = [];
  async function visit(relative) {
    for (const item of await fs.readdir(path.join(root,relative),{withFileTypes:true})) {
      const name = relative ? `${relative}/${item.name}` : item.name;
      checkedRelative(name);
      if (item.isSymbolicLink()) throw new Error('Installer payload links are not permitted.');
      if (item.isDirectory()) await visit(name);
      else if (item.isFile()) { const bytes = await fs.readFile(path.join(root,name)); entries.push({path:name,size:bytes.length,sha256:hash(bytes)}); }
      else throw new Error('Unsupported installer payload entry.');
    }
  }
  await visit('');
  checkedFiles(entries.map(entry => entry.path));
  return entries.sort((a,b) => a.path.localeCompare(b.path,'en'));
}
export function comparePayloadManifests(expected,actual) {
  const normalize = entries => [...entries].map(({path:filename,size,sha256}) => ({path:checkedRelative(filename),size,sha256})).sort((a,b) => a.path.localeCompare(b.path,'en'));
  if (JSON.stringify(normalize(expected)) !== JSON.stringify(normalize(actual))) throw new Error('The installer payload differs from the verified application.');
}
async function writeIdenticalOrNew(filename,bytes) {
  let ancestor = path.dirname(filename);
  while (ancestor !== path.dirname(ancestor)) {
    try { if ((await fs.lstat(ancestor)).isSymbolicLink()) throw new Error('Runtime resource paths cannot contain links.'); }
    catch(error) { if (error.code !== 'ENOENT') throw error; }
    ancestor = path.dirname(ancestor);
  }
  await fs.mkdir(path.dirname(filename),{recursive:true});
  try { if ((await fs.lstat(filename)).isSymbolicLink()) throw new Error('Runtime resources cannot be links.'); } catch(error) { if (error.code !== 'ENOENT') throw error; }
  try { await fs.writeFile(filename,bytes,{flag:'wx'}); }
  catch(error) { if (error.code !== 'EEXIST' || !(await fs.readFile(filename)).equals(Buffer.from(bytes))) throw new Error('Existing installer runtime resource differs from its expected source.'); }
}
export async function stageWindowsUpdateRuntime(appDirectory, options = {}) {
  if (process.platform !== 'win32' && !options.fixture) throw new Error('The Windows update runtime must be staged on Windows.');
  const root = await fs.realpath(appDirectory);
  const runtime = options.nodeExecutable || process.execPath;
  const version = options.nodeVersion || process.version;
  if (!/^v\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid Node runtime provenance.');
  const licenseUrl = `https://raw.githubusercontent.com/nodejs/node/${version}/LICENSE`;
  let license = options.nodeLicenseText;
  if (!license) { const response = await fetch(licenseUrl); if (!response.ok) throw new Error('Could not retrieve the exact Node runtime license.'); license = await response.text(); }
  if (!license.includes('Node.js')) throw new Error('Invalid Node runtime license.');
  const bytes = await fs.readFile(runtime);
  await writeIdenticalOrNew(path.join(root,'resources/update-runtime/node.exe'),bytes);
  await writeIdenticalOrNew(path.join(root,'resources/update-runtime/LICENSE-Node.txt'),license);
  await writeIdenticalOrNew(path.join(root,'resources/update-runtime/NODE-PROVENANCE.json'),`${JSON.stringify({version,arch:options.arch||process.arch,sha256:hash(bytes),licenseUrl})}\n`);
  await writeIdenticalOrNew(path.join(root,'resources/installer-notices/LICENSE-WiX.txt'),await fs.readFile(path.join(here,'LICENSE-WiX.txt')));
  await writeIdenticalOrNew(path.join(root,'resources/installer-notices/WIX-SOURCE.txt'),`WiX Toolset ${WIX_VERSION}\nSource: ${WIX_SOURCE_URL}\nCorresponding source is distributed with each release as ${WIX_SOURCE_ASSET}.\nWiX components retain their Microsoft Reciprocal License; the application retains its own license.\n`);
  return {version,sha256:hash(bytes)};
}
export async function runTool(command,args,{cwd,env,allowExitCodes=[0],timeoutMs} = {}) {
  return await new Promise((resolve,reject) => {
    const child = spawn(command,args,{cwd,env:{...process.env,...env},windowsHide:true,stdio:['ignore','pipe','pipe']});
    const timeout=timeoutMs ? setTimeout(()=>child.kill(),timeoutMs) : undefined;
    let stdout = '', stderr = '', length = 0, exceeded = false;
    child.stdout.on('data',data => { length += data.length; if (length > 8*1024*1024) { exceeded = true; child.kill(); } else stdout += data.toString(); });
    child.stderr.on('data',data => { length += data.length; if (length > 8*1024*1024) { exceeded = true; child.kill(); } else stderr += data.toString(); });
    child.once('error',() => {clearTimeout(timeout);reject(new Error('A required installer build or audit tool could not start.'));});
    child.once('close',code => {
      clearTimeout(timeout);
      if (!exceeded && allowExitCodes.includes(code)) { resolve({code,stdout}); return; }
      const codes = [...new Set(`${stdout}\n${stderr}`.match(/\b(?:WIX\d{4}|CS\d{4}|NU\d{4}|NETSDK\d{4})\b/g) || [])].slice(0,12);
      reject(new Error(`An installer build or audit tool failed.${codes.length ? ` Tool codes: ${codes.join(', ')}.` : ''}`));
    });
  });
}
export async function ensureWix(toolsDirectory) {
  const toolRoot = path.resolve(toolsDirectory || path.join(os.tmpdir(),'putio-wix-6.0.2-tools'));
  const executable = path.join(toolRoot,'wix.exe');
  try { await fs.access(executable); }
  catch { await fs.mkdir(toolRoot,{recursive:true}); await runTool('dotnet',['tool','install','wix','--tool-path',toolRoot,'--version',WIX_VERSION]); }
  const version = await runTool(executable,['--version']);
  if (!version.stdout.trim().startsWith(`${WIX_VERSION}+`) && version.stdout.trim() !== WIX_VERSION) throw new Error('The installer tool version differs from the pinned version.');
  await runTool(executable,['extension','add',`WixToolset.BootstrapperApplications.wixext/${WIX_VERSION}`],{cwd:toolRoot});
  return {executable,toolRoot};
}
export async function buildWindowsInstallers({version,arch,appDirectory,outputDirectory,toolsDirectory,fixture}) {
  if (process.platform !== 'win32') throw new Error('Windows installers require a native Windows build host.');
  checkedVersion(version); checkedArch(arch);
  if (arch !== process.arch) throw new Error('The installer architecture must match its native build host.');
  const names = installerAssetNames(version,arch);
  const appRoot = await fs.realpath(appDirectory);
  await stageWindowsUpdateRuntime(appRoot);
  const payloadManifest = await createPayloadManifest(appRoot);
  const sources = generateWindowsInstallerSources({version,arch,files:payloadManifest.map(entry => entry.path),fixture});
  const outputRoot = path.resolve(outputDirectory);
  await fs.mkdir(outputRoot,{recursive:true});
  for (const name of Object.values(names)) { try { await fs.lstat(path.join(outputRoot,name)); throw new Error('Installer output already exists.'); } catch(error) { if (error.code !== 'ENOENT') throw error; } }
  const work = await fs.mkdtemp(path.join(os.tmpdir(),'putio-installer-build-'));
  try {
    for (const [name,content] of [['Package.wxs',sources.packageXml],['Payload.wxs',sources.payloadXml],['Bundle.wxs',sources.bundleXml]]) await fs.writeFile(path.join(work,name),content);
    const {executable,toolRoot} = await ensureWix(toolsDirectory);
    const msi = path.join(outputRoot,names.msi), exe = path.join(outputRoot,names.exe);
    await runTool(executable,['build',path.join(work,'Package.wxs'),path.join(work,'Payload.wxs'),'-arch',arch,'-d',`PayloadDirectory=${appRoot}`,'-intermediateFolder',path.join(work,'msi'),'-o',msi]);
    await runTool(executable,['build',path.join(work,'Bundle.wxs'),'-arch',arch,'-ext',`WixToolset.BootstrapperApplications.wixext/${WIX_VERSION}`,'-d',`MsiPath=${msi}`,'-intermediateFolder',path.join(work,'bundle'),'-o',exe],{cwd:toolRoot});
    // PDBs contain build paths and are not publication assets.
    for (const filename of [msi,exe]) await fs.rm(filename.replace(/\.(msi|exe)$/i,'.wixpdb'),{force:true});
    return {msi,exe,identity:sources.identity,payloadManifest};
  } finally { await fs.rm(work,{recursive:true,force:true}); }
}
export async function defaultInstallerOptions() {
  const {version} = JSON.parse(await fs.readFile('package.json','utf8'));
  return {version,arch:process.arch,appDirectory:path.resolve('release',`PutioManager-win32-${process.arch}`),outputDirectory:path.resolve('release-assets')};
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildWindowsInstallers(await defaultInstallerOptions()).then(() => console.log('Built the Windows MSI and matching bootstrapper.')).catch(error => { const codes=String(error.message).match(/\b(?:WIX\d{4}|CS\d{4}|NU\d{4}|NETSDK\d{4})\b/g)||[]; console.error(`Windows installer build failed.${codes.length ? ` Tool codes: ${codes.join(', ')}.` : ''} No private diagnostics were printed.`); process.exitCode=1; });
}
