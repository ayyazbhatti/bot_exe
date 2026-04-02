# Register a Scheduled Task so the panel API + Vite start at Windows logon (current user).
# Run from elevated PowerShell only if you use -OpenFirewall.
param(
    [switch]$OpenFirewall
)
$ErrorActionPreference = "Stop"

$taskName = "MT5Panel-AutoStart"
$scriptPath = Join-Path $PSScriptRoot "panel-start.ps1"
if (-not (Test-Path $scriptPath)) {
    Write-Error "Missing panel-start.ps1 next to this script."
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$releaseExe = Join-Path $repoRoot "backend\target\release\mt5-panel-api.exe"
$debugExe = Join-Path $repoRoot "backend\target\debug\mt5-panel-api.exe"
if (-not (Test-Path $releaseExe) -and -not (Test-Path $debugExe)) {
    Write-Host ""
    Write-Host "No mt5-panel-api.exe found. Build once from repo root:" -ForegroundColor Yellow
    Write-Host "  cargo build --release --manifest-path backend/Cargo.toml" -ForegroundColor Yellow
    Write-Host ""
}

$arg = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`""
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arg
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description "Starts MT5 Panel API and Vite (http://localhost:5173) from $repoRoot" -Force | Out-Null

Write-Host "Registered scheduled task: $taskName"
Write-Host "It runs at logon for user $env:USERNAME"
Write-Host "Test now:  Start-ScheduledTask -TaskName '$taskName'"
Write-Host "Remove:    .\uninstall-autostart.ps1"

if ($OpenFirewall) {
    try {
        $rule = Get-NetFirewallRule -DisplayName "MT5 Panel API (3001)" -ErrorAction SilentlyContinue
        if (-not $rule) {
            New-NetFirewallRule -DisplayName "MT5 Panel API (3001)" -Direction Inbound -Protocol TCP -LocalPort 3001 -Action Allow | Out-Null
            Write-Host "Added inbound firewall rule for TCP 3001 (remote agents on LAN can reach this PC)."
        } else {
            Write-Host "Firewall rule 'MT5 Panel API (3001)' already exists."
        }
    } catch {
        Write-Warning "Could not add firewall rule (need Administrator): $_"
    }
} else {
    Write-Host ""
    Write-Host "Remote laptops on your LAN need TCP 3001 allowed on this PC. Re-run as Admin with -OpenFirewall, or open the port manually."
}
