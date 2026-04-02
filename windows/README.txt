MT5 Panel — Windows auto-start (control PC)
==========================================

Goal: after you sign in to Windows, the panel API and browser UI start
automatically — no need to run cargo run / npm run dev by hand.

One-time setup
--------------
1) Build the API (release recommended):
   cd <repo root>
   cargo build --release --manifest-path backend/Cargo.toml

2) Ensure backend\.env sets PYTHON_CMD if python is not on PATH (same as manual dev).

3) Register the logon task (normal user is OK):
   cd <repo root>\windows
   powershell -ExecutionPolicy Bypass -File .\install-autostart.ps1

   Optional — allow other PCs on your LAN to reach port 3001 (run PowerShell as Administrator):
   powershell -ExecutionPolicy Bypass -File .\install-autostart.ps1 -OpenFirewall

4) Test without rebooting:
   Start-ScheduledTask -TaskName MT5Panel-AutoStart
   Then open http://localhost:5173

Remove autostart
----------------
  powershell -ExecutionPolicy Bypass -File .\uninstall-autostart.ps1

Stop API + Vite now
-------------------
  powershell -ExecutionPolicy Bypass -File .\panel-stop.ps1

Public URL (client on any network / any Wi‑Fi)
----------------------------------------------
On the ADMIN (panel) PC, with the API already running on port 3001:

  cd <repo root>\windows
  powershell -ExecutionPolicy Bypass -File .\start-cloudflare-tunnel.ps1

The window will show a line like:

  https://random-words.trycloudflare.com

Use that EXACT URL as "Panel API URL" on the client MT5 Remote Agent (https, no :3001).
Leave the tunnel window open while agents connect. Each time you restart the script, the URL changes
unless you set up a permanent Cloudflare tunnel with your own domain.

Security: that URL is on the public internet. Use strong AGENT_ADMIN_KEY; see docs/RUNBOOK.md.

Public browser UI (Vite on 5173) — second tunnel, does not replace the API tunnel above
----------------------------------------------------------------------------------------
With npm run dev running and your API tunnel unchanged:

  powershell -ExecutionPolicy Bypass -File .\start-cloudflare-tunnel-ui.ps1

Set VITE_API_ORIGIN in frontend/.env.local to your existing API trycloudflare URL; add the new UI
URL to CORS_ALLOWED_ORIGINS on the API. Details: docs/RUNBOOK.md section 3.3.

Notes
-----
- The task runs panel-start.ps1: starts mt5-panel-api.exe with working directory = repo root,
  then npm run dev in frontend/ if port 5173 is free.
- Same LAN only: use admin PC IPv4, e.g. http://192.168.x.x:3001 (not 127.0.0.1 on the client).
- Any network: use start-cloudflare-tunnel.ps1 and the https://*.trycloudflare.com URL.
