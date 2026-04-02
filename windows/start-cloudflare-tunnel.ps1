# Expose the local panel API (default port 3001) to the internet via Cloudflare Quick Tunnel.
# Use the printed https://....trycloudflare.com URL as "Panel API URL" on client laptops (any network).
#
# Requirements: Panel API already running on this PC (e.g. autostart or cargo run).
# Security: The URL is public. Use a strong AGENT_ADMIN_KEY; consider PANEL_API_KEY and operator auth.
# Note: Quick Tunnel URL changes each time you restart this script unless you configure a named tunnel in Cloudflare.
param(
    [int]$LocalPort = 3001
)
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$toolsDir = Join-Path $here "tools"
$cfExe = Join-Path $toolsDir "cloudflared.exe"

if (-not (Test-Path $cfExe)) {
    New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
    Write-Host "Downloading cloudflared (first run only)..." -ForegroundColor Cyan
    $headers = @{ "User-Agent" = "desktop_bot-setup" }
    $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/cloudflare/cloudflared/releases/latest" -Headers $headers
    $asset = $rel.assets | Where-Object { $_.name -eq "cloudflared-windows-amd64.exe" } | Select-Object -First 1
    if (-not $asset) {
        Write-Error "Could not find cloudflared-windows-amd64.exe in latest GitHub release."
    }
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $cfExe -UseBasicParsing
    Write-Host "Saved: $cfExe" -ForegroundColor Green
}

$target = "http://127.0.0.1:$LocalPort"
Write-Host ""
Write-Host "Starting Cloudflare Quick Tunnel -> $target" -ForegroundColor Yellow
Write-Host "Wait for the line: https://....trycloudflare.com" -ForegroundColor Yellow
Write-Host "Use that full URL (https, no :3001) as Panel API URL on the client agent." -ForegroundColor Yellow
Write-Host "Leave this window open while clients connect. Ctrl+C stops the tunnel." -ForegroundColor Yellow
Write-Host ""

& $cfExe tunnel --url $target
