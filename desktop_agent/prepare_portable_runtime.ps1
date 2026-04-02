# Download embeddable CPython, enable pip/site-packages, install MetaTrader5 into dist layout.
# Requires network on the build machine. Cache under .python_embed_cache/
param(
    [string]$InstallRoot = (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "dist\MT5RemoteAgent")
)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$EmbedVersion = "3.12.10"
$pyRoot = Join-Path $InstallRoot "runtime\python"
$zipUrl = "https://www.python.org/ftp/python/$EmbedVersion/python-$EmbedVersion-embed-amd64.zip"
$cacheDir = Join-Path $here ".python_embed_cache"
$zipName = "python-$EmbedVersion-embed-amd64.zip"
$zipPath = Join-Path $cacheDir $zipName
$getPipPath = Join-Path $cacheDir "get-pip.py"

New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null

if (-not (Test-Path $zipPath)) {
    Write-Host "Downloading embeddable Python $EmbedVersion ..."
    Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing
}

$pyExe = Join-Path $pyRoot "python.exe"
if (-not (Test-Path $pyExe)) {
    Write-Host "Extracting embeddable Python to $pyRoot ..."
    New-Item -ItemType Directory -Force -Path $pyRoot | Out-Null
    Expand-Archive -LiteralPath $zipPath -DestinationPath $pyRoot -Force
}

$pthFile = Get-ChildItem -LiteralPath $pyRoot -Filter "python*._pth" -File | Select-Object -First 1
if (-not $pthFile) {
    Write-Error "No python*._pth in $pyRoot (embed layout broken?)"
}
$pthText = Get-Content -LiteralPath $pthFile.FullName -Raw
if ($pthText -notmatch '(?m)^import site\s*$') {
    Add-Content -LiteralPath $pthFile.FullName -Value "`r`nimport site`r`n"
}

if (-not (Test-Path $getPipPath)) {
    Write-Host "Downloading get-pip.py ..."
    Invoke-WebRequest -Uri "https://bootstrap.pypa.io/get-pip.py" -OutFile $getPipPath -UseBasicParsing
}

$saveEap = $ErrorActionPreference
$ErrorActionPreference = "SilentlyContinue"
& $pyExe -m pip --version 2>&1 | Out-Null
$pipOk = ($LASTEXITCODE -eq 0)
$ErrorActionPreference = $saveEap
if (-not $pipOk) {
    Write-Host "Installing pip into portable Python ..."
    & $pyExe $getPipPath --no-warn-script-location --quiet
    if ($LASTEXITCODE -ne 0) {
        Write-Error "get-pip failed for $pyExe"
    }
}

$ErrorActionPreference = "SilentlyContinue"
& $pyExe -c "import MetaTrader5" 2>&1 | Out-Null
$mt5Ok = ($LASTEXITCODE -eq 0)
$ErrorActionPreference = $saveEap
if (-not $mt5Ok) {
    Write-Host "pip install MetaTrader5 (official MT5 Python API) ..."
    & $pyExe -m pip install --disable-pip-version-check --no-warn-script-location -q MetaTrader5
    if ($LASTEXITCODE -ne 0) {
        Write-Error "pip install MetaTrader5 failed"
    }
}

Write-Host "Portable runtime ready: $pyRoot"
