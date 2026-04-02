"""
Hedge watcher: long-running process per MT5 account.
Polls positions every 20ms. When a paired position is missing on this account (SL/TP/manual close),
calls the backend to close the corresponding leg on the other account.
Also runs a small HTTP server so the backend can forward close requests here for in-process close (~ms).
Run one per account: default, exness (two accounts only).
  python hedge_watcher.py default
  python hedge_watcher.py exness
"""
import json
import os
import sys
import time
import threading
from datetime import datetime
from http.server import HTTPServer, BaseHTTPRequestHandler

try:
    import urllib.request
    import urllib.error
except ImportError:
    urllib = None

# Terminal paths (must match backend main.rs)
TERMINAL_PATHS = {
    "default": r"C:\Program Files\MetaTrader 5\terminal64.exe",
    "exness": r"C:\Program Files\MetaTrader 5 EXNESS\terminal64.exe",
}

# Ports for in-process close: backend forwards close to this watcher's /close
WATCHER_PORTS = {
    "default": 3100,
    "exness": 3101,
}

POLL_INTERVAL_SEC = 0.02  # 20ms
API_BASE_ENV = "MT5_PANEL_API"
DEFAULT_API_BASE = "http://localhost:3001"

# Set by main() for the HTTP handler
_mt5_ref = None
_account_id_ref = None


def log_path():
    base = os.path.dirname(os.path.abspath(__file__))
    log_dir = os.path.join(base, "logs")
    try:
        os.makedirs(log_dir, exist_ok=True)
    except OSError:
        pass
    return os.path.join(log_dir, "hedge_watcher.log")


def watcher_log(account_id: str, msg: str):
    try:
        with open(log_path(), "a", encoding="utf-8") as f:
            ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            f.write(f"[{ts}] [{account_id}] {msg}\n")
    except OSError:
        pass


def http_get(url: str):
    try:
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = resp.read().decode("utf-8")
            return True, json.loads(data)
    except Exception as e:
        return False, {"error": str(e)}


def http_post(url: str, body: dict):
    try:
        data = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            out = resp.read().decode("utf-8")
            return True, json.loads(out)
    except Exception as e:
        return False, {"error": str(e)}


def get_my_position_tickets(mt5, account_id: str):
    positions = mt5.positions_get()
    if positions is None:
        return set()
    return {int(p.ticket) for p in positions}


def close_position_in_process(mt5, ticket: int):
    """Close position by ticket in-process (no spawn). Returns (ok: bool, message: str)."""
    import MetaTrader5 as mt5_module
    positions = mt5.positions_get(ticket=ticket)
    if not positions or len(positions) == 0:
        err = mt5.last_error()
        return False, f"Position {ticket} not found: {err}"
    pos = positions[0]
    symbol = pos.symbol
    volume = pos.volume
    if not mt5.symbol_select(symbol, True):
        return False, f"Could not add symbol {symbol} to Market Watch"
    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        return False, f"No quote for {symbol}"
    if pos.type == mt5_module.ORDER_TYPE_BUY:
        close_type = mt5_module.ORDER_TYPE_SELL
        price = tick.bid
    else:
        close_type = mt5_module.ORDER_TYPE_BUY
        price = tick.ask
    request = {
        "action": mt5_module.TRADE_ACTION_DEAL,
        "symbol": symbol,
        "volume": volume,
        "type": close_type,
        "price": price,
        "deviation": 20,
        "magic": pos.magic,
        "comment": "hedge",
        "position": ticket,
    }
    result = mt5.order_send(request)
    if result is None:
        err = mt5.last_error()
        return False, str(err)
    if result.retcode != mt5_module.TRADE_RETCODE_DONE:
        return False, result.comment or f"retcode={result.retcode}"
    return True, "Position closed"


class CloseHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path == "/close" or self.path == "/close/":
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
            try:
                data = json.loads(body.decode("utf-8")) if body else {}
            except Exception:
                self.send_response(400)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": False, "message": "Invalid JSON"}).encode())
                return
            ticket = data.get("ticket")
            if ticket is None:
                self.send_response(400)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": False, "message": "ticket required"}).encode())
                return
            try:
                ticket = int(ticket)
            except (TypeError, ValueError):
                self.send_response(400)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": False, "message": "ticket must be integer"}).encode())
                return
            global _mt5_ref, _account_id_ref
            mt5 = _mt5_ref
            account_id = _account_id_ref or "?"
            if mt5 is None:
                self.send_response(503)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": False, "message": "MT5 not ready"}).encode())
                return
            ok, message = close_position_in_process(mt5, ticket)
            watcher_log(account_id, f"In-process close ticket={ticket} ok={ok} msg={message}")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": ok, "message": message}).encode())
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        pass


def run_http_server(port: int):
    server = HTTPServer(("127.0.0.1", port), CloseHandler)
    server.serve_forever()


def main():
    global _mt5_ref, _account_id_ref
    if len(sys.argv) < 2:
        print("Usage: python hedge_watcher.py <account_id>")
        print("  account_id: default | exness")
        sys.exit(1)

    account_id = sys.argv[1].strip().lower()
    if account_id not in TERMINAL_PATHS:
        print(f"Unknown account_id: {account_id}. Use: default | exness")
        sys.exit(1)

    api_base = os.environ.get(API_BASE_ENV, DEFAULT_API_BASE).rstrip("/")
    terminal_path = TERMINAL_PATHS[account_id]
    port = WATCHER_PORTS[account_id]

    try:
        import MetaTrader5 as mt5
    except ImportError:
        print("MetaTrader5 package required. pip install MetaTrader5")
        sys.exit(1)

    if not mt5.initialize(path=terminal_path):
        err = mt5.last_error()
        watcher_log(account_id, f"MT5 init failed: {err}. Exiting.")
        print(f"MT5 init failed: {err}. Is MT5 running and logged in?")
        sys.exit(1)

    _mt5_ref = mt5
    _account_id_ref = account_id

    server_thread = threading.Thread(target=run_http_server, args=(port,), daemon=True)
    server_thread.start()
    watcher_log(account_id, f"Started. API={api_base} poll_interval={POLL_INTERVAL_SEC}s close_port={port}")

    while True:
        try:
            ok, data = http_get(f"{api_base}/api/hedge-pairs")
            if not ok or not data.get("ok") or not isinstance(data.get("pairs"), list):
                time.sleep(POLL_INTERVAL_SEC)
                continue

            pairs = data["pairs"]
            if not pairs:
                time.sleep(POLL_INTERVAL_SEC)
                continue

            my_tickets = get_my_position_tickets(mt5, account_id)

            for pair in pairs:
                ticket_0 = pair.get("ticket_0")
                ticket_1 = pair.get("ticket_1")
                acc_0 = pair.get("account_0", "")
                acc_1 = pair.get("account_1", "")
                symbol = pair.get("symbol", "?")

                if account_id == acc_0:
                    my_ticket = ticket_0
                    other_ticket = ticket_1
                    other_account = acc_1
                elif account_id == acc_1:
                    my_ticket = ticket_1
                    other_ticket = ticket_0
                    other_account = acc_0
                else:
                    continue

                if my_ticket is None or other_ticket is None or not other_account:
                    continue

                if my_ticket in my_tickets:
                    continue

                # My leg is missing (closed). Ask backend to close the other leg.
                watcher_log(
                    account_id,
                    f"Orphan detected: {symbol} my_ticket={my_ticket} closed; requesting close other_ticket={other_ticket} on {other_account}",
                )
                post_ok, post_data = http_post(
                    f"{api_base}/api/hedge-close-orphan",
                    {"ticket": other_ticket, "account_id": other_account},
                )
                if post_ok and post_data.get("ok"):
                    watcher_log(account_id, f"Close orphan ok: ticket={other_ticket}")
                else:
                    watcher_log(account_id, f"Close orphan failed: {post_data}")

        except KeyboardInterrupt:
            watcher_log(account_id, "Stopped by user")
            break
        except Exception as e:
            watcher_log(account_id, f"Loop error: {e}")
            time.sleep(1)

        time.sleep(POLL_INTERVAL_SEC)

    mt5.shutdown()


if __name__ == "__main__":
    main()
