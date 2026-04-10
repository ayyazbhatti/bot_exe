"""
MT5 Remote Agent (Phase 2) — runs on the PC where MetaTrader 5 is installed.

- Registers with the hub using a one-time pairing code (or uses saved device_id + token).
- Sends heartbeats and polls for remote commands.
- Executes:
  - place_market_order (single account)
  - place_market_orders (batch; parallel across different terminal paths)
  - fixed_lot_tick (server-scheduled worker tick)
  - close_positions_selected (close all positions on listed account_ids)
"""

from __future__ import annotations

import json
import math
import os
import queue
import random
import re
import shutil
import subprocess
import sys
import time
import traceback
import threading
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, List

import requests

try:
    import websocket
except ImportError:
    websocket = None  # type: ignore[misc, assignment]

CONFIG_NAME = "config.json"

# MetaTrader5 allows only one Python API attachment per *terminal instance* (path).
# Serialize bridge calls per terminal path; different paths may run in parallel.
_PATH_LOCKS_GUARD = threading.Lock()
_path_bridge_locks: dict[str, threading.Lock] = {}

DEFAULT_POSITIONS_SNAPSHOT_INTERVAL_SEC = 2.0
DEFAULT_HISTORY_DEALS_SNAPSHOT_INTERVAL_SEC = 30.0
MAX_PARALLEL_POSITIONS_BRIDGE = 16
MAX_BATCH_MARKET_ORDERS = 256


def _normalized_terminal_path_key(terminal_path: str) -> str:
    s = (terminal_path or "").strip()
    if not s:
        return ""
    try:
        return str(Path(s).expanduser().resolve())
    except OSError:
        return s


def _lock_for_terminal_path(terminal_path: str) -> threading.Lock:
    key = _normalized_terminal_path_key(terminal_path)
    if not key:
        key = (terminal_path or "").strip() or "."
    with _PATH_LOCKS_GUARD:
        lk = _path_bridge_locks.get(key)
        if lk is None:
            lk = threading.Lock()
            _path_bridge_locks[key] = lk
        return lk


def _cfg_nonneg_float(cfg: dict[str, Any], key: str, default: float, *, lo: float, hi: float) -> float:
    try:
        v = float(cfg.get(key))
        if not math.isfinite(v):
            return default
        return max(lo, min(hi, v))
    except (TypeError, ValueError):
        return default


def _cfg_history_deals_days(cfg: dict[str, Any]) -> int:
    try:
        d = int(cfg.get("history_deals_days", 30))
        return max(1, min(365, d))
    except (TypeError, ValueError):
        return 30


def agent_dir() -> Path:
    """Install directory: exe parent when frozen, else script folder (python_bridge, runtime, templates). Often read-only under Program Files."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def user_data_dir() -> Path:
    """Writable folder for config when the install dir is not writable (e.g. Program Files)."""
    if not getattr(sys, "frozen", False):
        return agent_dir()
    if os.name == "nt":
        local = os.environ.get("LOCALAPPDATA")
        base = Path(local).resolve() if local else Path.home() / "AppData" / "Local"
        return base / "MT5RemoteAgent"
    return Path.home() / ".local" / "share" / "MT5RemoteAgent"


def resolve_bridge_path(cfg: dict[str, Any]) -> Path:
    raw = (cfg.get("bridge_script") or "").strip()
    if not raw:
        return Path()
    p = Path(raw)
    if not p.is_absolute():
        p = agent_dir() / p
    return p.resolve()


def python_invocation(cfg: dict[str, Any]) -> list[str]:
    """Argv prefix to run the bridge script: either ['py', '-3'] or ['C:\\...\\python.exe']."""
    raw = (cfg.get("python_exe") or "py").strip() or "py"
    lower = raw.lower()
    if lower == "py":
        return ["py", "-3"]
    if lower in ("python", "python3"):
        return [raw]
    p = Path(raw)
    if not p.is_absolute():
        p = (agent_dir() / p).resolve()
    else:
        p = p.resolve()
    if p.is_dir():
        p = p / "python.exe"
    if p.name.lower() == "py.exe":
        return [str(p), "-3"]
    return [str(p)]


def load_config(path: Path) -> dict[str, Any]:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def save_config(path: Path, cfg: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)
        f.write("\n")


def config_path() -> Path:
    return user_data_dir() / CONFIG_NAME


def resolve_panel_api_base_for_pairing(cfg: dict[str, Any]) -> str:
    """
    Default Panel API URL before / without relying on manual typing.

    Order:
      1) Environment MT5_AGENT_API_BASE or PANEL_API_URL (for IT / scripts)
      2) File panel_api_url.txt next to the exe (one URL per line; # comments ok)
      3) api_base from config.json
      4) http://127.0.0.1:3001

    The client cannot guess your server on the internet; an admin supplies (2) or (1).
    """
    for key in ("MT5_AGENT_API_BASE", "PANEL_API_URL"):
        v = os.environ.get(key, "").strip()
        if v:
            return v.rstrip("/")
    seen: set[Path] = set()
    for folder in (agent_dir(), user_data_dir()):
        key = folder.resolve()
        if key in seen:
            continue
        seen.add(key)
        url_file = folder / "panel_api_url.txt"
        if url_file.is_file():
            try:
                raw = url_file.read_text(encoding="utf-8")
            except OSError:
                raw = ""
            for line in raw.splitlines():
                line = line.split("#", 1)[0].strip()
                if line:
                    return line.rstrip("/")
    v = (cfg.get("api_base") or "").strip()
    if v:
        return v.rstrip("/")
    return "http://127.0.0.1:3001"


def effective_api_base(cfg: dict[str, Any]) -> str:
    """Use saved api_base when already paired; otherwise discovery order above."""
    paired = bool((cfg.get("device_id") or "").strip() and (cfg.get("token") or "").strip())
    if paired:
        v = (cfg.get("api_base") or "").strip()
        if v:
            return v.rstrip("/")
    return resolve_panel_api_base_for_pairing(cfg)


def pause_if_frozen_exe() -> None:
    """When run as PyInstaller .exe, keep the console open so error text can be read."""
    if not getattr(sys, "frozen", False) or os.name != "nt":
        return
    try:
        input("\nPress Enter to exit...")
    except (EOFError, KeyboardInterrupt):
        pass


def exit_fail(msg: str) -> None:
    print(msg, flush=True)
    pause_if_frozen_exe()
    sys.exit(1)


def hub_headers(cfg: dict[str, Any]) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {cfg['token']}",
        "X-Device-Id": cfg["device_id"],
        "Content-Type": "application/json",
    }


def ws_url_from_api_base(api_base: str) -> str:
    u = api_base.strip().rstrip("/")
    lo = u.lower()
    if lo.startswith("https://"):
        return "wss://" + u[8:]
    if lo.startswith("http://"):
        return "ws://" + u[7:]
    return u


def _account_id_str(aid: Any) -> str:
    """Normalize config / JSON keys so positions_snapshot never skips accounts (e.g. numeric keys)."""
    if aid is None:
        return ""
    s = str(aid).strip()
    return s


def terminals_payload_from_cfg(cfg: dict[str, Any]) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    accounts = cfg.get("accounts") or {}
    if not isinstance(accounts, dict):
        return out
    for aid_raw, p in accounts.items():
        aid = _account_id_str(aid_raw)
        if not aid or not str(p).strip():
            continue
        ps = str(p).strip()
        out.append({"id": aid, "label": aid, "exe_path": ps})
    return out


def _configured_terminal_count(cfg: dict[str, Any]) -> int:
    """How many account→terminal paths are set (same as snapshot task count)."""
    accounts = cfg.get("accounts") or {}
    if not isinstance(accounts, dict):
        return 0
    n = 0
    for aid_raw, term_path in accounts.items():
        if _account_id_str(aid_raw) and str(term_path).strip():
            n += 1
    return n


def _configured_account_ids(cfg: dict[str, Any]) -> list[str]:
    """Account ids with a terminal path (deduped), for local “close all” and similar."""
    accounts = cfg.get("accounts") or {}
    if not isinstance(accounts, dict):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for aid_raw, term_path in accounts.items():
        aid = _account_id_str(aid_raw)
        if not aid or not str(term_path).strip():
            continue
        if aid in seen:
            continue
        seen.add(aid)
        out.append(aid)
    return out


def _snapshot_summary(results: list[dict[str, Any]]) -> tuple[int, int, int]:
    """(account rows, total open positions, rows with bridge_error)."""
    n_acc = len(results)
    total_pos = 0
    n_bridge_err = 0
    for r in results:
        pos = r.get("positions")
        if isinstance(pos, list):
            total_pos += len(pos)
        if r.get("bridge_error"):
            n_bridge_err += 1
    return n_acc, total_pos, n_bridge_err


def _parse_panel_ws_ack(raw: Any) -> tuple[str | None, str | None]:
    """Return (\"ok\"|\"error\"|None, error detail or None)."""
    if raw is None:
        return None, None
    if isinstance(raw, bytes):
        try:
            raw = raw.decode("utf-8", errors="replace")
        except Exception:
            return None, None
    if not isinstance(raw, str) or not raw.strip():
        return None, None
    try:
        j = json.loads(raw)
    except ValueError:
        return None, None
    if j.get("ok") is True:
        return "ok", None
    if j.get("ok") is False:
        return "error", str(j.get("error") or "unknown")
    return None, None


def _trace_set(
    trace: dict[str, Any] | None,
    trace_lock: threading.Lock | None,
    **kwargs: Any,
) -> None:
    if trace is None or trace_lock is None:
        return
    with trace_lock:
        trace.update(kwargs)
        trace["trace_updated_wall"] = time.strftime("%H:%M:%S")


def _finite_float(x: Any, default: float = 0.0) -> float:
    try:
        v = float(x)
        return v if math.isfinite(v) else default
    except (TypeError, ValueError):
        return default


def _sanitize_position_dicts(positions: Any) -> list[dict[str, Any]]:
    """Ensure JSON-safe floats (no NaN/Inf) so the panel always receives strict JSON."""
    if not isinstance(positions, list):
        return []
    out: list[dict[str, Any]] = []
    for raw in positions:
        if not isinstance(raw, dict):
            continue
        try:
            ticket = raw.get("ticket")
            out.append(
                {
                    "ticket": int(ticket) if ticket is not None else 0,
                    "symbol": str(raw.get("symbol") or ""),
                    "type": str(raw.get("type") or ""),
                    "volume": _finite_float(raw.get("volume")),
                    "price_open": _finite_float(raw.get("price_open")),
                    "sl": _finite_float(raw.get("sl")),
                    "tp": _finite_float(raw.get("tp")),
                    "profit": _finite_float(raw.get("profit")),
                    "comment": str(raw.get("comment") or ""),
                }
            )
        except (TypeError, ValueError):
            continue
    return out


def _flatten_live_tab_rows(
    results: list[dict[str, Any]],
) -> tuple[list[tuple[str, tuple[Any, ...], tuple[str, ...]]], float, int]:
    """Build ordered (iid, values, tags) rows for the Live positions Treeview."""
    rows: list[tuple[str, tuple[Any, ...], tuple[str, ...]]] = []
    total_pnl = 0.0
    n_open = 0
    for row in results:
        aid = str(row.get("account_id") or "")
        lab = str(row.get("label") or "")
        berr = row.get("bridge_error")
        if berr:
            vals = (
                aid,
                lab,
                "",
                "",
                "",
                "",
                "",
                "",
                "",
                "",
                str(berr)[:300],
            )
            rows.append((f"{aid}:err", vals, ("err",)))
            continue
        for pos in row.get("positions") or []:
            if not isinstance(pos, dict):
                continue
            try:
                tix = int(pos.get("ticket") or 0)
            except (TypeError, ValueError):
                tix = 0
            total_pnl += _finite_float(pos.get("profit"))
            n_open += 1
            vals = (
                aid,
                lab,
                str(pos.get("symbol") or ""),
                str(pos.get("type") or ""),
                f"{pos.get('volume', '')!s}",
                f"{pos.get('price_open', '')!s}",
                f"{pos.get('sl', '')!s}",
                f"{pos.get('tp', '')!s}",
                f"{pos.get('profit', '')!s}",
                str(tix),
                "",
            )
            rows.append((f"{aid}:{tix}", vals, ()))

    def _sort_key(t: tuple[str, tuple[Any, ...], tuple[str, ...]]) -> tuple[str, int]:
        iid = t[0]
        if iid.endswith(":err"):
            return (iid, 0)
        try:
            _a, ts = iid.rsplit(":", 1)
            return (_a, int(ts))
        except ValueError:
            return (iid, 0)

    rows.sort(key=_sort_key)
    return rows, total_pnl, n_open


def _row_from_positions_bridge(aid: str, label: str, p: dict[str, Any]) -> dict[str, Any]:
    positions: list[dict[str, Any]] = []
    bridge_error: str | None = None
    if p.get("ok") and isinstance(p.get("positions"), list):
        positions = _sanitize_position_dicts(p["positions"])
    else:
        msg = (p.get("message") or p.get("error") or "").strip() or "bridge or MT5 did not return positions"
        bridge_error = msg[:512]
    row: dict[str, Any] = {"account_id": aid, "label": label, "positions": positions}
    if bridge_error:
        row["bridge_error"] = bridge_error
    return row


def _sanitize_deal_dicts(deals: Any) -> list[dict[str, Any]]:
    """JSON-safe deal rows from history_deals bridge (matches mt5_bridge history_deals output)."""
    if not isinstance(deals, list):
        return []
    out: list[dict[str, Any]] = []
    for raw in deals:
        if not isinstance(raw, dict):
            continue
        try:
            tid = raw.get("ticket")
            pid = raw.get("position_id")
            ent = raw.get("entry")
            out.append(
                {
                    "ticket": int(tid) if tid is not None else 0,
                    "time": int(raw.get("time") or 0),
                    "symbol": str(raw.get("symbol") or ""),
                    "type": str(raw.get("type") or ""),
                    "volume": _finite_float(raw.get("volume")),
                    "price": _finite_float(raw.get("price")),
                    "profit": _finite_float(raw.get("profit")),
                    "swap": _finite_float(raw.get("swap")),
                    "commission": _finite_float(raw.get("commission")),
                    "entry": int(ent) if ent is not None and str(ent).strip() != "" else None,
                    "position_id": int(pid) if pid is not None else 0,
                    "comment": str(raw.get("comment") or "")[:200],
                }
            )
        except (TypeError, ValueError):
            continue
    return out


def _deal_entry_label(entry: Any) -> str:
    try:
        e = int(entry)
    except (TypeError, ValueError):
        return ""
    return {0: "in", 1: "out", 2: "inout", 3: "out_by"}.get(e, str(e))


def _format_deal_time(ts: int) -> str:
    if ts <= 0:
        return ""
    try:
        return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ts))
    except (OSError, ValueError, OverflowError):
        return str(ts)


def _row_from_history_bridge(aid: str, label: str, p: dict[str, Any]) -> dict[str, Any]:
    deals: list[dict[str, Any]] = []
    bridge_error: str | None = None
    if p.get("ok") and isinstance(p.get("deals"), list):
        deals = _sanitize_deal_dicts(p["deals"])
    else:
        msg = (p.get("message") or p.get("error") or p.get("hint") or "").strip() or (
            "bridge or MT5 did not return history deals"
        )
        bridge_error = msg[:512]
    row: dict[str, Any] = {"account_id": aid, "label": label, "deals": deals}
    if bridge_error:
        row["bridge_error"] = bridge_error
    return row


def _flatten_history_tab_rows(
    results: list[dict[str, Any]],
) -> tuple[list[tuple[str, tuple[Any, ...], tuple[str, ...]]], float, int]:
    """Build ordered (iid, values, tags) rows for the Position history Treeview."""
    keyed: list[tuple[tuple[Any, ...], str, tuple[Any, ...], tuple[str, ...]]] = []
    total_net = 0.0
    n_deals = 0
    for row in results:
        aid = str(row.get("account_id") or "")
        lab = str(row.get("label") or "")
        berr = row.get("bridge_error")
        if berr:
            vals = (
                aid,
                lab,
                "",
                "",
                "",
                "",
                "",
                "",
                "",
                "",
                "",
                str(berr)[:300],
            )
            keyed.append(((-1, str(aid)), f"{aid}:histerr", vals, ("err",)))
            continue
        for d in row.get("deals") or []:
            if not isinstance(d, dict):
                continue
            try:
                tix = int(d.get("ticket") or 0)
            except (TypeError, ValueError):
                tix = 0
            tm = int(d.get("time") or 0)
            pr = _finite_float(d.get("profit"))
            sw = _finite_float(d.get("swap"))
            cm = _finite_float(d.get("commission"))
            net = pr + sw + cm
            total_net += net
            n_deals += 1
            pos_id = int(d.get("position_id") or 0)
            keyed.append(
                (
                    (0, -tm, -tix, str(aid)),
                    f"{aid}:{tix}",
                    (
                        aid,
                        lab,
                        _format_deal_time(tm),
                        str(d.get("symbol") or ""),
                        str(d.get("type") or ""),
                        _deal_entry_label(d.get("entry")),
                        f"{d.get('volume', '')!s}",
                        f"{d.get('price', '')!s}",
                        f"{net:,.2f}",
                        str(tix),
                        str(pos_id) if pos_id else "",
                        str(d.get("comment") or "")[:120],
                    ),
                    (),
                )
            )

    keyed.sort(key=lambda x: x[0])
    rows = [(t[1], t[2], t[3]) for t in keyed]
    return rows, total_net, n_deals


def positions_snapshot_path_groups(config_path: Path) -> list[tuple[str, list[tuple[str, str]]]]:
    """Ordered (terminal_path, [(account_id, label), ...]) for one `positions` bridge call per path."""
    cfg = load_config(config_path)
    accounts = cfg.get("accounts") or {}
    if not isinstance(accounts, dict):
        return []
    terminals = terminals_payload_from_cfg(cfg)
    id_to_label = {t["id"]: (t.get("label") or t["id"]) for t in terminals}
    path_to_accounts: dict[str, list[tuple[str, str]]] = {}
    for aid_raw, term_path in accounts.items():
        aid = _account_id_str(aid_raw)
        if not aid or not str(term_path).strip():
            continue
        raw_path = str(term_path).strip()
        try:
            path_s = str(Path(raw_path).expanduser().resolve())
        except OSError:
            path_s = str(raw_path)
        label = id_to_label.get(aid, aid)
        path_to_accounts.setdefault(path_s, []).append((aid, label))
    return list(path_to_accounts.items())


def positions_snapshot_results_from_path(config_path: Path) -> list[dict[str, Any]]:
    """Per-account rows for `positions_snapshot` — one bridge call per unique terminal path."""
    cfg = load_config(config_path)
    results: list[dict[str, Any]] = []
    for path_s, acc_list in positions_snapshot_path_groups(config_path):
        p = bridge_call(cfg, "positions", {}, path_s)
        for aid, label in acc_list:
            results.append(_row_from_positions_bridge(aid, label, p))
    return results


def _drain_snapshot_ws_ack(
    ws: Any,
    trace: dict[str, Any] | None,
    trace_lock: threading.Lock | None,
    *,
    ok_note: str = "ok (panel stored snapshot / inventory)",
) -> None:
    try:
        ws.settimeout(8.0)
        raw = ws.recv()
        ak, ae = _parse_panel_ws_ack(raw)
        if ak == "error":
            _trace_set(
                trace,
                trace_lock,
                last_panel_ack=f"rejected: {ae}"[:400],
                last_error=str(ae or "")[:300],
            )
        elif ak == "ok":
            _trace_set(trace, trace_lock, last_panel_ack=ok_note)
    except Exception:
        _trace_set(trace, trace_lock, last_panel_ack="(no snapshot ack in 8s — tunnel slow or busy)")


def _slugify(name: str, max_len: int = 48) -> str:
    s = re.sub(r"[^a-zA-Z0-9_-]+", "_", name.strip()).strip("_").lower()
    return (s or "terminal")[:max_len]


def scan_folder_for_terminals(root: Path, max_depth: int = 6) -> list[tuple[str, str, str]]:
    """Return (id, label, exe_path) for each terminal64.exe under root (Windows clones layout)."""
    root = root.resolve()
    if not root.is_dir():
        return []
    seen_ids: set[str] = set()

    def unique_id(base: str) -> str:
        b = _slugify(base)
        if b not in seen_ids:
            seen_ids.add(b)
            return b
        n = 2
        while True:
            cand = f"{b}_{n}"
            if cand not in seen_ids:
                seen_ids.add(cand)
                return cand
            n += 1

    found: list[tuple[str, str, str]] = []
    for dirpath, dirnames, filenames in os.walk(root):
        rel = Path(dirpath).resolve().relative_to(root)
        depth = len(rel.parts) if str(rel) != "." else 0
        if depth >= max_depth:
            dirnames[:] = []
            continue
        for fn in filenames:
            if fn.lower() != "terminal64.exe":
                continue
            exe = Path(dirpath) / fn
            if not exe.is_file():
                continue
            parent = exe.parent
            key_src = parent.name if parent.name else exe.name
            tid = unique_id(key_src)
            try:
                rel_disp = str(exe.resolve().relative_to(root))
            except ValueError:
                rel_disp = exe.name
            label = f"{parent.name} · {rel_disp}" if rel_disp else parent.name
            found.append((tid, label[:256], str(exe.resolve())))
    return found


def _positions_ui_queue_put(q: queue.Queue | None, accumulated: list[dict[str, Any]]) -> None:
    """Copy final snapshot for local GUI (Tk) after a full positions merge (no partial UI updates)."""
    if q is None:
        return
    try:
        payload = json.loads(json.dumps({"results": accumulated}, default=str))
        q.put_nowait(payload)
    except Exception:
        pass


def _history_ui_queue_put(q: queue.Queue | None, accumulated: list[dict[str, Any]]) -> None:
    """Copy history_deals snapshot for local Position history tab (no panel WebSocket)."""
    if q is None:
        return
    try:
        payload = json.loads(json.dumps({"results": accumulated}, default=str))
        q.put_nowait(payload)
    except Exception:
        pass


def device_inventory_ws_loop(
    config_path: Path,
    stop: threading.Event,
    push_queue: queue.Queue,
    trace: dict[str, Any] | None = None,
    trace_lock: threading.Lock | None = None,
    positions_ui_queue: queue.Queue | None = None,
    history_ui_queue: queue.Queue | None = None,
) -> None:
    """Push config `accounts` to panel over WebSocket; `push_queue` triggers re-send after folder scan."""
    if websocket is None:
        print("[inventory-ws] websocket-client not installed; install requirements.txt for panel sync.", flush=True)
        return

    while not stop.is_set():
        cfg = load_config(config_path)
        did = (cfg.get("device_id") or "").strip()
        tok = (cfg.get("token") or "").strip()
        api_base = (cfg.get("api_base") or "").strip()
        if not did or not tok or not api_base:
            _trace_set(
                trace,
                trace_lock,
                inventory_ws_connected=False,
                last_error="missing device_id, token, or api_base in config",
                panel_ws_url="",
            )
            if stop.wait(2.0):
                break
            continue
        ws_url = ws_url_from_api_base(api_base) + "/ws/agent/device"
        headers = [f"Authorization: Bearer {tok}", f"X-Device-Id: {did}"]
        _trace_set(
            trace,
            trace_lock,
            device_id_short=did[:12] + ("…" if len(did) > 12 else ""),
            panel_ws_url=ws_url,
            inventory_ws_connected=False,
            last_error=None,
        )
        ws = None
        try:
            try:
                ws = websocket.create_connection(ws_url, header=headers, timeout=30)
            except Exception as e:
                msg = str(e)[:300]
                print("[inventory-ws] connect failed:", e, flush=True)
                _trace_set(trace, trace_lock, inventory_ws_connected=False, last_error=msg)
                if stop.wait(5.0):
                    break
                continue
            _trace_set(
                trace,
                trace_lock,
                inventory_ws_connected=True,
                last_error=None,
                last_panel_ack="(waiting for panel…)",
            )
            try:
                ws.send(
                    json.dumps(
                        {
                            "type": "terminal_inventory",
                            "terminals": terminals_payload_from_cfg(load_config(config_path)),
                        }
                    )
                )
            except Exception as e:
                print("[inventory-ws] send failed:", e, flush=True)
                _trace_set(trace, trace_lock, last_error=str(e)[:300], inventory_ws_connected=False)
                try:
                    ws.close()
                except OSError:
                    pass
                if stop.wait(3.0):
                    break
                continue
            # Drain panel ack for terminal_inventory so later recv() lines up with snapshot replies.
            try:
                ws.settimeout(5.0)
                raw_inv = ws.recv()
                ak0, ae0 = _parse_panel_ws_ack(raw_inv)
                if ak0 == "ok":
                    _trace_set(trace, trace_lock, last_panel_ack="ok (terminal inventory saved on panel)")
                elif ak0 == "error":
                    _trace_set(
                        trace,
                        trace_lock,
                        last_panel_ack=f"rejected: {ae0}"[:400],
                        last_error=str(ae0 or "")[:300],
                    )
            except Exception:
                _trace_set(
                    trace,
                    trace_lock,
                    last_panel_ack="(no inventory ack in 5s — tunnel slow or panel error)",
                )
            last_positions_sent = 0.0
            last_history_sent = 0.0
            while not stop.is_set():
                now = time.monotonic()
                drained = False
                while True:
                    try:
                        push_queue.get_nowait()
                        drained = True
                    except queue.Empty:
                        break
                if drained:
                    ws.send(
                        json.dumps(
                            {
                                "type": "terminal_inventory",
                                "terminals": terminals_payload_from_cfg(load_config(config_path)),
                            }
                        )
                    )
                cfg_snap = load_config(config_path)
                snap_every = _cfg_nonneg_float(
                    cfg_snap,
                    "positions_snapshot_interval_sec",
                    DEFAULT_POSITIONS_SNAPSHOT_INTERVAL_SEC,
                    lo=1.0,
                    hi=120.0,
                )
                if now - last_positions_sent >= snap_every:
                    n_cfg = _configured_terminal_count(cfg_snap)
                    if n_cfg == 0:
                        _trace_set(
                            trace,
                            trace_lock,
                            last_snapshot_phase='No MT5 paths in config — click “Set MT5 clones folder…” or edit accounts.',
                            last_snapshot_pending_terminals=0,
                        )
                        _positions_ui_queue_put(positions_ui_queue, [])
                    else:
                        _trace_set(
                            trace,
                            trace_lock,
                            last_snapshot_phase=(
                                f"Querying {n_cfg} MT5 path(s) — bridges run in parallel; streaming merges to panel "
                                f"and Live tab (~60s max per path, wall time ~slowest path)…"
                            ),
                            last_snapshot_pending_terminals=n_cfg,
                        )
                    try:
                        path_groups = positions_snapshot_path_groups(config_path)
                        accumulated: list[dict[str, Any]] = []
                        n_paths = len(path_groups)
                        n_workers = min(MAX_PARALLEL_POSITIONS_BRIDGE, max(1, n_paths))
                        future_by_pi: list[Any] = []
                        if n_paths:
                            with ThreadPoolExecutor(max_workers=n_workers) as pool:
                                future_by_pi = [
                                    pool.submit(bridge_call, cfg_snap, "positions", {}, path_s)
                                    for path_s, _al in path_groups
                                ]
                                for pi, ((path_s, acc_list), fut) in enumerate(
                                    zip(path_groups, future_by_pi)
                                ):
                                    _trace_set(
                                        trace,
                                        trace_lock,
                                        last_snapshot_phase=(
                                            f"MT5 path {pi + 1}/{n_paths} (merge to WebSocket + UI)…"
                                        ),
                                    )
                                    p = fut.result()
                                    chunk = [
                                        _row_from_positions_bridge(aid, label, p)
                                        for aid, label in acc_list
                                    ]
                                    accumulated.extend(chunk)
                                    if chunk:
                                        ws.send(
                                            json.dumps(
                                                {
                                                    "type": "positions_snapshot",
                                                    "merge": True,
                                                    "results": chunk,
                                                },
                                                default=str,
                                                ensure_ascii=False,
                                                allow_nan=False,
                                            )
                                        )
                                        _drain_snapshot_ws_ack(
                                            ws,
                                            trace,
                                            trace_lock,
                                            ok_note="ok (incremental positions merge)",
                                        )
                        payload_final = json.dumps(
                            {"type": "positions_snapshot", "results": accumulated},
                            default=str,
                            ensure_ascii=False,
                            allow_nan=False,
                        )
                        ws.send(payload_final)
                        _drain_snapshot_ws_ack(ws, trace, trace_lock, ok_note="ok (panel stored snapshot / inventory)")
                        last_positions_sent = time.monotonic()
                        n_acc, tot_pos, n_br = _snapshot_summary(accumulated)
                        bsz = len(payload_final.encode("utf-8"))
                        if trace is None:
                            print(
                                f"[inventory-ws] positions_snapshot sent accounts={n_acc} "
                                f"open_positions={tot_pos} bridge_error_rows={n_br} bytes={bsz} "
                                f"(+ incremental merges per path)",
                                flush=True,
                            )
                        _trace_set(
                            trace,
                            trace_lock,
                            last_snapshot_accounts=n_acc,
                            last_snapshot_open_positions=tot_pos,
                            last_snapshot_bridge_error_rows=n_br,
                            last_snapshot_payload_bytes=bsz,
                            last_snapshot_monotonic=time.monotonic(),
                            last_snapshot_phase="",
                            last_snapshot_pending_terminals=0,
                        )
                        _positions_ui_queue_put(positions_ui_queue, accumulated)
                    except (ValueError, TypeError) as ex:
                        print("[inventory-ws] positions_snapshot json encode:", ex, flush=True)
                        _trace_set(
                            trace,
                            trace_lock,
                            last_error=f"json encode: {ex}"[:300],
                            last_snapshot_phase="",
                            last_snapshot_pending_terminals=0,
                        )
                    except Exception as ex:
                        # Do not break / close the socket: disconnect clears this device on the panel's
                        # remote-positions cache and Live view stays empty until reconnect + new snapshot.
                        print("[inventory-ws] positions_snapshot failed:", ex, flush=True)
                        _trace_set(
                            trace,
                            trace_lock,
                            last_error=str(ex)[:300],
                            last_snapshot_phase="",
                            last_snapshot_pending_terminals=0,
                        )
                hist_every = _cfg_nonneg_float(
                    cfg_snap,
                    "history_deals_snapshot_interval_sec",
                    DEFAULT_HISTORY_DEALS_SNAPSHOT_INTERVAL_SEC,
                    lo=10.0,
                    hi=600.0,
                )
                if now - last_history_sent >= hist_every:
                    n_hist = _configured_terminal_count(cfg_snap)
                    accumulated_h: list[dict[str, Any]] = []
                    history_ok = True
                    if n_hist == 0:
                        _history_ui_queue_put(history_ui_queue, [])
                    else:
                        try:
                            path_groups_h = positions_snapshot_path_groups(config_path)
                            n_paths_h = len(path_groups_h)
                            n_workers_h = min(MAX_PARALLEL_POSITIONS_BRIDGE, max(1, n_paths_h))
                            days_body = {"days": _cfg_history_deals_days(cfg_snap)}
                            if n_paths_h:
                                with ThreadPoolExecutor(max_workers=n_workers_h) as pool:
                                    futures_h = [
                                        pool.submit(
                                            bridge_call, cfg_snap, "history_deals", days_body, path_s
                                        )
                                        for path_s, _al in path_groups_h
                                    ]
                                    for (_path_s, acc_list), fut_h in zip(path_groups_h, futures_h):
                                        p_h = fut_h.result()
                                        for aid_h, label_h in acc_list:
                                            accumulated_h.append(
                                                _row_from_history_bridge(aid_h, label_h, p_h)
                                            )
                            _history_ui_queue_put(history_ui_queue, accumulated_h)
                        except Exception as ex:
                            history_ok = False
                            print("[inventory-ws] history_deals snapshot failed:", ex, flush=True)
                    if history_ok:
                        try:
                            hist_payload = json.dumps(
                                {"type": "history_deals_snapshot", "results": accumulated_h},
                                default=str,
                                ensure_ascii=False,
                                allow_nan=False,
                            )
                            ws.send(hist_payload)
                            _drain_snapshot_ws_ack(
                                ws,
                                trace,
                                trace_lock,
                                ok_note="ok (panel stored history deals)",
                            )
                        except Exception as ex:
                            print("[inventory-ws] history_deals_snapshot to panel failed:", ex, flush=True)
                    last_history_sent = time.monotonic()
                raw_in = None
                try:
                    ws.settimeout(1.0)
                    raw_in = ws.recv()
                except Exception:
                    pass
                ack_kind, ack_err = _parse_panel_ws_ack(raw_in)
                if ack_kind == "error":
                    line = ack_err or "unknown"
                    print("[inventory-ws] panel rejected message:", line, flush=True)
                    _trace_set(trace, trace_lock, last_panel_ack=f"rejected: {line}"[:400], last_error=line[:300])
                elif ack_kind == "ok":
                    _trace_set(trace, trace_lock, last_panel_ack="ok (panel stored snapshot / inventory)")
        finally:
            _trace_set(trace, trace_lock, inventory_ws_connected=False)
            if ws is not None:
                try:
                    ws.close()
                except OSError:
                    pass


def register_pairing(api_base: str, code: str, label: str) -> tuple[str, str]:
    norm_code = "".join(code.split()).upper()
    if len(norm_code) != 8:
        raise RuntimeError(
            f"Pairing code must be exactly 8 characters (you entered {len(norm_code)}). "
            "Copy the code from the panel (Remote devices) — do not add extra letters."
        )
    r = requests.post(
        f"{api_base.rstrip('/')}/api/agent/register",
        json={"code": norm_code, "label": label},
        timeout=30,
    )
    try:
        data = r.json()
    except ValueError:
        r.raise_for_status()
        raise RuntimeError("Panel returned a non-JSON response. Check Panel API URL.") from None
    if not data.get("ok"):
        raise RuntimeError(data.get("error") or f"register failed (HTTP {r.status_code})")
    return data["device_id"], data["token"]


def bridge_call(cfg: dict[str, Any], action: str, body: dict[str, Any], terminal_path: str) -> dict[str, Any]:
    bridge = resolve_bridge_path(cfg)
    if not bridge.is_file():
        return {"ok": False, "message": f"bridge_script not found: {bridge}"}
    env = os.environ.copy()
    env["MT5_TERMINAL_PATH"] = terminal_path
    cwd = str(bridge.parent)
    with _lock_for_terminal_path(terminal_path):
        proc = subprocess.run(
            python_invocation(cfg) + [str(bridge), action],
            input=json.dumps(body),
            text=True,
            capture_output=True,
            timeout=60,
            env=env,
            cwd=cwd,
        )
    raw = (proc.stdout or "").strip() or (proc.stderr or "").strip()
    if proc.returncode != 0:
        return {"ok": False, "message": raw or f"bridge exit {proc.returncode}"}
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {"ok": False, "message": raw}


def mt5_quick_check(cfg: dict[str, Any]) -> bool:
    bridge = resolve_bridge_path(cfg)
    if not bridge.is_file():
        return False
    accounts: dict[str, str] = cfg.get("accounts") or {}
    for term_path in accounts.values():
        if not term_path:
            continue
        out = bridge_call(cfg, "symbols", {}, term_path)
        if out.get("ok"):
            return True
    return False


def _parse_optional_positive_pips(val: Any) -> float | None:
    if val is None:
        return None
    try:
        x = float(val)
        return x if x > 0 and math.isfinite(x) else None
    except (TypeError, ValueError):
        return None


def estimate_spread_pips(symbol: str, bid: float, ask: float) -> float:
    """Match panel `estimateSpreadPips` (majors / JPY / metals / crypto)."""
    sp = float(ask) - float(bid)
    if not (sp > 0) or not math.isfinite(sp):
        return 0.0
    u = symbol.upper()
    if "JPY" in u:
        return sp / 0.01
    if "XAU" in u or "XAG" in u:
        return sp / 0.01
    if "BTC" in u or "ETH" in u:
        return sp
    return sp / 0.0001


def _merge_sl_tp_pips_into_body(body: dict[str, Any], src: dict[str, Any]) -> None:
    sl = _parse_optional_positive_pips(src.get("sl_pips"))
    tp = _parse_optional_positive_pips(src.get("tp_pips"))
    if sl is not None:
        body["sl_pips"] = sl
    if tp is not None:
        body["tp_pips"] = tp


def run_create_position(cfg: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    account_id = (payload.get("account_id") or "default").strip()
    accounts: dict[str, str] = cfg.get("accounts") or {}
    term_path = accounts.get(account_id)
    if not term_path:
        return {"ok": False, "message": f"unknown account_id '{account_id}' in agent config"}
    body = {
        "symbol": payload.get("symbol") or "",
        "order_type": (payload.get("order_type") or "buy").lower(),
        "volume": float(payload.get("volume") or 0.01),
        "comment": (payload.get("comment") or "remote-agent").strip(),
    }
    _merge_sl_tp_pips_into_body(body, payload)
    return bridge_call(cfg, "create_position", body, term_path)


def run_place_market_orders_batch(cfg: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    """Open the same (or per-row) market order on many accounts; parallel across distinct terminal paths."""
    raw_orders = payload.get("orders")
    if not isinstance(raw_orders, list) or len(raw_orders) == 0:
        return {"ok": False, "message": "payload.orders must be a non-empty array"}
    if len(raw_orders) > MAX_BATCH_MARKET_ORDERS:
        return {"ok": False, "message": f"too many orders (max {MAX_BATCH_MARKET_ORDERS})"}

    accounts_map = cfg.get("accounts") or {}
    if not isinstance(accounts_map, dict):
        accounts_map = {}
    default_symbol = str(payload.get("symbol") or "").strip()
    default_ot = str(payload.get("order_type") or "buy").strip().lower()
    try:
        default_vol = float(payload.get("volume") if payload.get("volume") is not None else 0.01)
    except (TypeError, ValueError):
        default_vol = 0.01
    default_comment = str(payload.get("comment") or "panel-remote").strip()
    payload_sl = _parse_optional_positive_pips(payload.get("sl_pips"))
    payload_tp = _parse_optional_positive_pips(payload.get("tp_pips"))

    grouped: dict[str, list[tuple[str, dict[str, Any], str]]] = defaultdict(list)
    errors: list[dict[str, Any]] = []

    for item in raw_orders:
        if not isinstance(item, dict):
            continue
        aid = str(item.get("account_id") or "default").strip()
        tp_raw = accounts_map.get(aid)
        if not tp_raw or not str(tp_raw).strip():
            errors.append(
                {"account_id": aid, "ok": False, "message": f"unknown account_id '{aid}' in agent config"},
            )
            continue
        tp_s = str(tp_raw).strip()
        sym = str(item.get("symbol") or default_symbol).strip()
        ot = str(item.get("order_type") or default_ot).strip().lower()
        try:
            vol = float(item.get("volume")) if item.get("volume") is not None else default_vol
        except (TypeError, ValueError):
            vol = default_vol
        com = str(item.get("comment") if item.get("comment") is not None else default_comment).strip()
        body = {"symbol": sym, "order_type": ot, "volume": vol, "comment": com}
        i_sl = _parse_optional_positive_pips(item.get("sl_pips"))
        i_tp = _parse_optional_positive_pips(item.get("tp_pips"))
        if i_sl is not None:
            body["sl_pips"] = i_sl
        elif payload_sl is not None:
            body["sl_pips"] = payload_sl
        if i_tp is not None:
            body["tp_pips"] = i_tp
        elif payload_tp is not None:
            body["tp_pips"] = payload_tp
        nk = _normalized_terminal_path_key(tp_s) or tp_s
        grouped[nk].append((aid, body, tp_s))

    if not grouped:
        return {"ok": False, "message": "no valid orders", "results": errors}

    def run_one_path(pairs: list[tuple[str, dict[str, Any], str]]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for aid, body, tp in pairs:
            r = bridge_call(cfg, "create_position", body, tp)
            out.append(
                {
                    "account_id": aid,
                    "ok": bool(r.get("ok")),
                    "message": r.get("message") or r.get("error") or "",
                },
            )
        return out

    max_workers = min(64, len(grouped))
    blocks: list[list[dict[str, Any]]] = []
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = [pool.submit(run_one_path, list(pairs)) for pairs in grouped.values()]
        for fut in as_completed(futures):
            try:
                blocks.append(fut.result())
            except Exception as e:
                blocks.append([{"account_id": "", "ok": False, "message": str(e)}])

    flat = errors[:]
    for b in blocks:
        flat.extend(b)
    n_ok = sum(1 for x in flat if x.get("ok"))
    ok = n_ok == len(flat) and len(flat) > 0
    return {"ok": ok, "message": f"{n_ok}/{len(flat)} accounts ok", "results": flat}


def run_fixed_lot_tick(cfg: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    """Remote worker tick: open on many accounts — parallel across distinct terminal paths (same pattern as batch enqueue)."""
    accounts_map: dict[str, str] = cfg.get("accounts") or {}
    if not isinstance(accounts_map, dict):
        accounts_map = {}
    account_ids = payload.get("account_ids")
    if not isinstance(account_ids, list) or not account_ids:
        account_ids = ["default"]
    symbol = str(payload.get("symbol") or "").strip()
    order_type = str(payload.get("order_type") or "buy").strip().lower()
    volume = float(payload.get("volume") or 0.01)
    comment = str(payload.get("comment") or "remote-fixedlot")
    max_open_positions = int(payload.get("max_open_positions") or 0)
    max_spread_pips = _parse_optional_positive_pips(payload.get("max_spread_pips"))

    idx_line: dict[int, str] = {}
    path_to_triples: dict[str, list[tuple[int, str, str]]] = defaultdict(list)

    for i, account_id in enumerate(account_ids):
        aid = str(account_id).strip()
        term_path = accounts_map.get(aid)
        if not term_path or not str(term_path).strip():
            idx_line[i] = f"{aid}: not configured"
            continue
        tp_s = str(term_path).strip()
        nk = _normalized_terminal_path_key(tp_s) or tp_s
        path_to_triples[nk].append((i, aid, tp_s))

    if not path_to_triples:
        lines = [idx_line[j] for j in range(len(account_ids))]
        return {"ok": False, "message": " | ".join(lines), "results": lines}

    any_ok = False
    state_lock = threading.Lock()

    def work_path(norm_key: str) -> None:
        nonlocal any_ok
        triples = path_to_triples[norm_key]
        if max_spread_pips is not None and symbol and triples:
            _i0, _a0, tp0 = triples[0]
            tick_out = bridge_call(cfg, "symbol_ticks", {"symbols": [symbol]}, tp0)
            if not tick_out.get("ok"):
                msg = tick_out.get("message") or tick_out.get("error") or "symbol_ticks failed"
                for i, aid, _tp in triples:
                    idx_line[i] = f"{aid}: skipped (spread check: {msg})"
                return
            ticks = tick_out.get("ticks") if isinstance(tick_out.get("ticks"), dict) else {}
            row = ticks.get(symbol)
            if row is None:
                su = str(symbol).upper()
                for k, v in ticks.items():
                    if str(k).upper() == su and isinstance(v, dict):
                        row = v
                        break
            if not isinstance(row, dict):
                for i, aid, _tp in triples:
                    idx_line[i] = f"{aid}: skipped (no tick for spread check)"
                return
            try:
                bid = float(row.get("bid") or 0.0)
                ask = float(row.get("ask") or 0.0)
            except (TypeError, ValueError):
                bid = 0.0
                ask = 0.0
            sp_pips = estimate_spread_pips(symbol, bid, ask)
            if sp_pips > float(max_spread_pips):
                for i, aid, _tp in triples:
                    idx_line[i] = (
                        f"{aid}: skipped (spread {sp_pips:.2f} pips > max {float(max_spread_pips):.2f})"
                    )
                return

        for i, aid, tp in path_to_triples[norm_key]:
            if max_open_positions > 0:
                p = bridge_call(cfg, "positions", {}, tp)
                if p.get("ok"):
                    pos = p.get("positions")
                    if isinstance(pos, list) and len(pos) >= max_open_positions:
                        with state_lock:
                            idx_line[i] = f"{aid}: skipped (max open {max_open_positions})"
                        continue
            body_cp: dict[str, Any] = {
                "symbol": symbol,
                "order_type": order_type,
                "volume": volume,
                "comment": comment,
            }
            _merge_sl_tp_pips_into_body(body_cp, payload)
            out = bridge_call(cfg, "create_position", body_cp, tp)
            if out.get("ok"):
                line = f"{aid}: ok"
                with state_lock:
                    any_ok = True
                    idx_line[i] = line
            else:
                with state_lock:
                    idx_line[i] = f"{aid}: {out.get('message') or out.get('error') or 'failed'}"

    max_workers = min(64, len(path_to_triples))
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        future_map = {pool.submit(work_path, nk): nk for nk in path_to_triples}
        for fut in as_completed(future_map):
            nk = future_map[fut]
            try:
                fut.result()
            except Exception as ex:
                with state_lock:
                    for i, aid, _tp in path_to_triples[nk]:
                        idx_line.setdefault(i, f"{aid}: {ex}")

    lines = [idx_line[j] for j in range(len(account_ids))]
    return {"ok": any_ok, "message": " | ".join(lines), "results": lines}


def run_close_positions_selected(cfg: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    """Close every open position on each listed account_id — parallel across distinct terminal paths."""
    accounts_map: dict[str, str] = cfg.get("accounts") or {}
    if not isinstance(accounts_map, dict):
        accounts_map = {}
    raw_ids = payload.get("account_ids")
    if not isinstance(raw_ids, list) or not raw_ids:
        return {"ok": False, "message": "account_ids is required"}
    ids: list[str] = []
    seen: set[str] = set()
    for x in raw_ids:
        s = str(x).strip()
        if not s or s in seen:
            continue
        seen.add(s)
        ids.append(s)

    lines: list[str] = []
    path_to_aids: dict[str, list[str]] = defaultdict(list)
    path_raw: dict[str, str] = {}

    for aid in ids:
        term_path = accounts_map.get(aid)
        if not term_path or not str(term_path).strip():
            lines.append(f"{aid}: not configured")
            continue
        tp_s = str(term_path).strip()
        nk = _normalized_terminal_path_key(tp_s) or tp_s
        if nk not in path_raw:
            path_raw[nk] = tp_s
        path_to_aids[nk].append(aid)

    if not path_to_aids:
        return {
            "ok": False,
            "message": " | ".join(lines) if lines else "No matching accounts in agent config",
            "closed_count": 0,
            "failed_count": 0,
            "lines": lines,
        }

    def close_for_norm_key(norm_key: str) -> tuple[list[str], int, int]:
        aids = path_to_aids[norm_key]
        tp = path_raw[norm_key]
        p = bridge_call(cfg, "positions", {}, tp)
        if not p.get("ok"):
            msg = p.get("message") or p.get("error") or "positions failed"
            return [f"{a}: {msg}" for a in aids], 0, len(aids)
        pos = p.get("positions")
        if not isinstance(pos, list) or len(pos) == 0:
            return [f"{a}: no open positions" for a in aids], 0, 0
        sub_ok = 0
        sub_fail = 0
        for item in pos:
            if not isinstance(item, dict):
                continue
            t = item.get("ticket")
            if t is None:
                continue
            try:
                ticket = int(t)
            except (TypeError, ValueError):
                continue
            c = bridge_call(cfg, "close_position", {"ticket": ticket}, tp)
            if c.get("ok"):
                sub_ok += 1
            else:
                sub_fail += 1
        if sub_ok or sub_fail:
            return [f"{a}: closed {sub_ok}, failed {sub_fail}" for a in aids], sub_ok, sub_fail
        return [f"{a}: no tickets to close" for a in aids], 0, 0

    results_by_key: dict[str, tuple[list[str], int, int]] = {}
    max_workers = min(64, len(path_to_aids))
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        future_map = {pool.submit(close_for_norm_key, nk): nk for nk in path_to_aids}
        for fut in as_completed(future_map):
            nk = future_map[fut]
            try:
                results_by_key[nk] = fut.result()
            except Exception as ex:
                aids = path_to_aids[nk]
                results_by_key[nk] = ([f"{a}: {ex}" for a in aids], 0, len(aids))

    closed = 0
    failed = 0
    for nk in path_to_aids:
        sublines, c_ok, c_fail = results_by_key[nk]
        lines.extend(sublines)
        closed += c_ok
        failed += c_fail

    ok = failed == 0 or closed > 0
    return {
        "ok": ok,
        "message": " | ".join(lines) if lines else "done",
        "closed_count": closed,
        "failed_count": failed,
        "lines": lines,
    }


def heartbeat_loop(
    config_path: Path,
    stop: threading.Event,
    auth_lost: threading.Event | None = None,
) -> None:
    while True:
        cfg = load_config(config_path)
        interval = float(cfg.get("heartbeat_interval_sec") or 15)
        if stop.wait(timeout=interval):
            break
        cfg = load_config(config_path)
        base = cfg["api_base"].rstrip("/")
        try:
            mt5_ok = mt5_quick_check(cfg)
            r = requests.post(
                f"{base}/api/agent/heartbeat",
                headers=hub_headers(cfg),
                json={
                    "agent_version": cfg.get("agent_version") or "0.2.0",
                    "mt5_connected": mt5_ok,
                },
                timeout=20,
            )
            if r.status_code == 401:
                print("[heartbeat] unauthorized (401) — panel rejected this device token.", flush=True)
                if auth_lost is not None:
                    auth_lost.set()
            elif r.status_code >= 400:
                print("[heartbeat]", r.status_code, r.text[:200])
        except requests.RequestException as e:
            print("[heartbeat] error:", e)


def post_complete(base: str, cfg: dict[str, Any], command_id: str, ok: bool, result: dict[str, Any]) -> None:
    try:
        requests.post(
            f"{base}/api/agent/commands/complete",
            headers=hub_headers(cfg),
            json={"command_id": command_id, "ok": ok, "result": result},
            timeout=30,
        )
    except requests.RequestException as e:
        print("[complete] error:", e)


def ensure_config_file(path: Path) -> None:
    """Create user config from install-dir template, or migrate legacy config next to the exe."""
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_file():
        return
    legacy = agent_dir() / CONFIG_NAME
    if legacy.is_file():
        try:
            shutil.copy(legacy, path)
            return
        except OSError:
            pass
    ex = agent_dir() / "config.example.json"
    if ex.is_file():
        shutil.copy(ex, path)
        return
    exit_fail(
        f"Missing config file:\n  {path}\n\n"
        "The installer should ship config.example.json next to the exe; copy it to the path above, "
        "or reinstall. (Frozen Windows builds use this file under %LOCALAPPDATA%\\MT5RemoteAgent\\.)"
    )


def run_windows_pairing_ui(path: Path) -> None:
    """Tk pairing wizard (Windows + PyInstaller). Blocks until window closed; starts agent threads after success."""
    import tkinter as tk
    from tkinter import ttk

    cfg = load_config(path)
    stop = threading.Event()
    auth_lost = threading.Event()
    paired = False
    inventory_push_queue: queue.Queue = queue.Queue()
    positions_ui_queue: queue.Queue = queue.Queue()
    history_ui_queue: queue.Queue = queue.Queue()
    inventory_trace: dict[str, Any] = {}
    inventory_trace_lock = threading.Lock()
    running_widgets: List[Any] = []
    positions_ui_after: list[Any] = [None]
    history_ui_after: list[Any] = [None]

    root = tk.Tk()
    root.title("MT5 Remote Agent — pair this PC")
    root.minsize(460, 440)
    root.resizable(True, False)

    main = ttk.Frame(root, padding=14)
    main.pack(fill=tk.BOTH, expand=True)

    INTRO_PAIR = (
        "Enter the 8-character pairing code from the panel (Remote devices → New pairing code). Copy-paste it — do not type by hand.\n"
        "Panel URL is filled automatically if the administrator placed panel_api_url.txt next to this program, or set MT5_AGENT_API_BASE."
    )
    INTRO_CONNECTED = (
        "Registration complete. Panel API URL, pairing code, and label cannot be changed until you close this window.\n"
        "This PC should appear Online under Remote devices within a few seconds."
    )

    status_var = tk.StringVar(
        value="Status: Not connected — fill in the form and click Register.",
    )
    status_lbl = ttk.Label(
        main,
        textvariable=status_var,
        font=("Segoe UI", 11, "bold"),
        foreground="#b45309",
        wraplength=420,
    )
    status_lbl.pack(anchor=tk.W, pady=(0, 8))

    intro_lbl = ttk.Label(
        main,
        text=INTRO_PAIR,
        wraplength=420,
    )
    intro_lbl.pack(anchor=tk.W)

    row1 = ttk.Frame(main)
    row1.pack(fill=tk.X, pady=(10, 4))
    ttk.Label(row1, text="Panel API URL", width=18).pack(side=tk.LEFT)
    api_var = tk.StringVar(value=resolve_panel_api_base_for_pairing(cfg))
    api_entry = ttk.Entry(row1, textvariable=api_var)
    api_entry.pack(side=tk.LEFT, fill=tk.X, expand=True)

    row2 = ttk.Frame(main)
    row2.pack(fill=tk.X, pady=4)
    ttk.Label(row2, text="Pairing code", width=18).pack(side=tk.LEFT)
    code_var = tk.StringVar()
    code_entry = ttk.Entry(row2, textvariable=code_var)
    code_entry.pack(side=tk.LEFT, fill=tk.X, expand=True)

    row3 = ttk.Frame(main)
    row3.pack(fill=tk.X, pady=4)
    ttk.Label(row3, text="Device label (optional)", width=18).pack(side=tk.LEFT)
    label_var = tk.StringVar(value=os.environ.get("DEVICE_LABEL", f"agent-{random.randint(1000, 9999)}"))
    label_entry = ttk.Entry(row3, textvariable=label_var)
    label_entry.pack(side=tk.LEFT, fill=tk.X, expand=True)

    err_var = tk.StringVar()
    err_lbl = ttk.Label(main, textvariable=err_var, foreground="#b00020", wraplength=420)
    err_lbl.pack(anchor=tk.W, pady=(8, 0))

    def on_running_close() -> None:
        stop.set()
        root.destroy()

    def show_running_state() -> None:
        nonlocal paired, stop
        paired = True
        threading.Thread(target=heartbeat_loop, args=(path, stop, auth_lost), daemon=True).start()
        threading.Thread(target=poll_loop, args=(path, stop, auth_lost), daemon=True).start()
        threading.Thread(
            target=device_inventory_ws_loop,
            args=(
                path,
                stop,
                inventory_push_queue,
                inventory_trace,
                inventory_trace_lock,
                positions_ui_queue,
                history_ui_queue,
            ),
            daemon=True,
        ).start()
        status_var.set("Status: Connected — online with panel (fields locked).")
        status_lbl.configure(foreground="#15803d")
        intro_lbl.configure(
            text=INTRO_CONNECTED,
            foreground="#1e293b",
        )
        code_var.set("********")
        api_entry.configure(state="disabled")
        code_entry.configure(state="disabled")
        label_entry.configure(state="disabled")
        reg_btn.configure(state="disabled", text="Registered")
        err_var.set("")
        hint.pack_forget()
        root.resizable(True, True)
        root.minsize(680, 480)

        nb = ttk.Notebook(main)
        nb.pack(fill=tk.BOTH, expand=True, pady=(10, 0))
        running_widgets.append(nb)
        tab_agent = ttk.Frame(nb, padding=(0, 8))
        tab_pos = ttk.Frame(nb, padding=(4, 8))
        tab_hist = ttk.Frame(nb, padding=(4, 8))
        nb.add(tab_agent, text="Agent")
        nb.add(tab_pos, text="Live positions")
        nb.add(tab_hist, text="Position history")

        cfg_path_lbl = ttk.Label(tab_agent, text=f"Config: {path}", font=("Consolas", 8), foreground="#64748b")
        cfg_path_lbl.pack(anchor=tk.W, pady=(10, 0))
        running_widgets.append(cfg_path_lbl)
        lbl_keep = ttk.Label(
            tab_agent,
            text="Keep this window open or minimized — closing stops the agent.",
            wraplength=420,
            font=("Segoe UI", 9),
            foreground="#64748b",
        )
        lbl_keep.pack(anchor=tk.W, pady=(6, 0))
        running_widgets.append(lbl_keep)

        diag_var = tk.StringVar(value="Live link: starting…")
        diag_lbl = ttk.Label(
            tab_agent,
            textvariable=diag_var,
            font=("Consolas", 9),
            foreground="#334155",
            justify=tk.LEFT,
            wraplength=440,
        )
        diag_lbl.pack(anchor=tk.W, pady=(12, 0))
        running_widgets.append(diag_lbl)

        def poll_inventory_trace() -> None:
            if not paired:
                return
            with inventory_trace_lock:
                t = dict(inventory_trace)
            conn = t.get("inventory_ws_connected")
            lines = [
                f"Panel WebSocket (/ws/agent/device): {'CONNECTED' if conn else 'DISCONNECTED'}",
            ]
            url = (t.get("panel_ws_url") or "").strip()
            if url:
                lines.append(f"URL: {url}")
            dids = (t.get("device_id_short") or "").strip()
            if dids:
                lines.append(f"Device id (short): {dids}")
            err = (t.get("last_error") or "").strip()
            if err:
                lines.append(f"Last error: {err}")
            phase = (t.get("last_snapshot_phase") or "").strip()
            if phase:
                lines.append(f"Snapshot: {phase}")
            lines.append(
                f"Last positions_snapshot: accounts={t.get('last_snapshot_accounts', '—')} "
                f"open_positions={t.get('last_snapshot_open_positions', '—')} "
                f"bridge_error_rows={t.get('last_snapshot_bridge_error_rows', '—')} "
                f"bytes={t.get('last_snapshot_payload_bytes', '—')}"
            )
            lines.append(f"Panel last JSON ack: {t.get('last_panel_ack', '—')}")
            lines.append(
                "“—” above means no snapshot finished yet: either still querying MT5 (slow bridge), "
                "or no terminal paths in config. If MT5 has open trades but open_positions stays 0, fix paths."
            )
            lines.append(
                "If DISCONNECTED or ack shows rejected:, fix URL/token or see panel server log."
            )
            diag_var.set("\n".join(lines))
            root.after(900, poll_inventory_trace)

        root.after(600, poll_inventory_trace)

        root.title("MT5 Remote Agent — connected")
        root.protocol("WM_DELETE_WINDOW", on_running_close)

        def apply_mt5_clones_folder(*, replace: bool) -> None:
            from tkinter import filedialog

            title = (
                "Select folder containing MT5 clones (subfolders with terminal64.exe)"
                if replace
                else "Select another folder to merge (same scan rules)"
            )
            folder = filedialog.askdirectory(title=title)
            if not folder:
                return
            found = scan_folder_for_terminals(Path(folder))
            if not found:
                err_var.set("No terminal64.exe found under that folder (searched depth ≤ 6).")
                return
            c2 = load_config(path)
            if replace:
                acc = {tid: p for tid, _label, p in found}
                verb = "Set"
            else:
                acc = dict(c2.get("accounts") or {})
                for tid, _label, p in found:
                    acc[tid] = p
                verb = "Merged"
            c2["accounts"] = acc
            save_config(path, c2)
            err_var.set("")
            status_var.set(f"{verb} {len(found)} terminal(s) in config; syncing to panel via WebSocket…")
            inventory_push_queue.put(1)

        def reset_mt5_paths() -> None:
            from tkinter import messagebox

            if not messagebox.askyesno(
                "Reset terminal paths",
                "Clear every MT5 terminal path from this PC’s config?\n\n"
                "The panel will show no terminals for this device until you use "
                "“Set MT5 clones folder…” again (or edit config.json).",
                icon="warning",
                parent=root,
            ):
                return
            c2 = load_config(path)
            c2["accounts"] = {}
            save_config(path, c2)
            err_var.set("")
            status_var.set("Terminal paths cleared — syncing empty list to panel…")
            inventory_push_queue.put(1)

        mt5_row = ttk.Frame(tab_agent)
        mt5_row.pack(fill=tk.X, pady=(10, 0))
        running_widgets.append(mt5_row)
        ttk.Button(
            mt5_row,
            text="Set MT5 clones folder…",
            command=lambda: apply_mt5_clones_folder(replace=True),
        ).pack(side=tk.LEFT)
        ttk.Button(
            mt5_row,
            text="Add another folder…",
            command=lambda: apply_mt5_clones_folder(replace=False),
        ).pack(side=tk.LEFT, padx=(6, 0))
        ttk.Button(mt5_row, text="Reset paths", command=reset_mt5_paths).pack(side=tk.LEFT, padx=(6, 0))
        ttk.Label(
            mt5_row,
            text="Set / Add another: scan folders. Reset paths: clear all & sync panel.",
            foreground="#64748b",
            wraplength=420,
        ).pack(side=tk.LEFT, padx=(10, 0))

        close_row = ttk.Frame(tab_agent)
        close_row.pack(fill=tk.X, pady=(10, 0))
        running_widgets.append(close_row)

        def on_close_all_positions() -> None:
            from tkinter import messagebox

            c0 = load_config(path)
            aids0 = _configured_account_ids(c0)
            if not aids0:
                messagebox.showinfo(
                    "Close all positions",
                    "No MT5 terminals are configured. Use “Set MT5 clones folder…” first, or edit config.json.",
                    parent=root,
                )
                return
            if not messagebox.askyesno(
                "Close all positions",
                "Close every open position on all MT5 terminals configured on this PC?\n\n"
                "This sends the same close requests as the panel (market close per ticket). "
                "It cannot be undone.",
                icon="warning",
                parent=root,
            ):
                return

            close_all_btn.configure(state="disabled")

            def worker() -> None:
                try:
                    c2 = load_config(path)
                    aids2 = _configured_account_ids(c2)
                    if not aids2:
                        res: dict[str, Any] = {
                            "ok": False,
                            "message": "No terminals configured",
                            "closed_count": 0,
                            "failed_count": 0,
                        }
                    else:
                        res = run_close_positions_selected(c2, {"account_ids": aids2})
                except Exception as ex:
                    res = {"ok": False, "message": str(ex), "closed_count": 0, "failed_count": 0}

                def finish() -> None:
                    try:
                        close_all_btn.configure(state="normal")
                    except tk.TclError:
                        pass
                    msg = str(res.get("message") or "Done")
                    cc = int(res.get("closed_count") or 0)
                    fc = int(res.get("failed_count") or 0)
                    title = "Close all positions"
                    if res.get("ok") and fc == 0:
                        messagebox.showinfo(title, f"Closed: {cc}\n\n{msg}", parent=root)
                    elif res.get("ok"):
                        messagebox.showwarning(title, f"Closed: {cc}  Failed: {fc}\n\n{msg}", parent=root)
                    else:
                        messagebox.showerror(title, f"Closed: {cc}  Failed: {fc}\n\n{msg}", parent=root)

                root.after(0, finish)

            threading.Thread(target=worker, daemon=True).start()

        close_all_btn = ttk.Button(
            close_row,
            text="Close all open positions…",
            command=on_close_all_positions,
        )
        close_all_btn.pack(side=tk.LEFT)
        ttk.Label(
            close_row,
            text="All configured terminals on this PC (parallel closes per MT5 instance).",
            foreground="#64748b",
            wraplength=420,
        ).pack(side=tk.LEFT, padx=(10, 0))

        hint_agent = ttk.Label(
            tab_agent,
            text='After connecting: Set / Add folder for MT5 paths, or Reset paths to clear the panel list.',
            wraplength=420,
            font=("Segoe UI", 9),
        )
        hint_agent.pack(anchor=tk.W, pady=(12, 0))
        running_widgets.append(hint_agent)

        cols = (
            "account",
            "label",
            "symbol",
            "type",
            "volume",
            "open",
            "sl",
            "tp",
            "profit",
            "ticket",
            "note",
        )
        pos_tree = ttk.Treeview(tab_pos, columns=cols, show="headings", height=14, selectmode=tk.BROWSE)
        _h = (
            "Account",
            "Label",
            "Symbol",
            "Type",
            "Volume",
            "Open",
            "SL",
            "TP",
            "Profit",
            "Ticket",
            "Note",
        )
        _w = (88, 160, 72, 52, 56, 78, 56, 56, 72, 72, 200)
        for c, h, w in zip(cols, _h, _w):
            pos_tree.heading(c, text=h)
            pos_tree.column(c, width=w, minwidth=36, stretch=(c in ("label", "note")))
        pos_tree.tag_configure("err", foreground="#b00020")
        pos_total_pnl_var = tk.StringVar(value="Total open P/L: —")
        pnl_summary_lbl = tk.Label(
            tab_pos,
            textvariable=pos_total_pnl_var,
            font=("Segoe UI", 12, "bold"),
            foreground="#64748b",
            anchor="w",
        )
        pnl_summary_lbl.grid(row=0, column=0, columnspan=2, sticky="w", pady=(0, 6))
        running_widgets.append(pnl_summary_lbl)
        vsb = ttk.Scrollbar(tab_pos, orient=tk.VERTICAL, command=pos_tree.yview)
        hsb = ttk.Scrollbar(tab_pos, orient=tk.HORIZONTAL, command=pos_tree.xview)
        pos_tree.configure(yscrollcommand=vsb.set, xscrollcommand=hsb.set)
        pos_tree.grid(row=1, column=0, sticky="nsew")
        vsb.grid(row=1, column=1, sticky="ns")
        hsb.grid(row=2, column=0, sticky="ew")
        tab_pos.grid_rowconfigure(1, weight=1)
        tab_pos.grid_columnconfigure(0, weight=1)
        running_widgets.extend([pos_tree, vsb, hsb])
        pos_help = ttk.Label(
            tab_pos,
            text=(
                "The panel still receives incremental WebSocket merges; this table refreshes once per snapshot when "
                "all paths are merged (stable row order — no shuffling). MT5 is re-read on "
                "positions_snapshot_interval_sec (default 2s); bridges run in parallel (~slowest path)."
            ),
            wraplength=640,
            font=("Segoe UI", 9),
            foreground="#64748b",
            justify=tk.LEFT,
        )
        pos_help.grid(row=3, column=0, columnspan=2, sticky="w", pady=(8, 0))
        running_widgets.append(pos_help)

        hcols = (
            "account",
            "label",
            "time",
            "symbol",
            "type",
            "entry",
            "volume",
            "price",
            "net",
            "deal",
            "position",
            "note",
        )
        hist_tree = ttk.Treeview(tab_hist, columns=hcols, show="headings", height=14, selectmode=tk.BROWSE)
        _hh = (
            "Account",
            "Label",
            "Time",
            "Symbol",
            "Type",
            "Entry",
            "Volume",
            "Price",
            "Net P/L",
            "Deal",
            "Position",
            "Note",
        )
        _hw = (72, 140, 128, 68, 44, 44, 52, 72, 72, 56, 64, 180)
        for c, h, w in zip(hcols, _hh, _hw):
            hist_tree.heading(c, text=h)
            hist_tree.column(c, width=w, minwidth=36, stretch=(c in ("label", "note")))
        hist_tree.tag_configure("err", foreground="#b00020")
        hist_summary_var = tk.StringVar(value="History (closed deals): —")
        hist_summary_lbl = tk.Label(
            tab_hist,
            textvariable=hist_summary_var,
            font=("Segoe UI", 12, "bold"),
            foreground="#64748b",
            anchor="w",
        )
        hist_summary_lbl.grid(row=0, column=0, columnspan=2, sticky="w", pady=(0, 6))
        running_widgets.append(hist_summary_lbl)
        hvsb = ttk.Scrollbar(tab_hist, orient=tk.VERTICAL, command=hist_tree.yview)
        hhsb = ttk.Scrollbar(tab_hist, orient=tk.HORIZONTAL, command=hist_tree.xview)
        hist_tree.configure(yscrollcommand=hvsb.set, xscrollcommand=hhsb.set)
        hist_tree.grid(row=1, column=0, sticky="nsew")
        hvsb.grid(row=1, column=1, sticky="ns")
        hhsb.grid(row=2, column=0, sticky="ew")
        tab_hist.grid_rowconfigure(1, weight=1)
        tab_hist.grid_columnconfigure(0, weight=1)
        running_widgets.extend([hist_tree, hvsb, hhsb])
        hist_help = ttk.Label(
            tab_hist,
            text=(
                "Closed buy/sell deals from MT5 (profit+swap+commission as Net P/L). "
                "Refreshes on history_deals_snapshot_interval_sec (default 30s); window = history_deals_days in config "
                "(default 30, max 500 deals per terminal). Not sent to the panel."
            ),
            wraplength=640,
            font=("Segoe UI", 9),
            foreground="#64748b",
            justify=tk.LEFT,
        )
        hist_help.grid(row=3, column=0, columnspan=2, sticky="w", pady=(8, 0))
        running_widgets.append(hist_help)

        def apply_positions_rows_to_tree(results: list[dict[str, Any]]) -> None:
            rows_flat, total_pnl, n_open = _flatten_live_tab_rows(results)
            id_to_row = {r[0]: (r[1], r[2]) for r in rows_flat}
            want = set(id_to_row.keys())
            for iid in list(pos_tree.get_children()):
                if iid not in want:
                    pos_tree.delete(iid)
            for iid in list(pos_tree.get_children()):
                vals, tags = id_to_row[iid]
                pos_tree.item(iid, values=vals, tags=tags)
            existing_after = set(pos_tree.get_children())
            for iid, vals, tags in rows_flat:
                if iid in existing_after:
                    continue
                pos_tree.insert("", tk.END, iid=iid, values=vals, tags=tags)
            if n_open == 0:
                pos_total_pnl_var.set("Total open P/L: 0.00  ·  0 positions")
                pnl_summary_lbl.configure(foreground="#64748b")
            else:
                pos_total_pnl_var.set(
                    f"Total open P/L: {total_pnl:+,.2f}  ·  {n_open} position{'s' if n_open != 1 else ''}"
                )
                pnl_summary_lbl.configure(foreground="#15803d" if total_pnl >= 0 else "#b00020")

        def drain_positions_ui_queue() -> None:
            if not paired:
                positions_ui_after[0] = None
                return
            latest: dict[str, Any] | None = None
            while True:
                try:
                    latest = positions_ui_queue.get_nowait()
                except queue.Empty:
                    break
            if latest is not None:
                apply_positions_rows_to_tree(latest.get("results") or [])
            positions_ui_after[0] = root.after(20, drain_positions_ui_queue)

        positions_ui_after[0] = root.after(80, drain_positions_ui_queue)

        def apply_history_rows_to_tree(results: list[dict[str, Any]]) -> None:
            rows_flat, total_net, n_deals = _flatten_history_tab_rows(results)
            id_to_row = {r[0]: (r[1], r[2]) for r in rows_flat}
            want = set(id_to_row.keys())
            for iid in list(hist_tree.get_children()):
                if iid not in want:
                    hist_tree.delete(iid)
            for iid in list(hist_tree.get_children()):
                vals, tags = id_to_row[iid]
                hist_tree.item(iid, values=vals, tags=tags)
            existing_after = set(hist_tree.get_children())
            for iid, vals, tags in rows_flat:
                if iid in existing_after:
                    continue
                hist_tree.insert("", tk.END, iid=iid, values=vals, tags=tags)
            if n_deals == 0:
                hist_summary_var.set("History (closed deals): 0 deals in window  ·  Net P/L: 0.00")
                hist_summary_lbl.configure(foreground="#64748b")
            else:
                hist_summary_var.set(
                    f"History (closed deals): {n_deals} deal{'s' if n_deals != 1 else ''}  ·  "
                    f"Net P/L (sum): {total_net:+,.2f}"
                )
                hist_summary_lbl.configure(foreground="#15803d" if total_net >= 0 else "#b00020")

        def drain_history_ui_queue() -> None:
            if not paired:
                history_ui_after[0] = None
                return
            latest_h: dict[str, Any] | None = None
            while True:
                try:
                    latest_h = history_ui_queue.get_nowait()
                except queue.Empty:
                    break
            if latest_h is not None:
                apply_history_rows_to_tree(latest_h.get("results") or [])
            history_ui_after[0] = root.after(20, drain_history_ui_queue)

        history_ui_after[0] = root.after(80, drain_history_ui_queue)

    def return_to_pairing_mode() -> None:
        """Panel returned 401 — clear credentials and show URL + code fields again."""
        nonlocal stop, paired, cfg
        stop.set()
        stop = threading.Event()
        paired = False
        aid = positions_ui_after[0]
        if aid is not None:
            try:
                root.after_cancel(aid)
            except tk.TclError:
                pass
            positions_ui_after[0] = None
        hid = history_ui_after[0]
        if hid is not None:
            try:
                root.after_cancel(hid)
            except tk.TclError:
                pass
            history_ui_after[0] = None
        for w in running_widgets:
            try:
                w.destroy()
            except tk.TclError:
                pass
        running_widgets.clear()
        try:
            hint.pack(anchor=tk.W, pady=(12, 0))
        except tk.TclError:
            pass
        root.resizable(True, False)
        root.minsize(460, 440)
        c = load_config(path)
        c["device_id"] = ""
        c["token"] = ""
        save_config(path, c)
        cfg.clear()
        cfg.update(load_config(path))
        status_var.set("Status: Disconnected — panel rejected this PC (or device was removed). Enter a new pairing code.")
        status_lbl.configure(foreground="#b45309")
        intro_lbl.configure(text=INTRO_PAIR, foreground="#1e293b")
        api_var.set(resolve_panel_api_base_for_pairing(cfg))
        code_var.set("")
        api_entry.configure(state="normal")
        code_entry.configure(state="normal")
        label_entry.configure(state="normal")
        reg_btn.configure(state="normal", text="Register with panel")
        err_var.set(
            "Previous registration is no longer valid. Get a new 8-character code from Remote devices → New pairing code."
        )
        root.title("MT5 Remote Agent — pair this PC")
        root.protocol("WM_DELETE_WINDOW", on_early_close)

    def watch_auth() -> None:
        if auth_lost.is_set():
            auth_lost.clear()
            return_to_pairing_mode()
        root.after(500, watch_auth)

    def do_register() -> None:
        err_var.set("")
        api = api_var.get().strip()
        code = code_var.get().strip()
        label = (label_var.get().strip() or f"agent-{random.randint(1000, 9999)}")
        if not api or not code:
            err_var.set("Panel URL and pairing code are required.")
            return
        try:
            did, tok = register_pairing(api, code, label)
        except requests.RequestException as e:
            err_var.set(f"Network / server error: {e}")
            return
        except (RuntimeError, ValueError, KeyError) as e:
            err_var.set(str(e))
            return
        cfg["api_base"] = api
        cfg["device_id"] = did
        cfg["token"] = tok
        save_config(path, cfg)
        show_running_state()

    btn_row = ttk.Frame(main)
    btn_row.pack(fill=tk.X, pady=(14, 0))
    reg_btn = ttk.Button(btn_row, text="Register with panel", command=do_register)
    reg_btn.pack(side=tk.LEFT)

    hint = ttk.Label(
        main,
        text='After connecting: Set / Add folder for MT5 paths, or Reset paths to clear the panel list.',
        wraplength=420,
        font=("Segoe UI", 9),
    )
    hint.pack(anchor=tk.W, pady=(12, 0))

    def on_early_close() -> None:
        root.destroy()
        if not paired:
            sys.exit(1)

    root.protocol("WM_DELETE_WINDOW", on_early_close)

    root.after(400, watch_auth)

    if (cfg.get("device_id") or "").strip() and (cfg.get("token") or "").strip():
        print("Already registered — opening connected window (re-pair if the panel rejects this PC).", flush=True)
        show_running_state()

    root.mainloop()
    if not paired:
        sys.exit(1)


def poll_loop(
    config_path: Path,
    stop: threading.Event,
    auth_lost: threading.Event | None = None,
) -> None:
    while not stop.is_set():
        cfg = load_config(config_path)
        base = cfg["api_base"].rstrip("/")
        idle_wait = max(0.25, float(cfg.get("poll_interval_sec") or 2))
        burst_wait = _cfg_nonneg_float(cfg, "poll_burst_delay_sec", 0.05, lo=0.0, hi=2.0)
        backoff = idle_wait
        try:
            r = requests.get(
                f"{base}/api/agent/commands/next",
                headers=hub_headers(cfg),
                timeout=30,
            )
            if r.status_code == 401:
                print("[poll] unauthorized (401) — re-pair with a new code from the panel.", flush=True)
                if auth_lost is not None:
                    auth_lost.set()
                else:
                    exit_fail(
                        "The panel rejected this device (HTTP 401). The device may have been removed.\n\n"
                        "Clear device_id and token in your agent config, then run again to re-pair.\n"
                        "Installed builds: %LOCALAPPDATA%\\MT5RemoteAgent\\config.json"
                    )
            else:
                try:
                    data = r.json()
                except ValueError:
                    print("[poll] non-JSON response", r.status_code, r.text[:200])
                else:
                    if not data.get("ok"):
                        print("[poll]", r.status_code, data)
                    else:
                        cmd = data.get("command")
                        if cmd:
                            cid = cmd["id"]
                            ctype = cmd.get("type") or cmd.get("cmd_type")
                            payload = cmd.get("payload") if isinstance(cmd.get("payload"), dict) else {}
                            cfg = load_config(config_path)
                            if ctype == "place_market_order":
                                result = run_create_position(cfg, payload)
                                post_complete(base, cfg, cid, bool(result.get("ok")), result)
                            elif ctype == "place_market_orders":
                                result = run_place_market_orders_batch(cfg, payload)
                                post_complete(base, cfg, cid, bool(result.get("ok")), result)
                            elif ctype == "fixed_lot_tick":
                                result = run_fixed_lot_tick(cfg, payload)
                                post_complete(base, cfg, cid, bool(result.get("ok")), result)
                            elif ctype == "close_positions_selected":
                                result = run_close_positions_selected(cfg, payload)
                                post_complete(base, cfg, cid, bool(result.get("ok")), result)
                            else:
                                post_complete(
                                    base,
                                    cfg,
                                    cid,
                                    False,
                                    {"ok": False, "message": f"unsupported type: {ctype}"},
                                )
                            backoff = burst_wait
        except requests.RequestException as e:
            print("[poll] error:", e)
        stop.wait(backoff)


def main() -> None:
    print("MT5 Remote Agent starting...", flush=True)
    path = config_path()
    ensure_config_file(path)
    cfg = load_config(path)
    api_base = effective_api_base(cfg)

    use_gui_windows = (
        getattr(sys, "frozen", False)
        and os.name == "nt"
        and not os.environ.get("MT5_AGENT_NO_GUI")
        and not os.environ.get("PAIRING_CODE", "").strip()
    )

    pairing = os.environ.get("PAIRING_CODE", "").strip()
    if pairing and (not cfg.get("device_id") or not cfg.get("token")):
        label = os.environ.get("DEVICE_LABEL", f"agent-{random.randint(1000, 9999)}")
        try:
            did, tok = register_pairing(api_base, pairing, label)
        except requests.RequestException as e:
            exit_fail(f"Pairing request failed (check api_base URL and network):\n{e}")
        except (RuntimeError, ValueError, KeyError) as e:
            exit_fail(f"Pairing failed:\n{e}")
        cfg["api_base"] = api_base
        cfg["device_id"] = did
        cfg["token"] = tok
        save_config(path, cfg)
        print("Registered device. Saved device_id and token to", path)

    if not cfg.get("device_id") or not cfg.get("token"):
        if use_gui_windows:
            print("Opening pairing window…", flush=True)
            run_windows_pairing_ui(path)
            return
        exit_fail(
            "This device is not registered yet.\n\n"
            "Windows app: run MT5RemoteAgent.exe — a pairing window should open.\n"
            "Or set PAIRING_CODE in the environment, or paste device_id and token into the agent config file "
            "(installed builds: %LOCALAPPDATA%\\MT5RemoteAgent\\config.json)."
        )

    if use_gui_windows:
        print("Opening agent window…", flush=True)
        run_windows_pairing_ui(path)
        return

    stop = threading.Event()
    inventory_queue: queue.Queue = queue.Queue()
    threading.Thread(
        target=device_inventory_ws_loop,
        args=(path, stop, inventory_queue),
        daemon=True,
    ).start()
    t_hb = threading.Thread(target=heartbeat_loop, args=(path, stop), daemon=True)
    t_hb.start()
    try:
        poll_loop(path, stop)
    except KeyboardInterrupt:
        stop.set()
        print("Stopped.")


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        traceback.print_exc()
        pause_if_frozen_exe()
        sys.exit(1)
