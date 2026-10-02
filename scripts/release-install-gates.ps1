# The release gates a Windows installer passes before it is published (IMP-08):
# it installs silently for the current user and says what version it
# installed, the installed app starts and registers the gatherline:// and
# slackoss:// links, installing over the previous release keeps that release's
# data, and uninstalling removes the app but keeps the person's data.
#
#   ./scripts/release-install-gates.ps1 -Installer <new Setup.exe> -Version <x.y.z> [-Previous <old Setup.exe>]
#
# Run on a disposable Windows machine (a CI runner): it installs, launches and
# uninstalls the real app for the current user.
param(
  [Parameter(Mandatory)] [string] $Installer,
  [Parameter(Mandatory)] [string] $Version,
  [string] $Previous
)
$ErrorActionPreference = "Stop"
$Marker = "release-gate-marker.txt"

function Fail([string] $Message) {
  Write-Host "::error::$Message"
  throw $Message
}

# The uninstall entry the installer writes, which also says where it put the app.
function Installed {
  $keys = Get-ChildItem "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall" -ErrorAction SilentlyContinue
  foreach ($key in $keys) {
    $entry = Get-ItemProperty $key.PSPath
    if ($entry.DisplayName -like "Gatherline*") { return $entry }
  }
  return $null
}

function Install([string] $Path, [string] $Expected) {
  Write-Host "Installing $Path"
  $process = Start-Process -FilePath $Path -ArgumentList "/S" -Wait -PassThru
  if ($process.ExitCode -ne 0) { Fail "$Path exited with $($process.ExitCode)" }
  $entry = Installed
  if (-not $entry) { Fail "$Path left no uninstall entry" }
  if ($Expected -and $entry.DisplayVersion -ne $Expected) {
    Fail "installed version is $($entry.DisplayVersion), expected $Expected"
  }
  $exe = Join-Path $entry.InstallLocation "Gatherline.exe"
  if (-not (Test-Path $exe)) { Fail "no Gatherline.exe in $($entry.InstallLocation)" }
  Write-Host "Installed $($entry.DisplayVersion) at $($entry.InstallLocation)"
  return $exe
}

# Starts the installed app, waits for it to register its links and create its
# data folder, then stops it. Returns the data folder.
function Launch([string] $Exe) {
  Write-Host "Starting $Exe"
  $process = Start-Process -FilePath $Exe -PassThru
  $candidates = @((Join-Path $env:APPDATA "Gatherline"), (Join-Path $env:APPDATA "@slackoss\desktop"))
  $data = $null
  $registered = $false
  for ($i = 0; $i -lt 60 -and -not ($data -and $registered); $i++) {
    Start-Sleep -Seconds 1
    if ($process.HasExited) { Fail "the app exited on its own with $($process.ExitCode)" }
    $data = $candidates | Where-Object { Test-Path (Join-Path $_ "Local State") } | Select-Object -First 1
    $registered = $true
    foreach ($scheme in "gatherline", "slackoss") {
      $command = (Get-ItemProperty "HKCU:\Software\Classes\$scheme\shell\open\command" -ErrorAction SilentlyContinue).'(default)'
      if (-not $command -or $command -notlike "*$Exe*") { $registered = $false }
    }
  }
  Get-Process -Name "Gatherline" -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 2
  if (-not $registered) { Fail "the app did not register gatherline:// and slackoss:// to $Exe" }
  if (-not $data) { Fail "the app created no data folder in $($candidates -join ' or ')" }
  Write-Host "Links registered; data in $data"
  return $data
}

if ($Previous) {
  # Upgrading: the previous release's data is still there after the new one installs.
  $oldExe = Install $Previous $null
  $data = Launch $oldExe
  Set-Content -Path (Join-Path $data $Marker) -Value "kept across upgrade"
  $exe = Install $Installer $Version
  if (-not (Test-Path (Join-Path $data $Marker))) { Fail "installing over the previous release removed its data" }
  Write-Host "Upgrade kept the previous release's data"
} else {
  Write-Host "No previous release to upgrade from; installing fresh"
  $exe = Install $Installer $Version
}

$data = Launch $exe
Set-Content -Path (Join-Path $data $Marker) -Value "kept across uninstall"

$entry = Installed
$uninstaller = ($entry.UninstallString -replace '^"([^"]+)".*$', '$1')
Write-Host "Uninstalling with $uninstaller"
# The uninstaller copies itself elsewhere and returns at once, so wait for the
# app itself to go.
Start-Process -FilePath $uninstaller -ArgumentList "/S" -Wait | Out-Null
for ($i = 0; $i -lt 60 -and (Test-Path $exe); $i++) { Start-Sleep -Seconds 1 }
if (Test-Path $exe) { Fail "uninstalling left $exe behind" }
if (Installed) { Fail "uninstalling left the uninstall entry behind" }
if (-not (Test-Path (Join-Path $data $Marker))) { Fail "uninstalling removed the person's data in $data" }
Write-Host "Uninstall removed the app and kept the data in $data"
