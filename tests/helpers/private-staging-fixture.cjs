const fs = require('node:fs/promises');
const { execFileSync } = require('node:child_process');

// Restrict disposable test roots to the current Windows identity and SYSTEM.
// POSIX fixtures already use mkdtemp's owner-only directory mode.
async function privateTemp(prefix) {
  const directory = await fs.mkdtemp(prefix);
  if (process.platform !== 'win32') return directory;
  const script = `
$ErrorActionPreference = 'Stop'
try {
$step = 'import'
Import-Module (Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1')

$p = $env:PUTIO_PRIVATE_FIXTURE_ROOT
$step = 'identity'
$userSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$step = 'read-acl'
$acl = Get-Acl -LiteralPath $p
$step = 'protect'
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRuleSpecific($rule) | Out-Null }
$step = 'construct-rules'
foreach ($sid in @($userSid, $systemSid)) {
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
  $acl.AddAccessRule($rule)
}
$step = 'write-acl'
Set-Acl -LiteralPath $p -AclObject $acl
$step = 'verify-acl'
$check = Get-Acl -LiteralPath $p
if (-not $check.AreAccessRulesProtected) { throw 'Fixture ACL still inherits permissions.' }
$seenUser = $false
foreach ($rule in $check.Access) {
  $id = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
  if ($id -ne $userSid.Value -and $id -ne $systemSid.Value) { throw 'Fixture ACL has an unexpected identity.' }
  if ($rule.AccessControlType -ne 'Allow') { throw 'Fixture ACL contains an unexpected deny rule.' }
  if ($id -eq $userSid.Value) { $seenUser = $true }
}
if (-not $seenUser) { throw 'Fixture ACL does not grant the current user.' }
} catch { [Console]::Error.WriteLine($_.Exception.GetType().FullName); [Console]::Error.WriteLine('stage-' + $step); if ($_.Exception.CommandName -in @('Get-Acl','Set-Acl','Out-Null')) { [Console]::Error.WriteLine($_.Exception.CommandName) }; [Console]::Error.WriteLine($_.CategoryInfo.Reason); exit 1 }
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      env: { ...process.env, PUTIO_PRIVATE_FIXTURE_ROOT: directory }, stdio: 'pipe', windowsHide: true,
    });
  } catch (error) {
    const raw = String(error.stderr || '') + String(error.stdout || '');
    const step = (raw.match(/stage-(?:import|identity|read-acl|protect|construct-rules|write-acl|verify-acl)/) || [])[0];
    const exception = (raw.match(/(?:System|Microsoft)(?:\.[A-Za-z]+)+Exception/) || [])[0];
    const command = ['Get-Acl','Set-Acl','Out-Null'].find(x=>new RegExp('(?:^|\\s)'+x+'(?:\\s|$)').test(raw));
    const category = (exception ? exception + (command ? ':'+command : '') + (step ? ':'+step : '') : '') || ['System.Management.Automation.ItemNotFoundException','System.UnauthorizedAccessException','System.Management.Automation.ParameterBindingException','System.Security.Principal.IdentityNotMappedException','UnauthorizedAccessException','MethodException','MethodInvocationException','ArgumentException','ParserError','SecurityException','InvalidOperation','AccessDenied','GetCurrent','Get-Acl','Translate','RemoveAccessRuleSpecific'].find(x=>raw.includes(x)) || (raw.includes('SetAccessRuleProtection') ? 'access rule protection' : raw.includes('FileSystemAccessRule') ? 'access rule construction' : raw.includes('Set-Acl') ? 'setting ACL' : raw.includes('unexpected identity') ? 'unexpected identity' : raw.includes('unexpected deny') ? 'unexpected deny' : raw.includes('not grant the current user') ? 'missing user grant' : raw.includes('still inherits') ? 'inherited rules' : 'other');
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    throw new Error(`Could not create and verify a private Windows fixture directory (${category}; ${error.code || error.status || 'unknown'}).`);
  }
  return directory;
}
module.exports = { privateTemp };
