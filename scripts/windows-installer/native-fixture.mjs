import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildWindowsInstallers, getWindowsInstallerIdentity, runTool, installerToolFailureStatus } from './build.mjs';
import { auditWindowsInstallers, auditFailureStatus } from './audit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureStages=new Set(['build-a','build-b','build-failure','audit-a','audit-b','audit-failure','opposite-marker-create','opposite-install-refused','opposite-marker-remove','exe-a-install','assert-installed-a','msi-b-upgrade','assert-installed-b','msi-b-reinstall','msi-b-repair','downgrade-refused','upgrade-rollback','uninstall-b','msi-a-install','exe-b-upgrade']);
const fixtureCodes=new Map([
  ['Fixture has duplicate, stale Burn, or incorrect MSI registration.','registration-mismatch'],
  ['Fixture installed ownership registration is invalid.','ownership-mismatch'],
  ['Installed fixture bytes do not match the expected version.','payload-mismatch'],
  ['Fixture profile or media was changed.','generated-data-changed'],
  ['Fixture uninstall left an installer registration.','uninstall-registration'],
  ['Fixture uninstall left application executable.','uninstall-payload'],
  ['Architecture conflict changed the registered installation.','architecture-registration'],
  ['Architecture conflict wrote application files.','architecture-payload'],
]);
export function fixtureFailureStatus(stage,error) {
  const audit=auditFailureStatus(error);
  return {schema:1,fixtureStage:fixtureStages.has(stage)?stage:'initialization',code:fixtureCodes.get(error?.message)||'fixture-failed',...installerToolFailureStatus(error),...(audit.stage!=='initialization'?{audit}:{})};
}
export function requireDisposableWindowsRunner(env = process.env,platform = process.platform) {
  if (platform !== 'win32' || env.GITHUB_ACTIONS !== 'true' || env.RUNNER_ENVIRONMENT !== 'github-hosted' || env.GITHUB_REPOSITORY !== 'garbledhamster/putio-manager' || !env.RUNNER_TEMP || !env.LOCALAPPDATA || !env.APPDATA) throw new Error('Native installer execution is restricted to disposable hosted repository CI.');
}
const sameGuid = (a,b) => String(a).replace(/[{}]/g,'').toUpperCase() === String(b).replace(/[{}]/g,'').toUpperCase();
export async function runNativeInstallerFixture() {
  requireDisposableWindowsRunner();
  const arch = process.arch;
  const family = `fixture-${randomUUID()}`;
  const work = await fs.mkdtemp(path.join(path.resolve(process.env.RUNNER_TEMP),'putio-install-fixture-'));
  if (!work.startsWith(`${path.resolve(process.env.RUNNER_TEMP)}${path.sep}`)) throw new Error('Fixture directory escaped the runner temporary directory.');
  const a = getWindowsInstallerIdentity({version:'1.0.0',arch,family});
  const b = getWindowsInstallerIdentity({version:'1.0.1',arch,family});
  const failed = getWindowsInstallerIdentity({version:'1.0.2',arch,family});
  const installed = path.join(process.env.LOCALAPPDATA,'Programs',a.installDirectoryName);
  const profile = path.join(process.env.APPDATA,a.installDirectoryName);
  const media = path.join(work,'synthetic-media');
  const sentinel = 'Generated fixture profile and media must survive installer servicing.\n';
  const products = [];
  let registered = false;
  let oppositeMarker = false;
  let stage='initialization';
  async function setOppositeMarker(operation) {
    await runTool(path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(here,'fixture-opposite-architecture.ps1'),'-RegistrySubKey',a.oppositeRegistryKey,'-Operation',operation,'-GeneratedLocation',path.join(work,'synthetic-opposite-install')]);
    oppositeMarker = operation === 'create';
  }
  async function inventory() {
    const response = await runTool(path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(here,'fixture-inventory.ps1'),'-ProductName',a.productName,'-RegistrySubKey',a.registryKey,'-ExpectedLocation',installed]);
    const result = JSON.parse(response.stdout.replace(/^\uFEFF/,''));
    if (!result || !Array.isArray(result.records)) throw new Error('Invalid fixture product inventory.');
    return result;
  }
  async function assertInstalled(identity) {
    const {records,owner} = await inventory();
    if (records.length !== 1 || !records[0].windowsInstaller || records[0].hidden || !sameGuid(records[0].productCode,identity.productCode) || records[0].version !== identity.version) throw new Error('Fixture has duplicate, stale Burn, or incorrect MSI registration.');
    if (!owner || owner.version !== identity.version || !sameGuid(owner.productCode,identity.productCode) || !owner.locationMatches) throw new Error('Fixture installed ownership registration is invalid.');
    if (await fs.readFile(path.join(installed,'resources/app/fixture-version.txt'),'utf8') !== identity.version) throw new Error('Installed fixture bytes do not match the expected version.');
    await assertPreserved();
  }
  async function assertPreserved() {
    for (const filename of [path.join(profile,'settings-fixture.txt'),path.join(media,'generated-media.txt')]) if (await fs.readFile(filename,'utf8') !== sentinel) throw new Error('Fixture profile or media was changed.');
  }
  async function msi(args,allowExitCodes=[0]) {
    return await runTool(path.join(process.env.SystemRoot,'System32','msiexec.exe'),[...args,'/qn','/norestart','REBOOT=ReallySuppress'],{allowExitCodes});
  }
  async function remove(identity) {
    await msi(['/x',`{${identity.productCode}}`]);
    registered = false;
    const {records,owner} = await inventory();
    if (records.length !== 0 || owner?.version || owner?.productCode) throw new Error('Fixture uninstall left an installer registration.');
    try { await fs.access(path.join(installed,'PutioManager.exe')); throw new Error('Fixture uninstall left application executable.'); } catch(error) { if (error.code !== 'ENOENT') throw error; }
    await assertPreserved();
  }
  try {
    await fs.mkdir(profile,{recursive:true}); await fs.mkdir(media);
    await fs.writeFile(path.join(profile,'settings-fixture.txt'),sentinel);
    await fs.writeFile(path.join(media,'generated-media.txt'),sentinel);
    for (const identity of [a,b,failed]) {
      const label=identity===a?'a':identity===b?'b':'failure';
      stage=`build-${label}`;
      const appDirectory = path.join(work,`app-${identity.version}`);
      await fs.mkdir(path.join(appDirectory,'resources/app'),{recursive:true});
      // The fixture executable is Node, never the real application or an account profile.
      await fs.copyFile(process.execPath,path.join(appDirectory,'PutioManager.exe'));
      await fs.writeFile(path.join(appDirectory,'resources/app/package.json'),JSON.stringify({name:'putio-manager',version:identity.version,generatedInstallerFixture:true}));
      await fs.writeFile(path.join(appDirectory,'resources/app/fixture-version.txt'),identity.version);
      const fixture = {family,failAfterInstallFiles:identity === failed};
      const outputDirectory = path.join(work,`output-${identity.version}`);
      const result = await buildWindowsInstallers({version:identity.version,arch,appDirectory,outputDirectory,fixture});
      stage=`audit-${label}`;
      const audit = await auditWindowsInstallers({version:identity.version,arch,appDirectory,outputDirectory,fixture});
      await audit.cleanup(); products.push(result);
    }
    // A synthetic opposite-architecture ownership marker exercises AppSearch on
    // either native runner without requiring that host to execute the other CPU.
    stage='opposite-marker-create'; await setOppositeMarker('create');
    stage='opposite-install-refused';
    await msi(['/i',products[0].msi],[1603]);
    if ((await inventory()).records.length !== 0) throw new Error('Architecture conflict changed the registered installation.');
    try { await fs.access(path.join(installed,'PutioManager.exe')); throw new Error('Architecture conflict wrote application files.'); } catch(error) { if(error.code!=='ENOENT') throw error; }
    await assertPreserved();
    stage='opposite-marker-remove'; await setOppositeMarker('remove');
    stage='exe-a-install';
    await runTool(products[0].exe,['/quiet','/norestart']); registered = true;
    stage='assert-installed-a'; await assertInstalled(a);
    stage='msi-b-upgrade'; await msi(['/i',products[1].msi]);
    stage='assert-installed-b'; await assertInstalled(b);
    // Reinstallation and repair use the retained exact MSI as source media.
    stage='msi-b-reinstall'; await msi(['/i',products[1].msi,'REINSTALL=ALL','REINSTALLMODE=vomus']); await assertInstalled(b);
    stage='msi-b-repair';
    await fs.unlink(path.join(installed,'resources/app/fixture-version.txt'));
    await msi(['/fa',products[1].msi]); await assertInstalled(b);
    stage='downgrade-refused'; await msi(['/i',products[0].msi],[1603,1638]); await assertInstalled(b);
    stage='upgrade-rollback'; await msi(['/i',products[2].msi],[1603]); await assertInstalled(b);
    stage='uninstall-b'; await remove(b);
    stage='msi-a-install'; await msi(['/i',products[0].msi]); registered = true; await assertInstalled(a);
    stage='exe-b-upgrade'; await runTool(products[1].exe,['/quiet','/norestart']); await assertInstalled(b);
    stage='uninstall-b'; await remove(b);
    console.log('Verified disposable EXE/MSI upgrades, one MSI registration, repair, rollback, downgrade refusal and preserved generated data.');
    return {ok:true,arch,checks:['opposite-architecture-blocked-before-write','exe-to-msi','msi-to-exe','one-msi-registration','no-burn-registration','reinstall','repair','downgrade-refused','rollback','uninstall','profile-preserved','media-preserved']};
  } catch(error) {
    console.error(JSON.stringify(fixtureFailureStatus(stage,error)));
    throw error;
  } finally {
    if (oppositeMarker) await setOppositeMarker('remove').catch(()=>{});
    if (registered) {
      const {records} = await inventory().catch(() => ({records:[]}));
      for (const record of records) if (record.windowsInstaller && [a,b,failed].some(identity => sameGuid(record.productCode,identity.productCode))) await msi(['/x',record.productCode],[0,1605]).catch(() => {});
    }
    // These paths are generated exclusively for this hosted fixture run.
    for (const directory of [profile,work]) await fs.rm(directory,{recursive:true,force:true});
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== '--disposable-ci') { console.error('Use --disposable-ci on the disposable hosted native runner.'); process.exitCode=1; }
  else await runNativeInstallerFixture().catch(() => { console.error('Disposable Windows installer verification failed. No private diagnostics were printed.'); process.exitCode=1; });
}
