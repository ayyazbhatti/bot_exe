# Remove the MT5 Panel autostart scheduled task.
$ErrorActionPreference = "Stop"
$taskName = "MT5Panel-AutoStart"
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "Removed scheduled task '$taskName' (if it existed)."
