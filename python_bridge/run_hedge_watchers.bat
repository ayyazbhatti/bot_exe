@echo off
REM Start both hedge watchers for millisecond-grade orphan close.
REM Run from project root: python_bridge\run_hedge_watchers.bat
REM Or: start two terminals and run in each:
REM   python python_bridge/hedge_watcher.py default
REM   python python_bridge/hedge_watcher.py exness

cd /d "%~dp0"
cd ..

start "Hedge watcher default" cmd /k python python_bridge\hedge_watcher.py default
timeout /t 1 /nobreak >nul
start "Hedge watcher exness" cmd /k python python_bridge\hedge_watcher.py exness

echo Started two hedge watcher windows. Close them to stop.
