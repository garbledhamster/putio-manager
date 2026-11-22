const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const moduleUnderTest = () => import('../scripts/windows-installer/build.mjs');

test('installer identities are stable within an architecture and distinct across versions and fixture families', async () => {
  const { getWindowsInstallerIdentity } = await moduleUnderTest();
  const a = getWindowsInstallerIdentity({version:'2.2.0',arch:'x64'});
  const b = getWindowsInstallerIdentity({version:'2.2.1',arch:'x64'});
  const arm = getWindowsInstallerIdentity({version:'2.2.0',arch:'arm64'});
  const fixture = getWindowsInstallerIdentity({version:'2.2.0',arch:'x64',family:'generated-fixture'});
  assert.equal(a.upgradeCode,b.upgradeCode);
  assert.notEqual(a.productCode,b.productCode);
  assert.notEqual(a.upgradeCode,arm.upgradeCode);
  assert.notEqual(a.upgradeCode,fixture.upgradeCode);
  assert.equal(a.productCode,getWindowsInstallerIdentity({version:'2.2.0',arch:'x64'}).productCode);
  for (const bad of ['v2.2.0','2.2.0-beta.1','256.0.0','1.1.65536','1.2.3.4']) {
    assert.throws(() => getWindowsInstallerIdentity({version:bad,arch:'x64'}));
  }
});

test('per-user payload authoring has explicit HKCU key paths and an identical embedded MSI', async () => {
  const { generateWindowsInstallerSources } = await moduleUnderTest();
  const input = {version:'2.2.0',arch:'arm64',files:['resources/app/package.json','PutioManager.exe','locales/en-US.pak']};
  const result = generateWindowsInstallerSources(input);
  assert.match(result.packageXml,/Scope="perUser"/);
  assert.match(result.packageXml,/Schedule="afterInstallInitialize"/);
  assert.match(result.packageXml,/Condition="Installed OR NOT OPPOSITE_ARCH_INSTALL_LOCATION"/);
  assert.match(result.packageXml,/Key="Software\\PutioManager\\Installer\\application\\x64" Name="InstallLocation" Type="raw" Bitness="always64"/);
  assert.doesNotMatch(result.payloadXml,/<Files\b/);
  assert.equal((result.payloadXml.match(/Root="HKCU"/g)||[]).length,3);
  assert.equal((result.payloadXml.match(/KeyPath="yes"/g)||[]).length,3);
  assert.equal((result.payloadXml.match(/KeyPath="no"/g)||[]).length,3);
  assert.match(result.bundleXml,/Permanent="yes" Visible="yes"/);
  assert.match(result.bundleXml,/SourceFile="\$\(var.MsiPath\)"/);
  assert.deepEqual(result,generateWindowsInstallerSources({...input,files:[...input.files].reverse()}));
});

test('payload input rejects traversal, Windows aliases, conflicting names and private runtime data', async () => {
  const { generateWindowsInstallerSources } = await moduleUnderTest();
  for (const files of [['../settings.json'],['a/../../b'],['C:/data'],['A.txt','a.txt'],['foo./x'],['CON.txt'],['resources/app/settings.json'],['resources/user-data/cookies']]) {
    assert.throws(() => generateWindowsInstallerSources({version:'2.2.0',arch:'x64',files}));
  }
  assert.throws(() => generateWindowsInstallerSources({version:'2.2.0',arch:'x64',files:['resources/app/package.json']}));
});

test('fixture failure is authored only for the isolated fixture family', async () => {
  const { generateWindowsInstallerSources } = await moduleUnderTest();
  assert.throws(() => generateWindowsInstallerSources({version:'2.2.0',arch:'x64',files:['PutioManager.exe'],fixture:{failAfterInstallFiles:true}}));
  const result = generateWindowsInstallerSources({version:'2.2.0',arch:'x64',files:['PutioManager.exe'],fixture:{family:'generated-fixture',failAfterInstallFiles:true}});
  assert.match(result.packageXml,/Error="Generated fixture rollback"/);
  assert.match(result.packageXml,/After="InstallFiles"/);
});

test('payload manifests compare exact files and bytes, without following links', async t => {
  const { createPayloadManifest, comparePayloadManifests } = await moduleUnderTest();
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'installer-unit-'));
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  await fs.writeFile(path.join(root,'PutioManager.exe'),'generated executable');
  const a = await createPayloadManifest(root);
  assert.doesNotThrow(() => comparePayloadManifests(a,a));
  assert.throws(() => comparePayloadManifests(a,[...a,{path:'extra',size:0,sha256:'0'.repeat(64)}]));
  await fs.writeFile(path.join(root,'PutioManager.exe'),'changed executable');
  assert.throws(() => comparePayloadManifests(a,[]));
  const b = await createPayloadManifest(root);
  assert.throws(() => comparePayloadManifests(a,b));
});

test('runtime staging preserves exact Node provenance and refuses replacing existing resources', async t => {
  const { stageWindowsUpdateRuntime } = await moduleUnderTest();
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'installer-runtime-unit-'));
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  const nodeExecutable = path.join(root,'generated-node.exe');
  await fs.writeFile(nodeExecutable,'generated Node runtime bytes');
  const app = path.join(root,'application'); await fs.mkdir(app);
  const options = {fixture:true,nodeExecutable,nodeVersion:'v24.1.0',arch:'arm64',nodeLicenseText:'Node.js generated license fixture'};
  const result = await stageWindowsUpdateRuntime(app,options);
  assert.deepEqual(result,await stageWindowsUpdateRuntime(app,options));
  const provenance = JSON.parse(await fs.readFile(path.join(app,'resources/update-runtime/NODE-PROVENANCE.json'),'utf8'));
  assert.equal(provenance.version,'v24.1.0');
  assert.equal(provenance.arch,'arm64');
  assert.equal(provenance.sha256,result.sha256);
  assert.ok(!JSON.stringify(provenance).includes(root));
  await fs.writeFile(path.join(app,'resources/update-runtime/node.exe'),'different existing bytes');
  await assert.rejects(stageWindowsUpdateRuntime(app,options));
  assert.equal(await fs.readFile(path.join(app,'resources/update-runtime/node.exe'),'utf8'),'different existing bytes');
});

test('MSI audit rejects altered servicing policy, scope, identity, custom actions and bytes', async () => {
  const {getWindowsInstallerIdentity} = await moduleUnderTest();
  const {validateMsiInspection} = await import('../scripts/windows-installer/audit.mjs');
  const identity = getWindowsInstallerIdentity({version:'2.2.0',arch:'x64'});
  const expectedManifest = [{path:'PutioManager.exe',size:10,sha256:'a'.repeat(64)}];
  const inspection = {
    properties:{ProductVersion:identity.version,ProductCode:`{${identity.productCode}}`,UpgradeCode:`{${identity.upgradeCode}}`,ProductName:identity.productName,Manufacturer:'Putio Manager',REBOOT:'ReallySuppress'},
    template:'x64;1033',actions:{AppSearch:50,LaunchConditions:100,InstallInitialize:1500,RemoveExistingProducts:1501,ProcessComponents:1600},
    upgrade:[{code:identity.upgradeCode},{code:identity.upgradeCode}],binaryCount:0,customActions:[],files:expectedManifest,
    registry:[{root:1,key:identity.registryKey},{root:1,key:`${identity.registryKey}\\Components`},...Object.entries({InstalledVersion:identity.version,InstallLocation:'[INSTALLFOLDER]',ProductCode:'[ProductCode]'}).map(([name,value])=>({root:1,key:identity.registryKey,name,value}))],
    installDirectoryName:identity.installDirectoryName,installDirectoryParent:'ProgramsDirectory',programsDirectoryName:'Programs',programsDirectoryParent:'LocalAppDataFolder',
    shortcuts:[{directory:'ApplicationMenu',target:'[INSTALLFOLDER]PutioManager.exe',arguments:'',workingDirectory:'INSTALLFOLDER'}],
    removals:[{filename:'',directory:'ApplicationMenu',mode:2}],
    searches:[{id:'OppositeArchitectureInstallLocation',root:1,key:identity.oppositeRegistryKey,name:'InstallLocation',type:18}],
    appSearch:[{property:'OPPOSITE_ARCH_INSTALL_LOCATION',signature:'OppositeArchitectureInstallLocation'}],
    launchConditions:[{condition:'Installed OR NOT OPPOSITE_ARCH_INSTALL_LOCATION'}],
  };
  assert.equal(validateMsiInspection({inspection,identity,expectedManifest}),true);
  for (const mutate of [
    value => {value.properties.ALLUSERS='1';},
    value => {value.properties.ProductCode='bad';},
    value => {value.actions.RemoveExistingProducts=1400;},
    value => {value.template='Arm64;1033';},
    value => {value.binaryCount=1;},
    value => {value.customActions=[{id:'UnexpectedExecutable',type:1}];},
    value => {value.registry[0].root=2;},
    value => {value.files[0].sha256='b'.repeat(64);},
    value => {value.registry.find(row=>row.name==='InstalledVersion').value='0.0.0';},
    value => {value.installDirectoryParent='AppDataFolder';},
    value => {value.removals[0].filename='*';},
    value => {value.searches[0].key=identity.registryKey;},
    value => {value.searches[0].type=2;},
    value => {value.launchConditions=[];},
    value => {value.actions.LaunchConditions=1600;},
  ]) {
    const altered=structuredClone(inspection); mutate(altered);
    assert.throws(() => validateMsiInspection({inspection:altered,identity,expectedManifest}));
  }
});

test('native fixture guard refuses operator machines, unhosted runners and other repositories', async () => {
  const {requireDisposableWindowsRunner} = await import('../scripts/windows-installer/native-fixture.mjs');
  assert.throws(() => requireDisposableWindowsRunner({},'win32'));
  const env = {GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY:'garbledhamster/putio-manager',RUNNER_TEMP:'generated-temp',LOCALAPPDATA:'generated-local',APPDATA:'generated-profile'};
  assert.doesNotThrow(() => requireDisposableWindowsRunner(env,'win32'));
  for (const key of Object.keys(env)) assert.throws(() => requireDisposableWindowsRunner({...env,[key]:''},'win32'));
  assert.throws(() => requireDisposableWindowsRunner(env,'linux'));
});

test('tool failures disclose stable diagnostic codes without raw compiler or machine output', async () => {
  const {runTool}=await moduleUnderTest();
  await assert.rejects(runTool(process.execPath,['-e',"process.stderr.write('CS1234 generated-private-build-location');process.exit(1)"]),error => {
    assert.match(error.message,/CS1234/);
    assert.doesNotMatch(error.message,/generated-private-build-location/);
    return true;
  });
});

test('native updater acceptance cannot execute on an operator machine', async () => {
  const script="const {runNativeWindowsUpdateTest}=await import('./scripts/windows-installer/native-update-test.mjs');try{await runNativeWindowsUpdateTest();process.exitCode=2}catch(error){if(!/restricted to disposable/.test(error.message))process.exitCode=3}";
  const result=require('node:child_process').spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:path.resolve(__dirname,'..'),env:{...process.env,GITHUB_ACTIONS:'false'},encoding:'utf8'});
  assert.equal(result.status,0);
});

test('audit failures expose only allowlisted stages, invariant codes and compiler/API codes', async () => {
  const {auditStage,auditFailureStatus,validateBootstrapperInspection}=await import('../scripts/windows-installer/audit.mjs');
  let failure;
  try { await auditStage('bundle-metadata',()=>validateBootstrapperInspection({inspection:{manifest:[],application:[],extension:[]},identity:{},names:{}})); } catch(error) {failure=error;}
  assert.deepEqual(auditFailureStatus(failure),{schema:1,stage:'bundle-metadata',code:'bundle-element-count'});
  try { await auditStage('audit-helper-build',()=>{throw Error('An installer build or audit tool failed. CS1001 DTF_FILES_INVALID generated-private-build-location');}); } catch(error) {failure=error;}
  const status=auditFailureStatus(failure);
  assert.deepEqual(status,{schema:1,stage:'audit-helper-build',code:'tool-failed',toolCodes:['CS1001','DTF_FILES_INVALID']});
  assert.ok(!JSON.stringify(status).includes('generated-private'));
  assert.deepEqual(auditFailureStatus({auditStage:'generated-private-stage',auditCode:'generated-private-code'}),{schema:1,stage:'initialization',code:'audit-failed'});
  await assert.rejects(auditStage('generated-private-stage',()=>{}),/Unknown installer audit stage/);
});

test('MSI reconstruction accepts a canonical trusted-root alias and rejects escaping files and targets', async t => {
  const {reconstructInspectedPayload}=await import('../scripts/windows-installer/audit.mjs');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'installer-alias-unit-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const source=path.join(root,'source'),alias=path.join(root,'alias');
  await fs.mkdir(source); await fs.writeFile(path.join(source,'generated.exe'),'generated fixture bytes');
  await fs.symlink(source,alias,process.platform==='win32'?'junction':'dir');
  const actual=await fs.realpath(path.join(source,'generated.exe'));
  await reconstructInspectedPayload({inspection:{files:[{source:actual,path:'PutioManager.exe'}]},sourceDirectory:alias,payloadDirectory:path.join(root,'accepted')});
  assert.equal(await fs.readFile(path.join(root,'accepted/PutioManager.exe'),'utf8'),'generated fixture bytes');
  const outside=path.join(root,'outside.exe');await fs.writeFile(outside,'generated outside bytes');
  await assert.rejects(reconstructInspectedPayload({inspection:{files:[{source:outside,path:'PutioManager.exe'}]},sourceDirectory:alias,payloadDirectory:path.join(root,'rejected-source')}),/escaped/);
  await assert.rejects(reconstructInspectedPayload({inspection:{files:[{source:actual,path:'../outside-target.exe'}]},sourceDirectory:alias,payloadDirectory:path.join(root,'rejected-target')}),/escaped/);
  assert.equal(await fs.access(path.join(root,'outside-target.exe')).then(()=>true,()=>false),false);
});

test('bootstrapper metadata has a fixed pinned resource inventory and the exact MSI servicing identity', async () => {
  const {getWindowsInstallerIdentity,installerAssetNames}=await moduleUnderTest();
  const {validateBootstrapperInspection,WIX_BOOTSTRAPPER_FILES}=await import('../scripts/windows-installer/audit.mjs');
  assert.equal(Object.isFrozen(WIX_BOOTSTRAPPER_FILES),true);
  const identity=getWindowsInstallerIdentity({version:'2.2.0',arch:'x64'});
  const names=installerAssetNames(identity.version,identity.arch);
  const element=(name,attributes,parent)=>({name,attributes,parent});
  const inspection={manifest:[
    element('BurnManifest',{EngineVersion:'6.0.2.0'}),
    element('Registration',{Version:identity.version,PerMachine:'no',ExecutableName:names.exe}),
    element('MsiPackage',{Id:'ApplicationMsi',Permanent:'yes',PerMachine:'no',Version:identity.version,ProductCode:identity.productCode,UpgradeCode:identity.upgradeCode},'Chain'),
    ...WIX_BOOTSTRAPPER_FILES.filter(name=>name!=='manifest.xml').map(name=>element('Payload',{FilePath:name},'UX')),
  ],application:[
    element('WixBundleProperties',{DisplayName:identity.productName,PerMachine:'no',UpgradeCode:identity.bundleUpgradeCode}),
    element('WixPackageProperties',{Package:'ApplicationMsi',Permanent:'yes',Version:identity.version,ProductCode:identity.productCode}),
  ],extension:[element('BootstrapperExtensionData',{})]};
  assert.equal(validateBootstrapperInspection({inspection,identity,names}),true);
  for(const mutate of [
    x=>{x.manifest.find(e=>e.name==='MsiPackage').attributes.Permanent='no';},
    x=>{x.manifest.find(e=>e.name==='MsiPackage').attributes.ProductCode='wrong';},
    x=>{x.manifest.push(element('Payload',{FilePath:'unexpected.cmd'},'UX'));},
    x=>{x.manifest.push(element('ExePackage',{},'Chain'));},
    x=>{x.manifest.push(element('Update',{Location:'https://example.com'}));},
    x=>{x.extension.push(element('UnexpectedExtension',{}));},
  ]) { const altered=structuredClone(inspection);mutate(altered);assert.throws(()=>validateBootstrapperInspection({inspection:altered,identity,names})); }
});
