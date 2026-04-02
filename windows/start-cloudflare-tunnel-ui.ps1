# Expose the local Vite dev server (panel UI, default port 5173) via a NEW Cloudflare Quick Tunnel.
# This does NOT change your existing API tunnel — run that separately with start-cloudflare-tunnel.ps1.
#
# After this prints https://….trycloudflare.com (UI URL):
# 1) Add to frontend/.env.local (then restart npm run dev):
#      VITE_API_ORIGIN=https://YOUR-EXISTING-API-TUNNEL.trycloudflare.com
#    Use the same API URL you already use for remote agents (no :3001).
# 2) On the API, add the NEW UI tunnel origin to CORS_ALLOWED_ORIGINS (comma-separated), e.g.:
#      CORS_ALLOWED_ORIGINS=http://localhost:5173,https://YOUR-NEW-UI-TUNNEL.trycloudflare.com
#
# Requirements: npm run dev already running (Vite on 127.0.0.1:5173).
# Security: UI tunnel is public; protect with operator auth + PANEL_API_KEY as you do for the API.
param(
    [int]$LocalPort = 5173
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
Write-Host "=== Panel UI tunnel (Vite) — separate from API tunnel ===" -ForegroundColor Cyan
Write-Host "Forwarding: $target" -ForegroundColor Yellow
Write-Host "Wait for: https://....trycloudflare.com  -> open that URL in a browser (anywhere)." -ForegroundColor Yellow
Write-Host ""
Write-Host "Required: frontend/.env.local with VITE_API_ORIGIN=<your EXISTING API trycloudflare URL>" -ForegroundColor Green
Write-Host "Required: API CORS_ALLOWED_ORIGINS includes this NEW UI https URL (comma-separated)." -ForegroundColor Green
Write-Host "Restart 'npm run dev' after editing .env.local." -ForegroundColor Green
Write-Host "Leave this window open. Ctrl+C stops the UI tunnel only." -ForegroundColor Yellow
Write-Host ""

& $cfExe tunnel --url $target
