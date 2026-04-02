# Push c:\desktop_bot to https://github.com/ayyazbhatti/bot_exe
# Requires: Git for Windows (https://git-scm.com/download/win)
# Auth: GitHub HTTPS needs a Personal Access Token (not your password), or use SSH remote instead.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Error "Git is not installed or not on PATH. Install Git for Windows, then re-run this script."
}

$remoteUrl = "https://github.com/ayyazbhatti/bot_exe.git"

if (-not (Test-Path ".git")) {
    git init
}

$hasRemote = git remote get-url origin 2>$null
if ($LASTEXITCODE -ne 0) {
    git remote add origin $remoteUrl
} else {
    git remote set-url origin $remoteUrl
}

git add -A
$status = git status --porcelain
if ($status) {
    git commit -m "Initial commit: MT5 panel, remote agent, live positions"
} else {
    Write-Host "Nothing new to commit (working tree clean)."
}

git branch -M main
Write-Host "Pushing to $remoteUrl ..."
git push -u origin main
Write-Host "Done."
