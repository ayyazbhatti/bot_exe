# Full build: PyInstaller app folder + portable Python + optional Inno Setup single-file installer.
# Use -SkipBuild to only compile the .iss (expects dist\MT5RemoteAgent already built).
param([switch]$SkipBuild)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

if (-not $SkipBuild) {
    & (Join-Path $here "build_exe.ps1")
}

$candidates = @(
    (Join-Path ${env:ProgramFiles(x86)} "Inno Setup 6\ISCC.exe"),
    (Join-Path $env:ProgramFiles "Inno Setup 6\ISCC.exe")
)
$iscc = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) {
    Write-Host ""
    Write-Host "Inno Setup 6 not found. Install from: https://jrsoftware.org/isdl.php"
    Write-Host "Your portable app folder is ready to zip: $here\dist\MT5RemoteAgent"
    exit 0
}

Write-Host "Compiling installer with: $iscc"
& $iscc (Join-Path $here "mt5_remote_agent.iss")
Write-Host "Installer: $here\installer_output\MT5RemoteAgent-Setup-*.exe"
