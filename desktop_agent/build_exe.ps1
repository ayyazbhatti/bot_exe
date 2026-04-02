# Build MT5RemoteAgent.exe (PyInstaller onedir) for Windows.
# Prerequisites: Python 3.10+ on this machine, pip install -r requirements-build.txt
# Output: desktop_agent\dist\MT5RemoteAgent\ — zip that folder for the trading PC.
# Builds into dist_staging first so a locked dist\MT5RemoteAgent (exe running, Explorer) does not break PyInstaller.
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

$stagingRoot = Join-Path $here "dist_staging"
$stagingBuild = Join-Path $here "build_staging"
if (Test-Path $stagingRoot) { Remove-Item -LiteralPath $stagingRoot -Recurse -Force }
if (Test-Path $stagingBuild) { Remove-Item -LiteralPath $stagingBuild -Recurse -Force }

# Pip/PyInstaller emit stderr; Windows PowerShell 5 treats that as terminating under $ErrorActionPreference Stop.
$saveEap = $ErrorActionPreference
$ErrorActionPreference = "Continue"
python -m pip install -r requirements-build.txt
if ($LASTEXITCODE -ne 0) {
    $ErrorActionPreference = $saveEap
    Write-Error "pip install failed (exit code $LASTEXITCODE)."
}

python -m PyInstaller --noconfirm --clean --onedir `
    --name MT5RemoteAgent `
    --console `
    --hidden-import tkinter `
    --hidden-import tkinter.ttk `
    --hidden-import websocket `
    --distpath $stagingRoot `
    --workpath $stagingBuild `
    mt5_remote_agent.py
$piExit = $LASTEXITCODE
$ErrorActionPreference = $saveEap
if ($piExit -ne 0) {
    Write-Error "PyInstaller failed (exit code $piExit)."
}

$built = Join-Path $stagingRoot "MT5RemoteAgent"
if (-not (Test-Path $built)) {
    Write-Error "Expected output missing: $built"
}

$distParent = Join-Path $here "dist"
New-Item -ItemType Directory -Force -Path $distParent | Out-Null
$dist = Join-Path $distParent "MT5RemoteAgent"
if (Test-Path $dist) {
    try {
        Remove-Item -LiteralPath $dist -Recurse -Force -ErrorAction Stop
    } catch {
        $dist = Join-Path $distParent ("MT5RemoteAgent_" + (Get-Date -Format "yyyyMMdd_HHmmss"))
        Write-Warning "Could not replace dist\MT5RemoteAgent (folder or file in use). New build is in: $dist"
    }
}
try {
    Move-Item -LiteralPath $built -Destination $dist
} catch {
    Write-Warning "Move-Item to dist failed (folder may be locked). Copying instead."
    Copy-Item -LiteralPath $built -Destination $dist -Recurse -Force
    Remove-Item -LiteralPath $built -Recurse -Force -ErrorAction SilentlyContinue
}
Remove-Item -LiteralPath $stagingRoot -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $stagingBuild -Recurse -Force -ErrorAction SilentlyContinue
$repoBridge = Join-Path (Split-Path -Parent $here) "python_bridge"
if (-not (Test-Path $repoBridge)) {
    Write-Error "Missing python_bridge at $repoBridge"
}
$destBridge = Join-Path $dist "python_bridge"
if (Test-Path $destBridge) { Remove-Item -Recurse -Force $destBridge }
Copy-Item -Recurse $repoBridge $destBridge
# Drop dev log if present
$log = Join-Path $destBridge "logs"
if (Test-Path $log) { Remove-Item -Recurse -Force $log }

$distCfg = Join-Path $here "config.dist.example.json"
if (Test-Path $distCfg) {
    Copy-Item -Force $distCfg (Join-Path $dist "config.example.json")
} else {
    Copy-Item -Force (Join-Path $here "config.example.json") (Join-Path $dist "config.example.json")
}
# Working config for first run (pair with PAIR_FIRST_RUN.bat or set device_id/token in the panel)
Copy-Item -Force (Join-Path $dist "config.example.json") (Join-Path $dist "config.json")

$pairBat = Join-Path $here "PAIR_FIRST_RUN.bat"
if (Test-Path $pairBat) { Copy-Item -Force $pairBat (Join-Path $dist "PAIR_FIRST_RUN.bat") }
$steps = Join-Path $here "INSTALL_STEPS.txt"
if (Test-Path $steps) { Copy-Item -Force $steps (Join-Path $dist "INSTALL_STEPS.txt") }
$urlEx = Join-Path $here "panel_api_url.example.txt"
if (Test-Path $urlEx) { Copy-Item -Force $urlEx (Join-Path $dist "panel_api_url.example.txt") }

& (Join-Path $here "prepare_portable_runtime.ps1") -InstallRoot $dist

Write-Host "Built: $dist"
Write-Host "Includes config.json template + PAIR_FIRST_RUN.bat. User runs pairing bat once, then MT5RemoteAgent.exe."
