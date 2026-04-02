# Run MT5 Panel - start backend and frontend.
# Prerequisites: backend built (.\build-backend.ps1), both MT5 terminals running with Algo Trading enabled.
# Open TWO terminals and run:
#   Terminal 1: .\backend\target\release\mt5-panel-api.exe
#   Terminal 2: cd frontend; npm run dev -- --host
# Then open http://localhost:5173 (or http://SERVER_IP:5173 from another PC).

Write-Host "Start the backend in one terminal:" -ForegroundColor Cyan
Write-Host "  cd C:\metabot" -ForegroundColor White
Write-Host "  .\backend\target\release\mt5-panel-api.exe" -ForegroundColor White
Write-Host ""
Write-Host "Start the frontend in another terminal:" -ForegroundColor Cyan
Write-Host "  cd C:\metabot\frontend" -ForegroundColor White
Write-Host "  npm run dev -- --host" -ForegroundColor White
Write-Host ""
Write-Host "Then open: http://localhost:5173" -ForegroundColor Green
