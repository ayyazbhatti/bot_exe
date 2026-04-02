# Start MT5 Panel API + Vite dev UI if not already running.
# For Scheduled Task at logon, or run: powershell -ExecutionPolicy Bypass -File panel-start.ps1
$ErrorActionPreference = "Stop"

function Get-RepoRoot {
    return (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}

function Import-BackendEnv {
    param([string]$RepoRoot)
    $envPath = Join-Path $RepoRoot "backend\.env"
    if (-not (Test-Path $envPath)) { return }
    Get-Content -LiteralPath $envPath | ForEach-Object {
        $line = $_.Trim()
        if ($line -match '^\s*#' -or $line -eq "") { return }
        if ($line -match '^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
            $k = $Matches[1]
            $v = $Matches[2].Trim()
            if ($v.Length -ge 2 -and $v.StartsWith('"') -and $v.EndsWith('"')) {
                $v = $v.Substring(1, $v.Length - 2)
            }
            Set-Item -Path "env:$k" -Value $v
        }
    }
}

function Test-ApiHealthy {
    param([int]$Port)
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" -UseBasicParsing -TimeoutSec 3
        return ($r.StatusCode -eq 200)
    } catch {
        return $false
    }
}

function Test-PortListen {
    param([int]$Port)
    $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    return $null -ne $c
}

function Ensure-PathPrefix {
    $prefixes = @(
        "C:\Program Files\nodejs",
        "$env:LOCALAPPDATA\Programs\Python\Python312",
        "$env:LOCALAPPDATA\Programs\Python\Python312\Scripts",
        "$env:USERPROFILE\.cargo\bin",
        "C:\mingw64\bin"
    )
    foreach ($p in $prefixes) {
        if ((Test-Path $p) -and ($env:Path -notlike "*$p*")) {
            $env:Path = "$p;$env:Path"
        }
    }
}

$RepoRoot = Get-RepoRoot
Set-Location $RepoRoot
Import-BackendEnv -RepoRoot $RepoRoot
Ensure-PathPrefix

$apiPort = 3001
if ($env:PORT -match '^\d+$') { $apiPort = [int]$env:PORT }

$releaseExe = Join-Path $RepoRoot "backend\target\release\mt5-panel-api.exe"
$debugExe = Join-Path $RepoRoot "backend\target\debug\mt5-panel-api.exe"
$apiExe = if (Test-Path $releaseExe) { $releaseExe } elseif (Test-Path $debugExe) { $debugExe } else { $null }

if (-not (Test-ApiHealthy -Port $apiPort)) {
    if (-not $apiExe) {
        Write-Error "No mt5-panel-api.exe found. From repo root run: cargo build --release --manifest-path backend/Cargo.toml"
        exit 1
    }
    $null = Start-Process -FilePath $apiExe -WorkingDirectory $RepoRoot -WindowStyle Hidden -PassThru

    $deadline = (Get-Date).AddSeconds(45)
    while ((Get-Date) -lt $deadline) {
        if (Test-ApiHealthy -Port $apiPort) { break }
        Start-Sleep -Milliseconds 500
    }
    if (-not (Test-ApiHealthy -Port $apiPort)) {
        Write-Error "API did not become healthy on port $apiPort. Check backend logs under $RepoRoot\logs\"
        exit 1
    }
}

if (-not (Test-PortListen -Port 5173)) {
    $frontend = Join-Path $RepoRoot "frontend"
    $npmCmd = "C:\Program Files\nodejs\npm.cmd"
    if (-not (Test-Path $npmCmd)) { $npmCmd = "npm.cmd" }
    $null = Start-Process -FilePath $npmCmd -ArgumentList @("run", "dev") -WorkingDirectory $frontend -WindowStyle Hidden
}

exit 0
