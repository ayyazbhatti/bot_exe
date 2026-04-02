# MT5 remote agent (Phase 1)

Runs on the PC where MetaTrader 5 is installed. Connects to the panel API, receives `place_market_order` commands, and executes them via `python_bridge/mt5_bridge.py`.

**Setup:** See [docs/IMPLEMENTATION-phase1-agent.md](../docs/IMPLEMENTATION-phase1-agent.md).

## Windows executable (.exe)

On a **build** machine (Python 3.10+; needs internet once to download embeddable CPython and pip packages):

```powershell
cd desktop_agent
pip install -r requirements-build.txt
.\build_exe.ps1
```

This produces `dist/MT5RemoteAgent/`:

- `MT5RemoteAgent.exe` and `_internal/` (PyInstaller)
- `python_bridge/`
- `runtime/python/` — **embeddable Python** with **MetaTrader5** already installed (no global Python required on the trading PC)
- `config.example.json` — template using the bundled interpreter (`config.dist.example.json` in this repo)

Zip **`dist/MT5RemoteAgent`** as a whole, or use the installer below. The trading PC normally installs **once** via the Setup program; you do not hand-copy folders unless you prefer a portable zip.

**First pairing:** on Windows, the packaged **`MT5RemoteAgent.exe`** opens a small **pairing window** (paste the code from the panel). No need for `PAIR_FIRST_RUN.bat` unless you prefer it. Set **`MT5_AGENT_NO_GUI=1`** to force console-only + `PAIRING_CODE` env instead.

### Single-file installer (Inno Setup)

1. Install [Inno Setup 6](https://jrsoftware.org/isdl.php) on the build PC.
2. Run:

```powershell
cd desktop_agent
.\build_installer.ps1
```

Output: `desktop_agent/installer_output/MT5RemoteAgent-Setup-0.2.0.exe` (version from `mt5_remote_agent.iss`). The trading PC runs this installer; it copies the same folder tree under `Program Files`.

If Inno Setup is not installed, `build_installer.ps1` still finishes the portable `dist` folder and tells you to zip it manually.

**Refresh embeddable version:** edit `EmbedVersion` in `prepare_portable_runtime.ps1`. Delete `dist\MT5RemoteAgent\runtime` (and optionally `.python_embed_cache`) before rebuilding.

### Develop from source (repo Python)

Use **`config.example.json`** with `"python_exe": "py"` and install MetaTrader5 in that environment (`pip install MetaTrader5`).

### On the trading PC

1. Run the **installer** or extract the **zip** (keep `MT5RemoteAgent.exe`, `_internal`, `python_bridge`, and `runtime` in the same folder).
2. Ensure **`config.json`** exists (the build script ships one; if missing, **`config.example.json`** is copied automatically on first run).
3. Set **`accounts`** in **`config.json`** to your MT5 **`terminal64.exe`** paths if defaults are wrong.
4. **First-time pairing:** double-click **`MT5RemoteAgent.exe`** and use the **pairing window** (panel URL + code). Optional: **`PAIR_FIRST_RUN.bat`** or env **`PAIRING_CODE`**.
5. After **`device_id`** / **`token`** are saved, **`MT5RemoteAgent.exe`** reconnects automatically on the next run (console + polling, or minimize the status window if you paired via GUI).

`bridge_script` is relative to the folder that contains the `.exe` (default `python_bridge/mt5_bridge.py`). `python_exe` in shipped config points at `runtime/python/python.exe`.

Windows may show **SmartScreen** for an unsigned installer; signing the `.exe` is optional and requires a code-signing certificate.
