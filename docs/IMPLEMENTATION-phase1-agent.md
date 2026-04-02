# Phase 1/2 — Remote agent hub + worker (implemented)

This document describes what was added in the first implementation steps: a **device registry**, **pairing codes**, **heartbeats**, a **command queue**, a **Python desktop agent** that executes orders on the machine where MT5 runs, and a **server-scheduled remote worker** (`fixed_lot_tick`).

Full product architecture remains in [PLAN-remote-desktop-agent-and-central-panel.md](./PLAN-remote-desktop-agent-and-central-panel.md).

## What was added

### Backend (Rust)

New module: `backend/src/agent.rs`

- Persists state to `backend/data/agent_state.json` (same data directory as other panel JSON files).
- Endpoints (all under the existing API, default port `3001`):

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/agent/pairing-codes` | Create pairing code (requires `admin_key` in JSON body). |
| POST | `/api/agent/register` | Exchange pairing code for `device_id` + `token`. |
| POST | `/api/agent/heartbeat` | Device liveness (`Authorization: Bearer`, `X-Device-Id`). |
| GET | `/api/agent/commands/next` | Device pulls next command. |
| POST | `/api/agent/commands/complete` | Device reports result. |
| POST | `/api/agent/commands/enqueue` | Operator enqueues work (`admin_key` + `device_id` + `type` + `payload`). |
| POST | `/api/agent/devices/list` | List devices (`admin_key`). |
| POST | `/api/agent/commands/list` | List recent commands (optionally filtered by device). |
| POST | `/api/agent/worker/get` | Read remote worker config for one device. |
| POST | `/api/agent/worker/set` | Save remote worker config for one device. |

### Environment

- **`AGENT_ADMIN_KEY`** — required in practice for production. If unset, defaults to `dev-admin-change-me` (change this before any real use).
- **`AGENT_TOKEN_PEPPER`** — optional secret concatenated into SHA-256 when persisting device bearer tokens. Set before pairing production agents; changing it invalidates stored tokens (agents must pair again). See `backend/.env.example`.
- **`POST /api/agent/register`** — rate-limited per client IP (token-bucket: short burst, then ~1 request/sec sustained). The key is taken from `X-Forwarded-For` / `X-Real-IP` / `Forwarded` when present, else the TCP peer IP — only safe if untrusted clients cannot hit the API without a proxy that sets these headers.
- **`CORS_ALLOWED_ORIGINS`** — optional comma-separated browser origins (e.g. `http://localhost:5173`). If unset, the API allows any origin (dev default; set explicitly for public deployment).
- **`PANEL_API_KEY`** — optional. When set, every `/api/*` and `/ws/*` request must include the key (`X-Panel-Api-Key` or `Authorization: Bearer`, or WebSocket query `panel_key=`), except `GET /api/health`, CORS `OPTIONS`, and agent polling routes (`register`, `heartbeat`, `commands/next`, `commands/complete`). Vite dev: put the same value in `frontend/.env` as `PANEL_API_KEY` so the proxy adds the header; for WebSockets from the browser when not using the proxy, use `VITE_PANEL_API_KEY` (exposed in JS) or terminate at nginx and inject the header (see `deploy/nginx-mt5-panel.example.conf`).
- **Response hardening** — API responses get baseline headers when missing: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` (restrictive defaults for geo/mic/camera). At startup the process logs **warnings** if `AGENT_ADMIN_KEY` is still the dev default or `PANEL_API_KEY` is unset.

### Operator login (accounts, MFA, roles)

- **`OPERATOR_JWT_SECRET`** — at least 16 characters; signs HttpOnly cookie `mt5_operator` after login.
- **`backend/data/operators.json`** — user list (Argon2 password hashes). If the file is **missing**, you can create the first admin with **`OPERATOR_BOOTSTRAP_PASSWORD`** (and optional **`OPERATOR_BOOTSTRAP_ADMIN_USER`**, default `admin`) on first server start; **`OPERATOR_JWT_SECRET`** must be set first.
- Auth is **active** when the secret is set and `operators.json` has at least one user. Then each `/api/*` and `/ws/*` request must present **either** a valid operator JWT (cookie or `Authorization: Bearer <jwt>`) **or** satisfy **`PANEL_API_KEY`** if that env is set (for automation).
- **Roles**: `admin` (full UI and API writes) and `viewer` (GET only; panel shows **Live Positions** only).
- **MFA**: `POST /api/auth/mfa/setup` (admin JWT) returns `otpauth_url`; `POST /api/auth/mfa/confirm` with `{ "code": "123456" }` enables TOTP on that account. Then login requires `{ "username", "password", "totp" }`.
- **Add users**: `POST /api/auth/users` with admin JWT, body `{ "username", "password", "role": "admin"|"viewer" }` (password length ≥ 8).
- **CORS with cookies**: set **`CORS_ALLOWED_ORIGINS`** (e.g. `http://localhost:5173`) so the browser can send cookies with `credentials`; `allow_credentials` is enabled when that list is non-empty.

| Method | Path | Notes |
|--------|------|--------|
| POST | `/api/auth/login` | `{ username, password, totp? }` → sets cookie |
| POST | `/api/auth/logout` | Clears cookie |
| GET | `/api/auth/me` | `{ operator_auth_enabled, authenticated, user? }` |
| POST | `/api/auth/mfa/setup` | Admin; returns TOTP URL |
| POST | `/api/auth/mfa/confirm` | Admin; `{ code }` |
| POST | `/api/auth/users` | Admin; create/replace operator |

### Desktop agent (Python)

Directory: `desktop_agent/`

- `mt5_remote_agent.py` — registers (optional), heartbeats, polls commands, runs `mt5_bridge.py` for `place_market_order`.
- `config.example.json` — copy to `config.json` (gitignored) and set paths.
- `requirements.txt` — `requests`.

## Quick test (local)

### 1. Start the API from project root

```powershell
cd c:\xampp\htdocs\metatrader_bot
cargo run --manifest-path backend/Cargo.toml
```

If rebuild fails with “Access denied” on `mt5-panel-api.exe`, stop any running instance of the API and build again.

### 2. Create a pairing code

```powershell
$admin = "dev-admin-change-me"
Invoke-RestMethod -Method POST -Uri "http://127.0.0.1:3001/api/agent/pairing-codes" -ContentType "application/json" -Body (@{ admin_key = $admin } | ConvertTo-Json)
```

Note the `code` (8 characters).

### 3. Configure and run the agent (on the MT5 PC)

```powershell
cd c:\xampp\htdocs\metatrader_bot\desktop_agent
copy config.example.json config.json
# Edit config.json: bridge_script, python_exe, accounts -> terminal paths
$env:PAIRING_CODE = "THECODEHERE"
$env:DEVICE_LABEL = "Exness laptop"
py -3 -m pip install -r requirements.txt
py -3 mt5_remote_agent.py
```

After first successful pairing, `device_id` and `token` are written to `config.json`. You can remove `PAIRING_CODE` for later runs.

### 4. List devices

```powershell
Invoke-RestMethod -Method POST -Uri "http://127.0.0.1:3001/api/agent/devices/list" -ContentType "application/json" -Body (@{ admin_key = $admin } | ConvertTo-Json)
```

### 5. Enqueue a market order (remote)

Replace `DEVICE_ID` with the id from list/register:

```powershell
$body = @{
  admin_key = $admin
  device_id = "DEVICE_ID"
  type = "place_market_order"
  ttl_sec = 300
  payload = @{
    account_id = "exness"
    symbol = "EURUSDm"
    order_type = "buy"
    volume = 0.01
    comment = "phase1-test"
  }
} | ConvertTo-Json -Depth 5

Invoke-RestMethod -Method POST -Uri "http://127.0.0.1:3001/api/agent/commands/enqueue" -ContentType "application/json" -Body $body
```

The agent should pick up the command, call MT5, and mark the command complete.

## Security notes (Phase 1)

- **Admin key** and **device tokens** are stored in plaintext in `agent_state.json` on the server and in `config.json` on the agent machine. Suitable for lab use only.
- Before production: HTTPS only, strong secrets, token hashing at rest, MFA for operators, rate limits, and threat modeling per the main plan document.

## Panel UI

- Sidebar: **Remote devices** (`#remoteagents` or `#agents`).
- Enter the same **admin key** as `AGENT_ADMIN_KEY` on the API (saved in browser localStorage).
- **Refresh device list** / auto-refresh every 12s.
- **New pairing code** — shows code for the desktop agent.
- Table: online/offline (heartbeat within ~90s), MT5 status from last agent check, device id.
- **Enqueue market order** — pick device, `account_id` (must exist in agent `config.json`), symbol, side, volume, comment.
- **Remote worker (Fixed Lot)** — enable/disable, account list, symbol list, min/max volume, min/max interval, max-open cap.
- **Recent command history** — last command rows with status (`pending`, `in_flight`, `done`, `failed`, `expired`).

Optional: set `VITE_AGENT_ADMIN_KEY` in `frontend/.env.local` to pre-fill the key in dev builds.

## Ready-to-use checklist

1. Backend running with `AGENT_ADMIN_KEY` set.
2. Panel running; open `#remoteagents`.
3. Create pairing code.
4. On remote PC, run desktop agent (`PAIRING_CODE=...` first run).
5. Confirm device shows online and MT5 status updates.
6. Enqueue a manual order.
7. Save remote worker config with symbols and enable worker.
8. Confirm command history shows periodic `fixed_lot_tick` commands completing.

## Next steps (still not done yet)

- WebSocket live updates for device/command status (currently polling).
- Postgres migration for multi-instance API and durable multi-tenant scaling.
- Signed Windows installer + auto-update channel.
- Operator authentication (MFA/RBAC) instead of admin key only.
