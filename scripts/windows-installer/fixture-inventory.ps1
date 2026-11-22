param([Parameter(Mandatory=$true)][string]$ProductName,
      [Parameter(Mandatory=$true)][string]$RegistrySubKey,
      [Parameter(Mandatory=$true)][string]$ExpectedLocation)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $ProductName -notmatch '^Putio Manager Fixture [a-f0-9]{12}$' -or $RegistrySubKey -notmatch '^Software\\PutioManager\\Installer\\fixture-[a-f0-9-]{36}\\(?:x64|arm64)$') { throw 'Disposable fixture inventory requires a hosted CI runner.' }
$records = @()
foreach ($root in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall','HKCU:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
  if (Test-Path -LiteralPath $root) {
    $records += @(Get-ChildItem -LiteralPath $root | ForEach-Object { Get-ItemProperty -LiteralPath $_.PSPath } | Where-Object { $_.DisplayName -eq $ProductName } | ForEach-Object { [pscustomobject]@{ productCode = $_.PSChildName; windowsInstaller = $_.WindowsInstaller -eq 1; hidden = $_.SystemComponent -eq 1; version = $_.DisplayVersion } })
  }
}
$owner = $null
$machineRecords = 0
foreach ($root in @('HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
  if (Test-Path -LiteralPath $root) {
    $machineRecords += @(Get-ChildItem -LiteralPath $root | ForEach-Object { Get-ItemProperty -LiteralPath $_.PSPath } | Where-Object { $_.DisplayName -eq $ProductName }).Count
  }
}
if (Test-Path -LiteralPath ('HKCU:\' + $RegistrySubKey)) {
  $stored = Get-ItemProperty -LiteralPath ('HKCU:\' + $RegistrySubKey)
  $matchesLocation = $false
  if ($stored.InstallLocation) { $matchesLocation = [IO.Path]::GetFullPath($stored.InstallLocation).TrimEnd('\') -eq [IO.Path]::GetFullPath($ExpectedLocation).TrimEnd('\') }
  $owner = [pscustomobject]@{ version = $stored.InstalledVersion; productCode = $stored.ProductCode; locationMatches = $matchesLocation }
}
ConvertTo-Json -InputObject ([pscustomobject]@{ records = @($records); owner = $owner; machineRecords = $machineRecords }) -Compress -Depth 3
