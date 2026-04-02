# Stop processes listening on Vite (5173) then panel API (3001) on this PC.
# Stops whatever owns those ports (may include other apps if they use the same ports).
$ErrorActionPreference = "SilentlyContinue"

function Stop-PortListeners {
    param([int]$Port)
    Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique |
        ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
}

Stop-PortListeners -Port 5173
Stop-PortListeners -Port 3001
Write-Host "Stopped listeners on 5173 and 3001 (if any)."
