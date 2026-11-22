import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WIX_VERSION, installerAssetNames, getWindowsInstallerIdentity, createPayloadManifest, comparePayloadManifests, ensureWix, runTool, defaultInstallerOptions } from './build.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const normalizeGuid = value => String(value).replace(/[{}]/g,'').toUpperCase();
// Derived from the pinned v6.0.2 hyperlinkLicense stock payload group, bas_platform,
// BurnCommon data file constants and the unconditional generated Burn manifests.
export const WIX_BOOTSTRAPPER_FILES = Object.freeze(['BootstrapperApplicationData.xml','BootstrapperExtensionData.xml','logo.png','manifest.xml','thm.wxl','thm.xml','wixstdba.exe']);
export function validateBootstrapperInspection({inspection,identity,names}) {
  if (!Array.isArray(inspection.manifest) || !Array.isArray(inspection.application) || !Array.isArray(inspection.extension)) throw new Error('The generated bootstrapper manifests are invalid.');
  const manifest = inspection.manifest;
  const one = (elements,name) => { const found=elements.filter(element=>element.name===name); if(found.length!==1) throw new Error('Unexpected generated bootstrapper manifest element.'); return found[0].attributes; };
  if (one(manifest,'BurnManifest').EngineVersion?.split('.').slice(0,3).join('.') !== WIX_VERSION) throw new Error('The bootstrapper engine version differs from its pin.');
  const registration=one(manifest,'Registration');
  if(registration.Version!==identity.version || registration.PerMachine!=='no' || registration.ExecutableName!==names.exe) throw new Error('Bootstrapper registration differs from its expected identity.');
  const packages=manifest.filter(element=>element.parent==='Chain' && /Package$/.test(element.name));
  if(packages.length!==1 || packages[0].name!=='MsiPackage') throw new Error('Unexpected package in the bootstrapper chain.');
  const msi=packages[0].attributes;
  if(msi.Id!=='ApplicationMsi' || msi.Permanent!=='yes' || msi.PerMachine!=='no' || msi.Version!==identity.version || normalizeGuid(msi.ProductCode)!==identity.productCode || normalizeGuid(msi.UpgradeCode)!==identity.upgradeCode) throw new Error('The bootstrapper MSI servicing identity differs.');
  const payloads=manifest.filter(element=>element.name==='Payload' && element.parent==='UX').map(element=>element.attributes.FilePath).sort();
  if(JSON.stringify(payloads)!==JSON.stringify(WIX_BOOTSTRAPPER_FILES.filter(name=>name!=='manifest.xml').sort())) throw new Error('Unexpected bootstrapper UX resource.');
  const data=one(inspection.application,'WixBundleProperties');
  if(data.DisplayName!==identity.productName || data.PerMachine!=='no' || normalizeGuid(data.UpgradeCode)!==identity.bundleUpgradeCode) throw new Error('The bootstrapper UI identity differs.');
  const appPackage=one(inspection.application,'WixPackageProperties');
  if(appPackage.Package!=='ApplicationMsi' || appPackage.Permanent!=='yes' || appPackage.Version!==identity.version || normalizeGuid(appPackage.ProductCode)!==identity.productCode) throw new Error('The bootstrapper UI package differs.');
  if(manifest.some(element=>['ExePackage','BundlePackage','MspPackage','BootstrapperExtension','ApprovedExeForElevation','Update'].includes(element.name) || element.attributes.DownloadUrl || element.name==='MsiProperty' && element.attributes.Id==='ARPSYSTEMCOMPONENT' && element.attributes.Value==='1')) throw new Error('The bootstrapper adds an unexpected executable, download or hidden MSI.');
  if(inspection.extension.length!==1 || inspection.extension[0].name!=='BootstrapperExtensionData') throw new Error('Unexpected bootstrapper extension metadata.');
  return true;
}
function verifyPeArchitecture(bytes,arch) {
  if(bytes.length<64 || bytes.toString('ascii',0,2)!=='MZ') throw new Error('Invalid native bootstrapper executable.');
  const offset=bytes.readUInt32LE(0x3c);
  if(offset>bytes.length-6 || bytes.readUInt32LE(offset)!==0x4550 || bytes.readUInt16LE(offset+4)!==(arch==='x64'?0x8664:0xaa64)) throw new Error('The bootstrapper executable architecture is incorrect.');
}
export function validateMsiInspection({inspection,identity,expectedManifest,fixture}) {
  const p = inspection.properties;
  if (!p || p.ProductVersion !== identity.version || normalizeGuid(p.ProductCode) !== identity.productCode || normalizeGuid(p.UpgradeCode) !== identity.upgradeCode || p.ProductName !== identity.productName || p.Manufacturer !== 'Putio Manager' || p.ALLUSERS || p.REBOOT !== 'ReallySuppress') throw new Error('Installer product identity or per-user scope is invalid.');
  if (!String(inspection.template).startsWith(identity.arch === 'x64' ? 'x64;' : 'Arm64;')) throw new Error('The MSI architecture is incorrect.');
  const actions = inspection.actions || {};
  if (!(Number.isInteger(actions.RemoveExistingProducts) && actions.RemoveExistingProducts > actions.InstallInitialize && actions.RemoveExistingProducts < actions.ProcessComponents)) throw new Error('The MSI major upgrade is outside its rollback transaction.');
  if (!(Number.isInteger(actions.AppSearch) && Number.isInteger(actions.LaunchConditions) && actions.AppSearch < actions.LaunchConditions && actions.LaunchConditions < actions.InstallInitialize)) throw new Error('Architecture validation must run before any install changes.');
  if (!Array.isArray(inspection.searches) || inspection.searches.length !== 1 || inspection.searches[0].root !== 1 || inspection.searches[0].key !== identity.oppositeRegistryKey || inspection.searches[0].name !== 'InstallLocation' || inspection.searches[0].type !== 18) throw new Error('The opposite architecture registry guard is invalid.');
  if (!Array.isArray(inspection.appSearch) || inspection.appSearch.length !== 1 || inspection.appSearch[0].property !== 'OPPOSITE_ARCH_INSTALL_LOCATION' || inspection.appSearch[0].signature !== inspection.searches[0].id) throw new Error('The opposite architecture search is not connected to its launch guard.');
  if (!Array.isArray(inspection.launchConditions) || !inspection.launchConditions.some(row=>row.condition === 'Installed OR NOT OPPOSITE_ARCH_INSTALL_LOCATION')) throw new Error('The installer permits overlapping architecture installations.');
  if (!Array.isArray(inspection.upgrade) || inspection.upgrade.length < 2 || inspection.upgrade.some(row => normalizeGuid(row.code) !== identity.upgradeCode)) throw new Error('Installer upgrade family is invalid.');
  if (inspection.binaryCount !== 0) throw new Error('Unexpected executable MSI resources.');
  const custom = inspection.customActions;
  if (!Array.isArray(custom) || (fixture?.failAfterInstallFiles ? custom.length !== 1 || custom[0].id !== 'FixtureFail' || custom[0].type !== 19 || custom[0].target !== 'Generated fixture rollback' : custom.length !== 0)) throw new Error('Unexpected MSI custom action.');
  if (!Array.isArray(inspection.registry) || inspection.registry.length !== expectedManifest.length + 4 || inspection.registry.some(row => row.root !== 1 || !(row.key === identity.registryKey || row.key === `${identity.registryKey}\\Components`))) throw new Error('Installer registry resources exceed their per-user boundary.');
  for (const [name,value] of [['InstalledVersion',identity.version],['InstallLocation','[INSTALLFOLDER]'],['ProductCode','[ProductCode]']]) {
    const rows = inspection.registry.filter(row => row.name === name && row.key === identity.registryKey);
    if (rows.length !== 1 || rows[0].value !== value) throw new Error('The installer ownership marker is invalid.');
  }
  if (inspection.installDirectoryName !== identity.installDirectoryName || inspection.installDirectoryParent !== 'ProgramsDirectory' || inspection.programsDirectoryName !== 'Programs' || inspection.programsDirectoryParent !== 'LocalAppDataFolder') throw new Error('The installer writes outside its per-user program directory.');
  if (!Array.isArray(inspection.shortcuts) || inspection.shortcuts.length !== 1 || inspection.shortcuts[0].directory !== 'ApplicationMenu' || inspection.shortcuts[0].target !== '[INSTALLFOLDER]PutioManager.exe' || inspection.shortcuts[0].arguments || inspection.shortcuts[0].workingDirectory !== 'INSTALLFOLDER') throw new Error('Unexpected installer shortcut.');
  if (!Array.isArray(inspection.removals) || inspection.removals.length !== 1 || inspection.removals[0].filename || inspection.removals[0].directory !== 'ApplicationMenu' || inspection.removals[0].mode !== 2) throw new Error('The installer has unexpected file removal rules.');
  if (!Array.isArray(inspection.files)) throw new Error('Installer file manifest is missing.');
  comparePayloadManifests(expectedManifest,inspection.files);
  return true;
}
export async function ensureAuditHelper(toolsDirectory) {
  const directory = path.resolve(toolsDirectory || path.join(os.tmpdir(),'putio-wix-6.0.2-tools'));
  const output = path.join(directory,'audit-helper');
  const executable = path.join(output,'InstallerAudit.dll');
  // Build from this checkout; never reuse a helper compiled from older sources.
  await runTool('dotnet',['build',path.join(here,'audit-helper/InstallerAudit.csproj'),'--configuration','Release','--output',output,`-p:BaseIntermediateOutputPath=${path.join(directory,'audit-obj')}${path.sep}`,'--nologo']);
  return executable;
}
export async function inspectMsi({msi,outputDirectory,toolsDirectory,helper}) {
  const executable = helper || await ensureAuditHelper(toolsDirectory);
  await runTool('dotnet',[executable,path.resolve(msi),path.resolve(outputDirectory)]);
  const inspection = JSON.parse(await fs.readFile(path.join(outputDirectory,'inspection.json'),'utf8'));
  if (!inspection || typeof inspection !== 'object') throw new Error('Invalid read-only MSI audit response.');
  return inspection;
}
async function regularFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const item of await fs.readdir(directory,{withFileTypes:true})) {
      const filename = path.join(directory,item.name);
      if (item.isSymbolicLink()) throw new Error('Unexpected extracted installer link.');
      if (item.isDirectory()) await visit(filename);
      else if (item.isFile()) files.push(filename);
      else throw new Error('Unexpected extracted installer entry.');
    }
  }
  await visit(root); return files;
}
export async function auditWindowsInstallers({version,arch,appDirectory,outputDirectory,toolsDirectory,fixture,verifyPayload,verifyBootstrapper}) {
  if (process.platform !== 'win32') throw new Error('Read-only Windows installer auditing requires Windows.');
  const identity = getWindowsInstallerIdentity({version,arch,family:fixture?.family});
  const expectedManifest = await createPayloadManifest(appDirectory);
  const names = installerAssetNames(version,arch);
  const msi = path.resolve(outputDirectory,names.msi), exe = path.resolve(outputDirectory,names.exe);
  const work = await fs.mkdtemp(path.join(os.tmpdir(),'putio-installer-audit-'));
  let succeeded = false;
  try {
    const {executable} = await ensureWix(toolsDirectory);
    const containerDirectory = path.join(work,'bundle-containers');
    const bootstrapperDirectory = path.join(work,'bundle-bootstrapper');
    await runTool(executable,['burn','extract',exe,'-o',containerDirectory,'-oba',bootstrapperDirectory]);
    const bootstrapperFiles=(await regularFiles(bootstrapperDirectory)).map(filename=>path.relative(bootstrapperDirectory,filename).replaceAll('\\','/')).sort();
    if(JSON.stringify(bootstrapperFiles)!==JSON.stringify([...WIX_BOOTSTRAPPER_FILES].sort())) throw new Error('The bootstrapper contains unexpected resources.');
    verifyPeArchitecture(await fs.readFile(exe),arch);
    verifyPeArchitecture(await fs.readFile(path.join(bootstrapperDirectory,'wixstdba.exe')),arch);
    const containerFiles = await regularFiles(containerDirectory);
    if (containerFiles.length !== 1 || path.extname(containerFiles[0]).toLowerCase() !== '.msi') throw new Error('The bootstrapper must contain exactly one MSI.');
    const msiBytes = await fs.readFile(msi), embedded = await fs.readFile(containerFiles[0]);
    if (!msiBytes.equals(embedded)) throw new Error('The bootstrapper embeds a different MSI.');
    const helper = await ensureAuditHelper(toolsDirectory);
    const bundleInspectionFile=path.join(work,'bundle-inspection.json');
    await runTool('dotnet',[helper,'--bootstrapper',bootstrapperDirectory,bundleInspectionFile]);
    validateBootstrapperInspection({inspection:JSON.parse(await fs.readFile(bundleInspectionFile,'utf8')),identity,names});
    if(verifyBootstrapper) await verifyBootstrapper(bootstrapperDirectory,WIX_BOOTSTRAPPER_FILES);
    const inspection = await inspectMsi({msi,outputDirectory:path.join(work,'msi'),toolsDirectory,helper});
    validateMsiInspection({inspection,identity,expectedManifest,fixture});
    const payloadDirectory = path.join(work,'application');
    await fs.mkdir(payloadDirectory);
    for (const file of inspection.files) {
      const source = path.resolve(file.source), sourceRoot = path.resolve(work,'msi','files');
      if (!source.startsWith(`${sourceRoot}${path.sep}`)) throw new Error('Extracted MSI source escaped its audit directory.');
      const target = path.join(payloadDirectory,file.path);
      await fs.mkdir(path.dirname(target),{recursive:true});
      await fs.copyFile(source,target);
    }
    comparePayloadManifests(expectedManifest,await createPayloadManifest(payloadDirectory));
    if (verifyPayload) await verifyPayload(payloadDirectory);
    succeeded = true;
    return {ok:true,payloadDirectory,bootstrapperDirectory,containerDirectory,identity,files:expectedManifest.length,msiSha256:digest(msiBytes),exeSha256:digest(await fs.readFile(exe)),cleanup:() => fs.rm(work,{recursive:true,force:true})};
  } finally { if (!succeeded) await fs.rm(work,{recursive:true,force:true}); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const {verifyRelease} = await import('../verify-public-release.mjs');
    const result = await auditWindowsInstallers({...await defaultInstallerOptions(),verifyBootstrapper:async (directory,expectedPaths) => {
      const audit=await verifyRelease('installer-resources',directory,{expectedPaths});
      if(!audit.ok) throw new Error('The extracted bootstrapper resources failed their privacy audit.');
    },verifyPayload:async directory => {
      const audit = await verifyRelease('app',directory,{platform:'win32'});
      if (!audit.ok) throw new Error('The extracted application failed its privacy audit.');
    }});
    await result.cleanup();
    console.log('Verified exact Windows installer identity, payload and embedded MSI.');
  } catch { console.error('Windows installer audit failed. No private diagnostics were printed.'); process.exitCode=1; }
}
