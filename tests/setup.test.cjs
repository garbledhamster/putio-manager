const {test}=require('node:test'); const assert=require('node:assert/strict'); const fs=require('node:fs'); const os=require('node:os'); const path=require('node:path'); const {createSetup}=require('../dist/server/setup');
const {execFileSync}=require('node:child_process');
test('setup creates separate protected credentials and never overwrites existing setup',t=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'putio-setup-')); t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 const root=path.join(base,'downloads'); fs.mkdirSync(root); const config=path.join(base,'private','config.json');
 createSetup(config,root,5173); const c=JSON.parse(fs.readFileSync(config)); assert.equal(c.roots[0].path,root); assert.equal(c.host,'127.0.0.1');
 assert.match(fs.readFileSync(c.clientTokenFile,'utf8'),/^[A-Za-z0-9_-]{43}$/); assert.notEqual(fs.readFileSync(c.clientTokenFile,'utf8'),fs.readFileSync(c.credentialKeyFile,'utf8'));
 if(process.platform!=='win32'){assert.equal(fs.statSync(path.dirname(config)).mode&0o077,0);assert.equal(fs.statSync(c.credentialKeyFile).mode&0o077,0)}
 assert.throws(()=>createSetup(config,root,5173)); assert.throws(()=>createSetup(path.join(base,'other','config.json'),root,0));
});
test('Windows setup protects credentials using the process identity despite a spoofed USERNAME', {skip:process.platform!=='win32'}, t=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'putio-identity-'));
 t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 const previous=process.env.USERNAME;
 t.after(()=>{if(previous===undefined) delete process.env.USERNAME; else process.env.USERNAME=previous;});
 // The Everyone SID is stable across localized Windows installations. No real account is used.
 process.env.USERNAME='*S-1-1-0';
 const root=path.join(base,'downloads'); fs.mkdirSync(root);
 const config=path.join(base,'private','config.json');
 createSetup(config,root,5173);
 const c=JSON.parse(fs.readFileSync(config,'utf8'));
 assert.match(fs.readFileSync(c.clientTokenFile,'utf8'),/^[A-Za-z0-9_-]{43}$/);
 assert.match(fs.readFileSync(c.credentialKeyFile,'utf8'),/^[A-Za-z0-9_-]{43}$/);
 // Inspect through WindowsIdentity independently of the implementation. Return booleans only.
 const script=`$ErrorActionPreference='Stop'; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $private=$true; foreach($item in @($env:PUTIO_SETUP_TEST_DIR,(Join-Path $env:PUTIO_SETUP_TEST_DIR 'client-token'),(Join-Path $env:PUTIO_SETUP_TEST_DIR 'credential-key'),(Join-Path $env:PUTIO_SETUP_TEST_DIR 'config.json'))){ $acl=Get-Acl -LiteralPath $item; $rules=$acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]); if($rules.Count -ne 1 -or $rules[0].IdentityReference -ne $sid -or $rules[0].AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or ($rules[0].FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne [System.Security.AccessControl.FileSystemRights]::FullControl){$private=$false} }; [pscustomobject]@{privateToProcess=$private;inheritanceProtected=(Get-Acl -LiteralPath $env:PUTIO_SETUP_TEST_DIR).AreAccessRulesProtected}|ConvertTo-Json -Compress`;
 // Let Windows PowerShell use its own standard modules if this test was launched from PowerShell 7.
 const childEnvironment=Object.fromEntries(Object.entries(process.env).filter(([key])=>key.toLowerCase()!=='psmodulepath'));
 const result=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,env:{...childEnvironment,PUTIO_SETUP_TEST_DIR:path.dirname(config)},stdio:['ignore','pipe','ignore']}));
 assert.ok(result.privateToProcess,'Only the current process identity should have full access to setup credentials.');
 assert.ok(result.inheritanceProtected,'The private setup directory should block inherited access.');
 assert.throws(()=>createSetup(config,root,5173));
});
