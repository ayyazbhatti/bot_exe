# Complete setup: main panel + remote desktop agents

This guide is the **end-to-end checklist** for:

- **Panel (main server)** — Rust API + React UI where you trade and manage devices.
- **Client laptops** — Windows **MT5 Remote Agent** (`MT5RemoteAgent.exe`) next to MetaTrader 5, talking to your panel over the network.

For deep details on secrets, TLS, and nginx, see **[RUNBOOK.md](RUNBOOK.md)**. For agent build flags, see **[desktop_agent/README.md](../desktop_agent/README.md)**.

---

## 1. Architecture (short)

| Piece | Where it runs | Role |
|--------|----------------|------|
| **Backend** (`backend/`) | Panel PC or VPS | HTTP API, operator auth, agent pairing, commands to remote PCs. |
| **Frontend** (`frontend/`) | Browser (dev: Vite; prod: static files or same host) | Web UI: trading, **Remote devices**, settings. |
| **Python bridge** (`python_bridge/`) | **Usually the panel PC** (same machine as backend) | Talks to MT5 for orders opened **from the panel** on that machine. |
| **Desktop agent** (`desktop_agent/` → built `.exe`) | **Other laptops** with MT5 | Polls your panel for commands and executes them via `mt5_bridge.py` locally. |

The **panel** does not need MT5 on the server if you only use **remote agents** on other PCs — but typical setups also run MT5 on the panel machine for local trading.

---

## 2. Prerequisites

### Panel (build / run machine)

- **Rust** ([rustup](https://rustup.rs))
- **Node.js** 18+ (for the frontend)
- **Python 3.8+** and `pip install -r python_bridge/requirements.txt` if the backend will call MT5 on this machine
- **Git** (to clone the repo)

### Trading laptops (agent only)

- **Windows** (current agent build is Windows-only)
- **MetaTrader 5** installed and runnable (Exness build, etc.)
- **Network** reachability to your panel’s API URL (same LAN or public HTTPS URL)

---

## 3. Get the code

```powershell
git clone https://github.com/ayyazbhatti/desktop_bot.git
cd desktop_bot
```

(Or use your own fork/path.)

---

## 4. Panel: first-time setup

### 4.1 Python bridge (if MT5 runs on the panel PC)

From the **repository root** (so paths resolve correctly):

```powershell
cd python_bridge
pip install -r requirements.txt
cd ..
```

### 4.2 Frontend dependencies

```powershell
cd frontend
npm install
cd ..
```

### 4.3 Backend build

```powershell
cargo build --manifest-path backend/Cargo.toml
```

### 4.4 Backend configuration

1. Copy `backend/.env.example` → `backend/.env` (or set environment variables in your process manager).
2. Minimum for a **serious** setup:
   - **`OPERATOR_JWT_SECRET`** — ≥16 characters (operator login).
   - **`CORS_ALLOWED_ORIGINS`** — e.g. `http://localhost:5173` for dev, or your real panel URL in production.
   - **`AGENT_ADMIN_KEY`** — long random string (Remote devices + pairing).  
     *Alternatively*, leave default for local tests only, or set the key later from the UI (**Remote devices** → server admin key); that writes `backend/data/agent_admin_key.txt` and overrides env on restart.

See **[RUNBOOK.md](RUNBOOK.md)** for the full variable table.

### 4.5 Frontend dev proxy (optional `.env.local`)

Create **`frontend/.env.local`** (gitignored) if you need a non-default API port or `PANEL_API_KEY` matching the backend:

```env
API_PORT=3001
# PANEL_API_KEY=your-key-if-backend-uses-it
```

---

## 5. Run the panel (development)

Use **two terminals**, both from the repo root (or adjust paths).

**Terminal A — API**

```powershell
cd C:\path\to\desktop_bot
cargo run --manifest-path backend/Cargo.toml
```

API: **http://127.0.0.1:3001** (check `GET /api/health`).

**Terminal B — UI**

```powershell
cd C:\path\to\desktop_bot\frontend
npm run dev
```

Open **http://localhost:5173**. Vite proxies `/api` and `/ws` to the backend.

**Operator login:** if `OPERATOR_JWT_SECRET` is set and `backend/data/operators.json` exists, use the login page. First-time bootstrap is described in **[RUNBOOK.md](RUNBOOK.md)**.

**Windows — auto-start at logon (panel PC):** so you do not open two terminals after every reboot, use **`windows/install-autostart.ps1`** (see **`windows/README.txt`** and **[RUNBOOK.md](RUNBOOK.md)** §3.1).

---

## 6. Remote devices in the UI

1. Sign in (if operator auth is enabled).
2. Open **Remote devices**.
3. Enter the **admin key** (same as server `AGENT_ADMIN_KEY`, or what you saved via the server admin key UI).
4. Click **New pairing code** and copy the code (short lifetime).

---

## 7. Build the client installer (on a Windows build PC)

On a machine with **Python 3.10+** and this repo:

```powershell
cd desktop_agent
pip install -r requirements-build.txt
.\build_exe.ps1
```

Output folder:

`desktop_agent\dist\MT5RemoteAgent\`

It contains `MT5RemoteAgent.exe`, `_internal`, `python_bridge`, `runtime` (bundled Python + MetaTrader5 package), and `config.json` / examples.

**Single setup program (optional):** install [Inno Setup 6](https://jrsoftware.org/isdl.php), then:

```powershell
.\build_installer.ps1
```

Produces an installer under `desktop_agent\installer_output\` you can copy to other laptops.

---

## 8. Install the agent on another laptop

### Option A — Zip the built folder

Zip **the entire** `MT5RemoteAgent` folder (do not move only the `.exe`). Extract on the laptop and keep all subfolders next to the exe.

### Option B — Inno installer

Run the generated `MT5RemoteAgent-Setup-*.exe` and install to e.g. Program Files.

### Configure before or after pairing

- Edit **`config.json`** next to `MT5RemoteAgent.exe`:
  - **`api_base`** — must be reachable from that laptop, e.g. `http://YOUR_PANEL_IP:3001` or `https://your-domain` if you terminate TLS in front of the API.
  - **`accounts`** — full paths to each MT5 **`terminal64.exe`** on **that** machine (Exness path, etc.).

---

## 9. Pairing the laptop (first time)

On the **trading PC**, run **`MT5RemoteAgent.exe`**:

- A **pairing window** opens (Windows packaged build). Paste the **panel URL** and **pairing code**, then **Register**.
- Alternatively set environment variable **`PAIRING_CODE`** before launch, or use **`PAIR_FIRST_RUN.bat`** in the same folder.

After success, `config.json` stores `device_id` and `token`. The agent then polls the panel for commands. Keep the app running (or add a Scheduled Task / Startup shortcut).

---

## 10. Production panel (short)

- Build frontend: `cd frontend && npm run build`.
- Serve `frontend/dist` and reverse-proxy `/api` and `/ws` to the Rust process, ideally **HTTPS**.
- Set **`CORS_ALLOWED_ORIGINS`** to your real panel origin.
- Prefer **`PANEL_API_KEY`** or network restrictions so the API is not public without authentication.

Example nginx layout: **[deploy/nginx-mt5-panel.example.conf](../deploy/nginx-mt5-panel.example.conf)**.

---

## 11. Firewall & networking

- **Panel API port** (default **3001**) must accept **inbound** connections from agent PCs if they connect over the LAN/internet.
- Agents use **HTTP(S)** to `api_base`; ensure URL, TLS, and DNS are correct.
- **WebSocket** (`/ws/...`) is used by the browser; agents use REST polling by default.

---

## 12. Backup

- Back up **`backend/data/`** (operators, agent state, optional `agent_admin_key.txt`, pairs, worker config). It is gitignored and holds live state.

---

## 13. Troubleshooting

| Symptom | What to check |
|--------|----------------|
| Browser `/api/auth/me` 404 | Backend not running or wrong port; restart `cargo run` for `backend`. |
| Remote devices unauthorized | Admin key in UI ≠ server key; or set key in UI / `backend/data/agent_admin_key.txt`. |
| Agent exits immediately | Missing `config.json` or not paired; run exe again for pairing window. |
| Agent cannot register | `api_base` wrong or firewall; panel must expose `/api/agent/register`. |
| Orders fail on remote PC | `accounts` paths in agent `config.json` must point to real `terminal64.exe` on that PC; MT5 running and algo trading allowed. |

---

## 14. Related docs

| Doc | Content |
|-----|--------|
| [RUNBOOK.md](RUNBOOK.md) | Env vars, CORS, TLS, bootstrap admin, backups |
| [IMPLEMENTATION-phase1-agent.md](IMPLEMENTATION-phase1-agent.md) | Agent API endpoints |
| [desktop_agent/README.md](../desktop_agent/README.md) | Building the `.exe`, portable Python, Inno |

---

*Last aligned with repo layout: `backend/`, `frontend/`, `desktop_agent/`, `python_bridge/`.*
