param([Parameter(Mandatory=$true)][string]$RegistrySubKey,
      [Parameter(Mandatory=$true)][ValidateSet('create','remove')][string]$Operation,
      [Parameter(Mandatory=$true)][string]$GeneratedLocation)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:GITHUB_REPOSITORY -ne 'garbledhamster/putio-manager' -or $RegistrySubKey -notmatch '^Software\\PutioManager\\Installer\\fixture-[a-f0-9-]{36}\\(?:x64|arm64)$') { throw 'Registry fixture mutations require an isolated hosted CI family.' }
$root = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryView]::Registry64)
try {
  if ($Operation -eq 'create') {
    $existing = $root.OpenSubKey($RegistrySubKey)
    if ($existing) { $existing.Dispose(); throw 'Fixture registry key already exists.' }
    $key = $root.CreateSubKey($RegistrySubKey)
    try { $key.SetValue('InstallLocation',$GeneratedLocation,[Microsoft.Win32.RegistryValueKind]::String) } finally { $key.Dispose() }
  } else {
    $root.DeleteSubKeyTree($RegistrySubKey,$false)
  }
} finally { $root.Dispose() }
