import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WIX_VERSION, installerAssetNames, getWindowsInstallerIdentity, createPayloadManifest, comparePayloadManifests, ensureWix, runTool, defaultInstallerOptions } from './build.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const normalizeGuid = value => String(value).replace(/[{}]/g,'').toUpperCase();
const auditStages = new Set(['application-manifest','toolchain','bundle-extraction','bundle-inventory','bundle-architecture','embedded-msi','audit-helper-build','bundle-xml-read','bundle-metadata','bundle-privacy','msi-read','msi-metadata','payload-reconstruction','payload-comparison','payload-privacy']);
const validationCodes = new Set(['bundle-schema','bundle-element-count','bundle-engine-version','bundle-registration','bundle-chain','bundle-msi-identity','bundle-ux-inventory','bundle-ui-identity','bundle-ui-package','bundle-extra-behavior','bundle-extension-data','msi-identity','msi-architecture','msi-upgrade-order','msi-guard-order','msi-guard-search','msi-guard-property','msi-guard-condition','msi-upgrade-family','msi-binary','msi-custom-actions','msi-registry','msi-owner-values','msi-directory','msi-shortcut','msi-removal','msi-files']);
class AuditValidationError extends Error {
  constructor(code) { super('Installer audit validation failed.'); this.auditCode=validationCodes.has(code)?code:'validation-failed'; }
}
class AuditStageError extends Error {
  constructor(stage,cause) {
    super('Installer audit stage failed.');
    this.auditStage=stage;
    this.auditCode=cause instanceof AuditValidationError?cause.auditCode:['ENOENT','EEXIST','EACCES','EPERM'].includes(cause?.code)?'file-unavailable':/An installer build or audit tool failed|A required installer build or audit tool could not start/.test(cause?.message||'')?'tool-failed':'validation-failed';
    this.toolCodes=[...new Set(String(cause?.message||'').match(/\b(?:WIX\d{4}|CS\d{4}|NU\d{4}|NETSDK\d{4}|DTF_(?:OPEN|PROPERTIES|DIRECTORIES|COMPONENTS|FILES|REGISTRY|SHORTCUTS|REMOVALS|CUSTOM_ACTIONS|UPGRADE|SEQUENCE|SEARCH|LAUNCH|MEDIA|EXTRACT|MANIFEST|BUNDLE_XML)_(?:MSI|INVALID|IO|UNEXPECTED))\b/g)||[])].slice(0,12);
  }
}
export async function auditStage(stage,operation) {
  if(!auditStages.has(stage)) throw new Error('Unknown installer audit stage.');
  try { return await operation(); } catch(error) { throw new AuditStageError(stage,error); }
}
export function auditFailureStatus(error) {
  return error instanceof AuditStageError ? {schema:1,stage:error.auditStage,code:error.auditCode,...(error.toolCodes.length?{toolCodes:error.toolCodes}:{})} : {schema:1,stage:'initialization',code:'audit-failed'};
}
const invalid = code => { throw new AuditValidationError(code); };
// Derived from the pinned v6.0.2 hyperlinkLicense stock payload group, bas_platform,
// BurnCommon data file constants and the unconditional generated Burn manifests.
export const WIX_BOOTSTRAPPER_FILES = Object.freeze(['BootstrapperApplicationData.xml','BootstrapperExtensionData.xml','logo.png','manifest.xml','thm.wxl','thm.xml','wixstdba.exe']);
export function validateBootstrapperInspection({inspection,identity,names}) {
  if (!Array.isArray(inspection.manifest) || !Array.isArray(inspection.application) || !Array.isArray(inspection.extension)) invalid('bundle-schema');
  const manifest = inspection.manifest;
  const one = (elements,name) => { const found=elements.filter(element=>element.name===name); if(found.length!==1) invalid('bundle-element-count'); return found[0].attributes; };
  if (one(manifest,'BurnManifest').EngineVersion?.split('.').slice(0,3).join('.') !== WIX_VERSION) invalid('bundle-engine-version');
  const registration=one(manifest,'Registration');
  if(registration.Version!==identity.version || registration.PerMachine!=='no' || registration.ExecutableName!==names.exe) invalid('bundle-registration');
  const packages=manifest.filter(element=>element.parent==='Chain' && /Package$/.test(element.name));
  if(packages.length!==1 || packages[0].name!=='MsiPackage') invalid('bundle-chain');
  const msi=packages[0].attributes;
  if(msi.Id!=='ApplicationMsi' || msi.Permanent!=='yes' || msi.PerMachine!=='no' || msi.Version!==identity.version || normalizeGuid(msi.ProductCode)!==identity.productCode || normalizeGuid(msi.UpgradeCode)!==identity.upgradeCode) invalid('bundle-msi-identity');
  const payloads=manifest.filter(element=>element.name==='Payload' && element.parent==='UX').map(element=>element.attributes.FilePath).sort();
  if(JSON.stringify(payloads)!==JSON.stringify(WIX_BOOTSTRAPPER_FILES.filter(name=>name!=='manifest.xml').sort())) invalid('bundle-ux-inventory');
  const data=one(inspection.application,'WixBundleProperties');
  if(data.DisplayName!==identity.productName || data.PerMachine!=='no' || normalizeGuid(data.UpgradeCode)!==identity.bundleUpgradeCode) invalid('bundle-ui-identity');
  const appPackage=one(inspection.application,'WixPackageProperties');
  if(appPackage.Package!=='ApplicationMsi' || appPackage.Permanent!=='yes' || appPackage.Version!==identity.version || normalizeGuid(appPackage.ProductCode)!==identity.productCode) invalid('bundle-ui-package');
  if(manifest.some(element=>['ExePackage','BundlePackage','MspPackage','BootstrapperExtension','ApprovedExeForElevation','Update'].includes(element.name) || element.attributes.DownloadUrl || element.name==='MsiProperty' && element.attributes.Id==='ARPSYSTEMCOMPONENT' && element.attributes.Value==='1')) invalid('bundle-extra-behavior');
  if(inspection.extension.length!==1 || inspection.extension[0].name!=='BootstrapperExtensionData') invalid('bundle-extension-data');
  return true;
}
function verifyPeArchitecture(bytes,arch) {
  if(bytes.length<64 || bytes.toString('ascii',0,2)!=='MZ') throw new Error('Invalid native bootstrapper executable.');
  const offset=bytes.readUInt32LE(0x3c);
  if(offset>bytes.length-6 || bytes.readUInt32LE(offset)!==0x4550 || bytes.readUInt16LE(offset+4)!==(arch==='x64'?0x8664:0xaa64)) throw new Error('The bootstrapper executable architecture is incorrect.');
}
export function validateMsiInspection({inspection,identity,expectedManifest,fixture}) {
  const p = inspection.properties;
  if (!p || p.ProductVersion !== identity.version || normalizeGuid(p.ProductCode) !== identity.productCode || normalizeGuid(p.UpgradeCode) !== identity.upgradeCode || p.ProductName !== identity.productName || p.Manufacturer !== 'Putio Manager' || p.ALLUSERS || p.REBOOT !== 'ReallySuppress') invalid('msi-identity');
  if (!String(inspection.template).startsWith(identity.arch === 'x64' ? 'x64;' : 'Arm64;')) invalid('msi-architecture');
  const actions = inspection.actions || {};
  if (!(Number.isInteger(actions.RemoveExistingProducts) && actions.RemoveExistingProducts > actions.InstallInitialize && actions.RemoveExistingProducts < actions.ProcessComponents)) invalid('msi-upgrade-order');
  if (!(Number.isInteger(actions.AppSearch) && Number.isInteger(actions.LaunchConditions) && actions.AppSearch < actions.LaunchConditions && actions.LaunchConditions < actions.InstallInitialize)) invalid('msi-guard-order');
  if (!Array.isArray(inspection.searches) || inspection.searches.length !== 1 || inspection.searches[0].root !== 1 || inspection.searches[0].key !== identity.oppositeRegistryKey || inspection.searches[0].name !== 'InstallLocation' || inspection.searches[0].type !== 18) invalid('msi-guard-search');
  if (!Array.isArray(inspection.appSearch) || inspection.appSearch.length !== 1 || inspection.appSearch[0].property !== 'OPPOSITE_ARCH_INSTALL_LOCATION' || inspection.appSearch[0].signature !== inspection.searches[0].id) invalid('msi-guard-property');
  if (!Array.isArray(inspection.launchConditions) || !inspection.launchConditions.some(row=>row.condition === 'Installed OR NOT OPPOSITE_ARCH_INSTALL_LOCATION')) invalid('msi-guard-condition');
  if (!Array.isArray(inspection.upgrade) || inspection.upgrade.length < 2 || inspection.upgrade.some(row => normalizeGuid(row.code) !== identity.upgradeCode)) invalid('msi-upgrade-family');
  if (inspection.binaryCount !== 0) invalid('msi-binary');
  const custom = inspection.customActions;
  if (!Array.isArray(custom) || (fixture?.failAfterInstallFiles ? custom.length !== 1 || custom[0].id !== 'FixtureFail' || custom[0].type !== 19 || custom[0].target !== 'Generated fixture rollback' : custom.length !== 0)) invalid('msi-custom-actions');
  if (!Array.isArray(inspection.registry) || inspection.registry.length !== expectedManifest.length + 4 || inspection.registry.some(row => row.root !== 1 || !(row.key === identity.registryKey || row.key === `${identity.registryKey}\\Components`))) invalid('msi-registry');
  for (const [name,value] of [['InstalledVersion',identity.version],['InstallLocation','[INSTALLFOLDER]'],['ProductCode','[ProductCode]']]) {
    const rows = inspection.registry.filter(row => row.name === name && row.key === identity.registryKey);
    if (rows.length !== 1 || rows[0].value !== value) invalid('msi-owner-values');
  }
  if (inspection.installDirectoryName !== identity.installDirectoryName || inspection.installDirectoryParent !== 'ProgramsDirectory' || inspection.programsDirectoryName !== 'Programs' || inspection.programsDirectoryParent !== 'LocalAppDataFolder') invalid('msi-directory');
  if (!Array.isArray(inspection.shortcuts) || inspection.shortcuts.length !== 1 || inspection.shortcuts[0].directory !== 'ApplicationMenu' || inspection.shortcuts[0].target !== '[INSTALLFOLDER]PutioManager.exe' || inspection.shortcuts[0].arguments || inspection.shortcuts[0].workingDirectory !== 'INSTALLFOLDER') invalid('msi-shortcut');
  if (!Array.isArray(inspection.removals) || inspection.removals.length !== 1 || inspection.removals[0].filename || inspection.removals[0].directory !== 'ApplicationMenu' || inspection.removals[0].mode !== 2) invalid('msi-removal');
  if (!Array.isArray(inspection.files)) invalid('msi-files');
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
export async function reconstructInspectedPayload({inspection,sourceDirectory,payloadDirectory}) {
  const sourceRoot=await fs.realpath(sourceDirectory);
  await fs.mkdir(payloadDirectory);
  const targetRoot=await fs.realpath(payloadDirectory);
  for(const file of inspection.files) {
    const info=await fs.lstat(file.source);
    if(!info.isFile()||info.isSymbolicLink()) throw new Error('Extracted MSI source is not a regular file.');
    const source=await fs.realpath(file.source);
    const relativeSource=path.relative(sourceRoot,source);
    if(!relativeSource || path.isAbsolute(relativeSource) || relativeSource==='..' || relativeSource.startsWith(`..${path.sep}`)) throw new Error('Extracted MSI source escaped its audit directory.');
    const target=path.resolve(targetRoot,file.path);
    const relativeTarget=path.relative(targetRoot,target);
    if(!relativeTarget || path.isAbsolute(relativeTarget) || relativeTarget==='..' || relativeTarget.startsWith(`..${path.sep}`)) throw new Error('Extracted MSI target escaped its audit directory.');
    await fs.mkdir(path.dirname(target),{recursive:true});
    await fs.copyFile(source,target);
  }
}
export async function auditWindowsInstallers({version,arch,appDirectory,outputDirectory,toolsDirectory,fixture,verifyPayload,verifyBootstrapper}) {
  if (process.platform !== 'win32') throw new Error('Read-only Windows installer auditing requires Windows.');
  const identity = getWindowsInstallerIdentity({version,arch,family:fixture?.family});
  const expectedManifest = await auditStage('application-manifest',()=>createPayloadManifest(appDirectory));
  const names = installerAssetNames(version,arch);
  const msi = path.resolve(outputDirectory,names.msi), exe = path.resolve(outputDirectory,names.exe);
  const work = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'putio-installer-audit-')));
  let succeeded = false;
  try {
    const {executable} = await auditStage('toolchain',()=>ensureWix(toolsDirectory));
    const containerDirectory = path.join(work,'bundle-containers');
    const bootstrapperDirectory = path.join(work,'bundle-bootstrapper');
    await auditStage('bundle-extraction',()=>runTool(executable,['burn','extract',exe,'-o',containerDirectory,'-oba',bootstrapperDirectory]));
    await auditStage('bundle-inventory',async()=>{
      const bootstrapperFiles=(await regularFiles(bootstrapperDirectory)).map(filename=>path.relative(bootstrapperDirectory,filename).replaceAll('\\','/')).sort();
      if(JSON.stringify(bootstrapperFiles)!==JSON.stringify([...WIX_BOOTSTRAPPER_FILES].sort())) throw new Error('The bootstrapper contains unexpected resources.');
    });
    await auditStage('bundle-architecture',async()=>{
      verifyPeArchitecture(await fs.readFile(exe),arch);
      verifyPeArchitecture(await fs.readFile(path.join(bootstrapperDirectory,'wixstdba.exe')),arch);
    });
    const msiBytes=await auditStage('embedded-msi',async()=>{
      const containerFiles = await regularFiles(containerDirectory);
      if (containerFiles.length !== 1 || path.extname(containerFiles[0]).toLowerCase() !== '.msi') throw new Error('The bootstrapper must contain exactly one MSI.');
      const bytes = await fs.readFile(msi), embedded = await fs.readFile(containerFiles[0]);
      if (!bytes.equals(embedded)) throw new Error('The bootstrapper embeds a different MSI.');
      return bytes;
    });
    const helper = await auditStage('audit-helper-build',()=>ensureAuditHelper(toolsDirectory));
    const bundleInspectionFile=path.join(work,'bundle-inspection.json');
    await auditStage('bundle-xml-read',()=>runTool('dotnet',[helper,'--bootstrapper',bootstrapperDirectory,bundleInspectionFile]));
    await auditStage('bundle-metadata',async()=>validateBootstrapperInspection({inspection:JSON.parse(await fs.readFile(bundleInspectionFile,'utf8')),identity,names}));
    if(verifyBootstrapper) await auditStage('bundle-privacy',()=>verifyBootstrapper(bootstrapperDirectory,WIX_BOOTSTRAPPER_FILES));
    const inspection = await auditStage('msi-read',()=>inspectMsi({msi,outputDirectory:path.join(work,'msi'),toolsDirectory,helper}));
    await auditStage('msi-metadata',()=>validateMsiInspection({inspection,identity,expectedManifest,fixture}));
    const payloadDirectory = path.join(work,'application');
    await auditStage('payload-reconstruction',()=>reconstructInspectedPayload({inspection,sourceDirectory:path.join(work,'msi','files'),payloadDirectory}));
    await auditStage('payload-comparison',async()=>comparePayloadManifests(expectedManifest,await createPayloadManifest(payloadDirectory)));
    if (verifyPayload) await auditStage('payload-privacy',()=>verifyPayload(payloadDirectory));
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
  } catch(error) { console.error(`Windows installer audit failed: ${JSON.stringify(auditFailureStatus(error))}`); process.exitCode=1; }
}
