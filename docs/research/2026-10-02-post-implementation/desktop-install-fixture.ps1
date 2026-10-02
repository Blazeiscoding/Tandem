# Exercises only the current Launch function with mocked process/registry calls.
# It never installs, starts, kills or uninstalls a real application.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$owned = Join-Path ([System.IO.Path]::GetTempPath()) ('tandem-desktop-post-install-' + [guid]::NewGuid())
$originalAppData = $env:APPDATA
$report = [ordered]@{
  revision = (& git -C $root rev-parse HEAD).Trim()
  capturedAt = [DateTime]::UtcNow.ToString('o')
  scope = 'Current installer Launch function only; all process and registry operations mocked, no install/uninstall'
}
function Assert-Owned {
  $resolved = [System.IO.Path]::GetFullPath($owned)
  $temp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\') + '\'
  if (-not $resolved.StartsWith($temp, [StringComparison]::OrdinalIgnoreCase) -or
      [System.IO.Path]::GetFileName($resolved) -notlike 'tandem-desktop-post-install-*') {
    throw 'Unsafe installer fixture directory'
  }
}
try {
  Assert-Owned
  New-Item -ItemType Directory -Path $owned | Out-Null
  $env:APPDATA = $owned
  $legacy = Join-Path $owned '@slackoss/desktop'
  $active = Join-Path $owned 'Tandem'
  New-Item -ItemType Directory -Path $legacy, $active | Out-Null
  Set-Content -LiteralPath (Join-Path $legacy 'Local State') -Value 'synthetic old profile'
  Set-Content -LiteralPath (Join-Path $legacy 'release-gate-marker.txt') -Value 'kept across upgrade'
  $script:fixtureExe = Join-Path $owned 'Tandem.exe'
  $script:activeProfile = $active
  $script:starts = 0
  $script:stops = 0
  $script:registrations = 0
  function Start-Process {
    [CmdletBinding()] param([string] $FilePath, [switch] $PassThru)
    $script:starts++
    Set-Content -LiteralPath (Join-Path $script:activeProfile 'Local State') -Value 'synthetic new process profile'
    return [pscustomobject]@{ HasExited = $false; ExitCode = $null }
  }
  function Get-ItemProperty {
    [CmdletBinding()] param([string] $Path)
    $script:registrations++
    return [pscustomobject]@{ '(default)' = ('"' + $script:fixtureExe + '" "%1"') }
  }
  function Get-Process {
    [CmdletBinding()] param([string[]] $Name)
    return [pscustomobject]@{ Fixture = $true }
  }
  function Stop-Process {
    [CmdletBinding()] param([Parameter(ValueFromPipeline)] $InputObject, [switch] $Force)
    process { $script:stops++ }
  }
  function Start-Sleep { param([int] $Seconds) }
  function Fail([string] $Message) { throw $Message }
  $tokens = $null
  $errors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $root 'scripts/release-install-gates.ps1'), [ref]$tokens, [ref]$errors)
  if ($errors.Count) { throw 'Installer gate source has parse errors' }
  $launch = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Launch' }, $true)
  if (-not $launch) { throw 'No Launch function found' }
  Invoke-Expression $launch.Extent.Text
  $selected = Launch $script:fixtureExe
  $report.fixture = [ordered]@{
    legacyProfilePreexisted = $true
    newProcessCreatedModernProfile = (Test-Path -LiteralPath (Join-Path $active 'Local State'))
    gateReturnedLegacyProfile = ($selected -eq $legacy)
    selectedProfileContainsUpgradeMarker = (Test-Path -LiteralPath (Join-Path $selected 'release-gate-marker.txt'))
    activeProfileContainsUpgradeMarker = (Test-Path -LiteralPath (Join-Path $active 'release-gate-marker.txt'))
    mockedStarts = $script:starts
    mockedStops = $script:stops
    mockedProtocolChecks = $script:registrations
  }
} finally {
  $env:APPDATA = $originalAppData
  Assert-Owned
  Remove-Item -LiteralPath $owned -Recurse -Force
  $report.disposableDataCleaned = -not (Test-Path -LiteralPath $owned)
}
$json = $report | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText((Join-Path $PSScriptRoot 'desktop-install-fixture.json'), $json + "`n", (New-Object System.Text.UTF8Encoding($false)))
