# MT5 Panel

Simple web panel to open positions on **MetaTrader 5**: **Rust** backend, **React + TypeScript** frontend, and a small **Python** bridge to talk to MT5.

## Checklist for opening positions (all must be true)

1. **MetaTrader 5** is **running** and you are **logged in** (demo or live).
2. **Backend** is started **from the project root** so it finds `python_bridge/mt5_bridge.py`.
3. **Python** is on your PATH as `python` or `py` (or set `PYTHON_CMD`).
4. In MT5, **Allow Algo Trading** is enabled (Toolbar or right‑click chart).
5. **Frontend** is open at http://localhost:5173 and the API at http://localhost:3001 is reachable (Vite proxies `/api` to 3001).

## Operations & production

- **[docs/SETUP-COMPLETE.md](docs/SETUP-COMPLETE.md)** — **full checklist**: main panel + building/installing the remote desktop agent `.exe` on other laptops.
- **[docs/RUNBOOK.md](docs/RUNBOOK.md)** — environment variables (operator login, Vite, `AGENT_ADMIN_KEY`, pairing), TLS + nginx, secrets, and `backend/data/` backups.

## Requirements

- **MetaTrader 5** installed and running (logged into an account).
- **Rust** (e.g. [rustup](https://rustup.rs)).
- **Node.js** 18+ (for the frontend).
- **Python 3.8+** with the bridge dependencies (`pip install -r python_bridge/requirements.txt`).

## Setup

### 1. Python bridge (MT5)

From the project root:

```bash
cd python_bridge
pip install -r requirements.txt
cd ..
```

### 2. Frontend

```bash
cd frontend
npm install
cd ..
```

### 3. Backend (Rust)

From the **project root** (`bot3`), so the backend can find `python_bridge`:

```bash
cargo build --manifest-path backend/Cargo.toml
```

## Run

1. **Start MetaTrader 5** and log in.

2. **Start the API** (from project root):

   ```bash
   cargo run --manifest-path backend/Cargo.toml
   ```
   API runs at **http://localhost:3001**.

3. **Start the frontend** (new terminal):

   ```bash
   cd frontend
   npm run dev
   ```
   Open **http://localhost:5173** in your browser. The dev server proxies `/api` to the Rust backend.

## Multiple MT5 accounts

You can run **two** MT5 terminals (e.g. `C:\Program Files\MetaTrader 5` and `C:\Program Files\MetaTrader 5 EXNESS`). In the panel, use the **Account** dropdown to choose which terminal to use. Symbols, positions, and new orders use the selected account. Each terminal must be running and logged in.

To add more accounts, edit `backend/src/main.rs`: add an entry to `ACCOUNT_LIST` and a branch in `get_terminal_path()` with the path to that terminal’s `terminal64.exe`.

### After changing to new Meta accounts (same terminals)

To start placing positions again via the **bot worker** with the new accounts:

1. **MT5**: Open **both** terminals, log in to the **new** accounts, and enable **Allow Algo Trading** in each.
2. **Backend**: Ensure the API is running (from project root: `cargo run --manifest-path backend/Cargo.toml`). Restart it if you changed terminal paths in `main.rs`.
3. **Frontend → Settings**: Enable **Enable bot worker**, pick **Symbols** and **Min/Max volume** and **interval**. Optionally click **Reset counter**, **Reset worker balance**, and **Clear list** (failed positions) for a clean start.
4. The worker will then place on both accounts at the set interval. If you use different terminal paths for the new brokers, update `ACCOUNT_LIST` and `get_terminal_path()` in `backend/src/main.rs` and rebuild.

### Hedge sync (close other leg when one closes)

When you open positions on **both** accounts (place on both), the backend tracks pairs. If one leg closes (SL, TP, or manual), the other leg is closed automatically so you are never left unhedged.

- **Without watchers:** The backend checks every **15 seconds** and closes any orphan leg (fallback).
- **With watchers (recommended for fast response):** Run two Python watchers so the other leg is closed within **~50–100 ms**:
  ```bash
  # From project root — open two terminals or use the batch file:
  python python_bridge/hedge_watcher.py default
  python python_bridge/hedge_watcher.py exness
  ```
  Or run `python_bridge\run_hedge_watchers.bat` to start both in new windows.  
  See `docs/FEATURE-hedge-sync-close-other-leg.md` for details.

### Exness copy hedge

When you use **Broker B + Exness (copy hedge)** (Bot Trading or worker place mode), Broker B (e.g. IC Markets) opens the **full** volume and Exness (one account we control) opens **volume ÷ N** lots. Set **N** (number of Exness copy accounts) in **Exness copy hedge** in the nav. Copy trading replicates the single Exness account to N followers, so total Exness exposure matches Broker B. Example: N = 5, volume 1 lot → Broker B 1 lot, Exness 0.2 lot.

## Optional environment variables

- **PYTHON_CMD** – Command to run Python (e.g. `python`, `py`, or `py -3`). If unset, the backend tries `python` then `py -3` on Windows.

## Project layout

- **backend/** – Rust (Axum) API: health, symbols, positions, create position. Calls the Python bridge for MT5.
- **frontend/** – React + TypeScript (Vite): form to open market orders, list of open positions.
- **python_bridge/** – Python script used by the backend to connect to MT5 (symbols, positions, order_send). Adds symbols to Market Watch and validates volume (min/step/max) before sending orders.

## API (Rust)

- `GET /api/health` – liveness JSON: `{ "ok", "service", "version" }` (plus standard security headers on all responses)
- `GET /api/accounts` – list of account ids and labels (for the Account dropdown)
- `GET /api/symbols?account_id=default|exness` – symbols from the chosen MT5 terminal
- `GET /api/positions?account_id=default|exness` – open positions for that terminal
- `POST /api/positions` – create market order on the selected account  
  Body: `{ "symbol", "order_type": "buy"|"sell", "volume", "account_id?", "stop_loss?", "take_profit?", "comment?" }`
- `POST /api/positions/both` – create the same market order on **both** MT5 terminals at once  
  Body: same as above (no `account_id` needed). Returns `{ "ok", "results": [ { "account_id", "label", "ok", "message", "order_ticket?" } ] }`
- `POST /api/positions/master-slave-hedge` – **Exness copy hedge**: Broker B (default) opens **full** volume, Exness opens **volume ÷ N**.  
  Body: `{ "symbol", "order_type": "buy"|"sell", "volume", "comment?" }`. Set N in **Exness copy hedge** (nav). Returns two results (Broker B + Exness).
- `GET /api/exness-config` – get Exness copy count N. Response: `{ "ok", "exness_copy_count": n }`
- `PATCH /api/exness-config` – set N. Body: `{ "exness_copy_count": n }` (n ≥ 1)
