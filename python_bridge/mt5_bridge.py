"""
MT5 bridge: called by Rust backend to interact with MetaTrader 5.
Reads action from argv and JSON body from stdin; prints JSON result to stdout.
"""
import json
import math
import os
import sys
import time
from datetime import datetime, timedelta


def _log_path():
    base = os.path.dirname(os.path.abspath(__file__))
    log_dir = os.path.join(base, "logs")
    try:
        os.makedirs(log_dir, exist_ok=True)
    except OSError:
        pass
    return os.path.join(log_dir, "mt5_bridge.log")


def bridge_log(msg):
    try:
        with open(_log_path(), "a", encoding="utf-8") as f:
            ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            f.write(f"[{ts}] {msg}\n")
    except OSError:
        pass


def _timing_log(phase, extra=""):
    """Diagnostic: log with millisecond precision for delay root-cause checks."""
    try:
        with open(_log_path(), "a", encoding="utf-8") as f:
            now = datetime.now()
            ms = now.microsecond // 1000
            ts = f"{now.strftime('%Y-%m-%d %H:%M:%S')}.{ms:03d}"
            f.write(f"[TIMING] {ts} {phase} {extra}\n")
    except OSError:
        pass


def resolve_symbol(mt5, symbol):
    """
    Resolve a requested symbol (e.g. EURUSD) to the actual symbol name on this terminal.
    Some brokers use suffixes (e.g. EXNESS uses EURUSDm). Try exact first, then prefix match.
    Returns (resolved_name, None) or (None, error_message).
    """
    if not symbol:
        return None, "symbol is required"
    # Try exact match first
    if mt5.symbol_select(symbol, True):
        return symbol, None
    # Broker may use a suffix (e.g. EURUSD -> EURUSDm on EXNESS)
    all_syms = mt5.symbols_get()
    if all_syms is None:
        return None, f"Could not add symbol {symbol} to Market Watch"
    # Prefer exact name match
    for s in all_syms:
        if s.name == symbol:
            if mt5.symbol_select(s.name, True):
                return s.name, None
            break
    # Then try prefix match: symbol is the base (e.g. EURUSD), terminal has EURUSDm, EURUSD., etc.
    candidates = [s for s in all_syms if s.name.startswith(symbol) and len(s.name) > len(symbol)]
    for s in candidates:
        if mt5.symbol_select(s.name, True):
            bridge_log(f"resolve_symbol: {symbol} -> {s.name} (broker suffix)")
            return s.name, None
    return None, f"Could not add symbol {symbol} to Market Watch (no matching symbol on this terminal; try the exact name from the Account's symbol list)"


def _json_float(x, default=0.0):
    try:
        v = float(x or 0)
        return v if math.isfinite(v) else default
    except (TypeError, ValueError):
        return default


def _pips_stop_intent(sl_pips, tp_pips):
    """True if caller asked for SL and/or TP via pips (used for strict verification / rollback)."""
    want_sl = False
    want_tp = False
    try:
        if sl_pips is not None and sl_pips != "" and float(sl_pips) > 0:
            want_sl = True
    except (TypeError, ValueError):
        pass
    try:
        if tp_pips is not None and tp_pips != "" and float(tp_pips) > 0:
            want_tp = True
    except (TypeError, ValueError):
        pass
    return want_sl, want_tp


def _position_stops_meet_intent(pos, want_sl, want_tp, *, point: float) -> bool:
    """After SLTP, verify broker stored stops when we required them (MT5 uses 0 when unset)."""
    eps = max(point * 0.5, 1e-9)
    if want_sl and float(getattr(pos, "sl", 0) or 0) <= eps:
        return False
    if want_tp and float(getattr(pos, "tp", 0) or 0) <= eps:
        return False
    return True


def _rollback_market_position(mt5, ticket: int, bridge_log) -> bool:
    """Close an open market position by ticket (used when SL/TP cannot be applied)."""
    positions = mt5.positions_get(ticket=ticket)
    if not positions:
        bridge_log(f"rollback: position {ticket} not found")
        return False
    pos = positions[0]
    sym = pos.symbol
    vol = pos.volume
    if not mt5.symbol_select(sym, True):
        bridge_log(f"rollback: symbol_select failed for {sym!r}")
        return False
    tick = mt5.symbol_info_tick(sym)
    if tick is None:
        bridge_log(f"rollback: no quote for {sym!r}")
        return False
    if pos.type == mt5.ORDER_TYPE_BUY:
        close_type = mt5.ORDER_TYPE_SELL
        cprice = tick.bid
    else:
        close_type = mt5.ORDER_TYPE_BUY
        cprice = tick.ask
    info = mt5.symbol_info(sym)
    filling_mode = getattr(info, "filling_mode", 0) if info else 0
    if filling_mode & 1:
        type_filling = mt5.ORDER_FILLING_FOK
    elif filling_mode & 2:
        type_filling = mt5.ORDER_FILLING_IOC
    elif filling_mode & 4:
        type_filling = mt5.ORDER_FILLING_RETURN
    else:
        type_filling = mt5.ORDER_FILLING_RETURN
    req = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": sym,
        "volume": vol,
        "type": close_type,
        "price": cprice,
        "deviation": 20,
        "magic": pos.magic,
        "comment": "rollback-no-stops",
        "position": ticket,
        "type_filling": type_filling,
    }
    res = mt5.order_send(req)
    if res is None or res.retcode != mt5.TRADE_RETCODE_DONE:
        bridge_log(
            f"rollback FAILED ticket={ticket} retcode={getattr(res, 'retcode', None)!r} "
            f"comment={getattr(res, 'comment', '')!r}"
        )
        return False
    bridge_log(f"rollback OK ticket={ticket}")
    return True


def hint_for_retcode(retcode):
    """User-friendly hint for known MT5/broker return codes."""
    hints = {
        5: "Often temporary (broker/terminal). Try: restart MT5, check disk space, try again in a few seconds.",
        10012: "Request timeout. Try again; check connection to broker.",
        10016: "Invalid stops (SL/TP too close). Panel uses no MT5 stops; if you see this on open, broker may require different settings.",
        10017: "Trade disabled for symbol or session. Check market hours and symbol trading allowed.",
        10027: "AutoTrading disabled. In MT5 enable Tools → Options → Expert Advisors → Allow Algo Trading.",
        10031: "No network. Check internet and broker connection.",
        10036: "Position already closed or not found.",
    }
    return hints.get(retcode, None)


def main():
    _timing_log("PYTHON_PROCESS_START", f"argv={sys.argv[1] if len(sys.argv) > 1 else '?'}")
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "Missing action"}))
        sys.exit(1)
    action = sys.argv[1].lower()
    try:
        body = json.load(sys.stdin) if not sys.stdin.isatty() else {}
    except json.JSONDecodeError:
        body = {}

    try:
        import MetaTrader5 as mt5
    except ImportError:
        print(json.dumps({
            "ok": False,
            "error": "MetaTrader5 package not installed. Run: pip install MetaTrader5"
        }))
        sys.exit(1)

    # Optional: custom MT5 terminal path (e.g. if installed in non-default location)
    path = os.environ.get("MT5_TERMINAL_PATH", "").strip()
    _timing_log("BEFORE_MT5_INIT", f"path={path[:50]}..." if len(path) > 50 else f"path={path}")
    init_kw = {"path": path} if path else {}
    if not mt5.initialize(**init_kw):
        err = mt5.last_error()
        print(json.dumps({
            "ok": False,
            "error": f"MT5 init failed: {err}. Is MT5 running and logged in?"
        }))
        sys.exit(1)
    _timing_log("AFTER_MT5_INIT")

    try:
        if action == "symbols":
            symbols = mt5.symbols_get()
            if symbols is None:
                result = {"ok": True, "symbols": []}
            else:
                tickers = [s.name for s in symbols if s.visible]
                result = {"ok": True, "symbols": sorted(tickers)[:200]}
            print(json.dumps(result))

        elif action == "positions":
            positions = mt5.positions_get()
            if positions is None:
                err = mt5.last_error()
                result = {
                    "ok": False,
                    "message": f"positions_get failed: {err}. Is this the correct terminal path and is MT5 logged in?",
                    "positions": [],
                }
            else:
                out = []
                for p in positions:
                    out.append(
                        {
                            "ticket": int(p.ticket),
                            "symbol": str(p.symbol or ""),
                            "type": "buy" if p.type == mt5.ORDER_TYPE_BUY else "sell",
                            "volume": _json_float(p.volume),
                            "price_open": _json_float(p.price_open),
                            "sl": _json_float(p.sl),
                            "tp": _json_float(p.tp),
                            "profit": _json_float(p.profit),
                            "comment": str(getattr(p, "comment", None) or ""),
                        }
                    )
                result = {"ok": True, "positions": out}
            print(json.dumps(result, allow_nan=False))

        elif action == "create_position":
            _timing_log("CREATE_POSITION_START")
            symbol = (body.get("symbol") or "").strip()
            order_type = (body.get("order_type") or "buy").lower()
            volume = float(body.get("volume", 0.01))
            sl = body.get("stop_loss")
            tp = body.get("take_profit")
            sl_pips = body.get("sl_pips")
            tp_pips = body.get("tp_pips")
            comment = (body.get("comment") or "").strip()

            bridge_log(f"create_position body: symbol={symbol} order_type={order_type} volume={volume} sl_pips={sl_pips!r} tp_pips={tp_pips!r} (raw sl={sl!r} tp={tp!r})")

            if not symbol:
                print(json.dumps({"ok": False, "message": "symbol is required"}))
                sys.exit(1)
            if volume <= 0:
                print(json.dumps({"ok": False, "message": "volume must be positive"}))
                sys.exit(1)

            # Resolve to broker's symbol name (e.g. EURUSD -> EURUSDm on EXNESS) and add to Market Watch
            resolved, err = resolve_symbol(mt5, symbol)
            if err:
                print(json.dumps({"ok": False, "message": err}))
                sys.exit(1)
            symbol = resolved

            info = mt5.symbol_info(symbol)
            if info is None:
                print(json.dumps({"ok": False, "message": f"Symbol {symbol} not found"}))
                sys.exit(1)

            # Validate and normalize volume to broker's step/min/max
            vol_min = getattr(info, "volume_min", 0.0001)
            vol_max = getattr(info, "volume_max", 100.0)
            vol_step = getattr(info, "volume_step", 0.01)
            if vol_step <= 0:
                vol_step = 0.01
            requested_volume = volume
            volume = max(vol_min, min(vol_max, volume))
            steps = round(volume / vol_step)
            volume = steps * vol_step
            # If step rounding gave 0 (e.g. 0.0001 with vol_step 0.01), use at least vol_min so we never send 0
            if volume < vol_min:
                volume = vol_min
            # Round to enough decimals for vol_step (e.g. 0.01 -> 2, 0.0001 -> 4)
            ndec = 4
            if vol_step >= 1:
                ndec = 0
            elif vol_step >= 0.1:
                ndec = 1
            elif vol_step >= 0.01:
                ndec = 2
            elif vol_step >= 0.001:
                ndec = 3
            volume = round(volume, ndec)
            if abs(volume - requested_volume) > 1e-9:
                bridge_log(f"create_position volume adjusted from {requested_volume} to {volume} (symbol vol_min={vol_min} vol_step={vol_step})")

            tick = mt5.symbol_info_tick(symbol)
            if tick is None:
                print(json.dumps({"ok": False, "message": f"Symbol {symbol}: no quote (check Market Watch)"}))
                sys.exit(1)

            order_type_int = mt5.ORDER_TYPE_BUY if order_type == "buy" else mt5.ORDER_TYPE_SELL
            price = tick.ask if order_type == "buy" else tick.bid

            # If sl_pips/tp_pips provided, convert to price (override stop_loss/take_profit)
            digits = getattr(info, "digits", 2)
            point = getattr(info, "point", 0.00001)
            if point <= 0:
                point = 10 ** (-digits) if digits else 0.00001
            pip_size = 10.0 * point if digits >= 3 else point
            stops_level = int(getattr(info, "trade_stops_level", 0))
            min_dist_price = stops_level * point if stops_level > 0 else 0.0

            # Set SL/TP from pips independently (so one can be 0 and the other set)
            def set_sl_tp_from_pips():
                nonlocal sl, tp
                try:
                    if sl_pips is not None:
                        sl_pips_f = float(sl_pips)
                        if sl_pips_f > 0:
                            if order_type == "buy":
                                sl = round(price - sl_pips_f * pip_size, digits)
                            else:
                                sl = round(price + sl_pips_f * pip_size, digits)
                except (TypeError, ValueError):
                    pass
                try:
                    if tp_pips is not None:
                        tp_pips_f = float(tp_pips)
                        if tp_pips_f > 0:
                            if order_type == "buy":
                                tp = round(price + tp_pips_f * pip_size, digits)
                            else:
                                tp = round(price - tp_pips_f * pip_size, digits)
                except (TypeError, ValueError):
                    pass

            set_sl_tp_from_pips()
            bridge_log(f"create_position after set_sl_tp_from_pips: sl={sl!r} tp={tp!r} price={price} digits={digits} point={point} pip_size={pip_size} stops_level={stops_level}")

            # Enforce broker's minimum stops level and normalize to symbol point
            def normalize_price(p):
                return round(round(p / point) * point, digits)

            def finalize_levels_quote(a_sl, a_tp, px_ref):
                ns, nt = a_sl, a_tp
                if ns is not None:
                    ns = normalize_price(ns)
                    if min_dist_price > 0:
                        if order_type == "buy" and px_ref - ns < min_dist_price:
                            ns = normalize_price(px_ref - min_dist_price)
                        elif order_type == "sell" and ns - px_ref < min_dist_price:
                            ns = normalize_price(px_ref + min_dist_price)
                    if order_type == "buy" and ns >= px_ref:
                        ns = None
                    elif order_type == "sell" and ns <= px_ref:
                        ns = None
                if nt is not None:
                    nt = normalize_price(nt)
                    if min_dist_price > 0:
                        if order_type == "buy" and nt - px_ref < min_dist_price:
                            nt = normalize_price(px_ref + min_dist_price)
                        elif order_type == "sell" and px_ref - nt < min_dist_price:
                            nt = normalize_price(px_ref - min_dist_price)
                    if order_type == "buy" and nt <= px_ref:
                        nt = None
                    elif order_type == "sell" and nt >= px_ref:
                        nt = None
                return ns, nt

            sl, tp = finalize_levels_quote(sl, tp, price)

            want_sl, want_tp = _pips_stop_intent(sl_pips, tp_pips)
            strict_pips_stops = want_sl or want_tp
            if strict_pips_stops and sl is None and tp is None:
                print(
                    json.dumps(
                        {
                            "ok": False,
                            "message": "SL/TP (pips) cannot be placed for the current quote (min distance / side). Order not sent.",
                        },
                    ),
                )
                sys.exit(1)
            pre_sl, pre_tp = sl, tp

            # Set type_filling from symbol's allowed modes so it works across different brokers (e.g. Default vs EXNESS).
            # SYMBOL_FILLING_MODE is a bitmask (1=FOK, 2=IOC, 4=RETURN); we must use ORDER_FILLING_* in the request.
            filling_mode = getattr(info, "filling_mode", 0)
            if filling_mode & 1:  # SYMBOL_FILLING_FOK
                type_filling = mt5.ORDER_FILLING_FOK
            elif filling_mode & 2:  # SYMBOL_FILLING_IOC
                type_filling = mt5.ORDER_FILLING_IOC
            elif filling_mode & 4:  # SYMBOL_FILLING_RETURN
                type_filling = mt5.ORDER_FILLING_RETURN
            else:
                type_filling = mt5.ORDER_FILLING_RETURN  # fallback
            bridge_log(f"create_position type_filling={type_filling} (filling_mode={filling_mode})")

            # Open position without SL/TP first; many brokers return 10016 Invalid stops when SL/TP are sent with the deal.
            # We set SL/TP in a separate TRADE_ACTION_SLTP request after the position is open.
            request = {
                "action": mt5.TRADE_ACTION_DEAL,
                "symbol": symbol,
                "volume": volume,
                "type": order_type_int,
                "price": price,
                "deviation": 20,
                "magic": 0,
                "comment": comment[:31] if comment else "MT5Panel",
                "type_filling": type_filling,
            }

            bridge_log(f"create_position request before order_send: price={request.get('price')} (sl/tp will be set after open)")
            _timing_log("BEFORE_ORDER_SEND")

            result = mt5.order_send(request)
            if result is None:
                err = mt5.last_error()
                print(json.dumps({"ok": False, "message": str(err)}))
                sys.exit(1)
            if result.retcode != mt5.TRADE_RETCODE_DONE:
                bridge_log(f"create_position order_send FAILED retcode={result.retcode} comment={result.comment!r}")
                out = {
                    "ok": False,
                    "message": result.comment or f"retcode={result.retcode}",
                    "retcode": result.retcode,
                }
                hint = hint_for_retcode(result.retcode)
                if hint:
                    out["hint"] = hint
                print(json.dumps(out))
                sys.exit(1)

            bridge_log(
                f"create_position order_send OK order={getattr(result, 'order', None)} "
                f"deal={getattr(result, 'deal', None)} position={getattr(result, 'position', None)}"
            )
            _timing_log("AFTER_ORDER_SEND")

            # Post-open SL/TP: must succeed or we fail the operation (and roll back the naked position).
            # Never report ok:true for a position that was supposed to have stops but does not.
            must_set_stops = pre_sl is not None or pre_tp is not None
            verify_sl = pre_sl is not None
            verify_tp = pre_tp is not None

            if not must_set_stops:
                bridge_log("create_position: no SL/TP to attach after open")
                print(
                    json.dumps(
                        {
                            "ok": True,
                            "message": "Order placed",
                            "order_ticket": result.order,
                        },
                    ),
                )
            else:
                result_order = int(getattr(result, "order", 0) or 0)
                result_position = int(getattr(result, "position", 0) or 0)
                primary_ids = []
                seen_id = set()
                for t in (result_position, result_order):
                    if t > 0 and t not in seen_id:
                        seen_id.add(t)
                        primary_ids.append(t)

                def resolve_opened_position_ticket():
                    for cand in primary_ids:
                        plist = mt5.positions_get(ticket=cand)
                        if plist:
                            return int(plist[0].ticket)
                    plist_sym = mt5.positions_get(symbol=symbol)
                    if not plist_sym:
                        return None
                    order_type_int_fb = mt5.ORDER_TYPE_BUY if order_type == "buy" else mt5.ORDER_TYPE_SELL
                    step = float(vol_step)
                    tol = max(step * 0.51, 1e-9)

                    def vol_close(a: float, b: float) -> bool:
                        if step >= 1:
                            return abs(a - b) < 0.5
                        return abs(a - b) <= tol + 1e-12

                    matching = [
                        p
                        for p in plist_sym
                        if p.type == order_type_int_fb and vol_close(float(p.volume), float(volume))
                    ]
                    if not matching:
                        return None
                    return int(max(matching, key=lambda p: p.ticket).ticket)

                pos_ticket = None
                for _attempt in range(55):
                    pos_ticket = resolve_opened_position_ticket()
                    if pos_ticket:
                        break
                    time.sleep(0.05)

                def levels_from_entry(entry_px):
                    rs, rt = None, None
                    try:
                        if sl_pips is not None and float(sl_pips) > 0:
                            spf = float(sl_pips)
                            if order_type == "buy":
                                rs = round(entry_px - spf * pip_size, digits)
                            else:
                                rs = round(entry_px + spf * pip_size, digits)
                        if tp_pips is not None and float(tp_pips) > 0:
                            tpf = float(tp_pips)
                            if order_type == "buy":
                                rt = round(entry_px + tpf * pip_size, digits)
                            else:
                                rt = round(entry_px - tpf * pip_size, digits)
                    except (TypeError, ValueError):
                        return None, None
                    return rs, rt

                sltp_ok = False
                if not pos_ticket:
                    bridge_log(
                        "create_position: could not resolve position ticket for SL/TP "
                        f"(symbol={symbol!r} primary_ids={primary_ids})",
                    )
                else:

                    def one_sltp_round() -> bool:
                        plist = mt5.positions_get(ticket=pos_ticket)
                        if not plist:
                            return False
                        pos = plist[0]
                        entry = float(pos.price_open)
                        tick_r = mt5.symbol_info_tick(symbol)
                        if tick_r is None:
                            return False
                        px_ref = tick_r.ask if order_type == "buy" else tick_r.bid

                        if want_sl or want_tp:
                            r_sl, r_tp = levels_from_entry(entry)
                        else:
                            r_sl, r_tp = pre_sl, pre_tp
                        r_sl, r_tp = finalize_levels_quote(r_sl, r_tp, px_ref)

                        if verify_sl and r_sl is None:
                            bridge_log("create_position SLTP: SL invalid after finalize vs quote, will retry")
                            return False
                        if verify_tp and r_tp is None:
                            bridge_log("create_position SLTP: TP invalid after finalize vs quote, will retry")
                            return False

                        mod_sl_f = float(r_sl) if r_sl is not None else float(pos.sl or 0.0)
                        mod_tp_f = float(r_tp) if r_tp is not None else float(pos.tp or 0.0)
                        mod_request = {
                            "action": mt5.TRADE_ACTION_SLTP,
                            "symbol": symbol,
                            "position": pos_ticket,
                            "sl": mod_sl_f,
                            "tp": mod_tp_f,
                        }
                        mod_result = mt5.order_send(mod_request)
                        mod_rc = getattr(mod_result, "retcode", None) if mod_result else None
                        mod_cm = getattr(mod_result, "comment", "") if mod_result else ""
                        bridge_log(
                            f"create_position TRADE_ACTION_SLTP position={pos_ticket} sl={mod_sl_f} tp={mod_tp_f} "
                            f"mod_retcode={mod_rc} comment={mod_cm!r}"
                        )
                        if mod_result is None or mod_rc != mt5.TRADE_RETCODE_DONE:
                            return False
                        plist_v = mt5.positions_get(ticket=pos_ticket)
                        if not plist_v:
                            return False
                        return _position_stops_meet_intent(plist_v[0], verify_sl, verify_tp, point=point)

                    for attempt in range(12):
                        if one_sltp_round():
                            sltp_ok = True
                            break
                        time.sleep(0.06 + min(attempt, 6) * 0.035)

                if not sltp_ok:
                    rolled = False
                    if pos_ticket:
                        rolled = _rollback_market_position(mt5, pos_ticket, bridge_log)
                    err_body = {
                        "ok": False,
                        "message": (
                            "SL/TP could not be applied and confirmed; position was closed (rollback)."
                            if rolled
                            else (
                                "SL/TP could not be applied; rollback failed or ticket unknown — close manually if a position exists."
                            )
                        ),
                        "order_ticket": getattr(result, "order", None),
                        "position_ticket": pos_ticket,
                        "rollback_ok": rolled,
                    }
                    if not pos_ticket:
                        err_body["message"] = (
                            "Order may have executed but position ticket was not found to set SL/TP. "
                            "Check MT5 for a naked position; panel will report failure."
                        )
                    print(json.dumps(err_body, allow_nan=False))
                    sys.exit(1)

                print(
                    json.dumps(
                        {
                            "ok": True,
                            "message": "Order placed",
                            "order_ticket": result.order,
                            "position_ticket": pos_ticket,
                        },
                        allow_nan=False,
                    ),
                )

        elif action == "close_position":
            ticket = body.get("ticket")
            if ticket is None:
                print(json.dumps({"ok": False, "message": "ticket is required"}))
                sys.exit(1)
            try:
                ticket = int(ticket)
            except (TypeError, ValueError):
                print(json.dumps({"ok": False, "message": "ticket must be an integer"}))
                sys.exit(1)
            bridge_log(f"close_position: closing ticket={ticket} (e.g. rollback after place-on-both partial fail)")
            # MetaTrader5 Python has no positions_close(); close by sending opposite deal with position=ticket
            positions = mt5.positions_get(ticket=ticket)
            if not positions or len(positions) == 0:
                err = mt5.last_error()
                bridge_log(f"close_position FAILED ticket={ticket} position not found: {err}")
                print(json.dumps({"ok": False, "message": f"Position {ticket} not found: {err}"}))
                sys.exit(1)
            pos = positions[0]
            symbol = pos.symbol
            volume = pos.volume
            if not mt5.symbol_select(symbol, True):
                bridge_log(f"close_position FAILED ticket={ticket} symbol_select({symbol}) failed")
                print(json.dumps({"ok": False, "message": f"Could not add symbol {symbol} to Market Watch"}))
                sys.exit(1)
            tick = mt5.symbol_info_tick(symbol)
            if tick is None:
                bridge_log(f"close_position FAILED ticket={ticket} no quote for {symbol}")
                print(json.dumps({"ok": False, "message": f"No quote for {symbol}"}))
                sys.exit(1)
            # Close buy with sell (price=bid), close sell with buy (price=ask)
            if pos.type == mt5.ORDER_TYPE_BUY:
                close_type = mt5.ORDER_TYPE_SELL
                price = tick.bid
            else:
                close_type = mt5.ORDER_TYPE_BUY
                price = tick.ask
            # Set type_filling from symbol (avoids "Unsupported filling mode" on some brokers)
            info = mt5.symbol_info(symbol)
            filling_mode = getattr(info, "filling_mode", 0) if info else 0
            if filling_mode & 1:
                type_filling = mt5.ORDER_FILLING_FOK
            elif filling_mode & 2:
                type_filling = mt5.ORDER_FILLING_IOC
            elif filling_mode & 4:
                type_filling = mt5.ORDER_FILLING_RETURN
            else:
                type_filling = mt5.ORDER_FILLING_RETURN
            request = {
                "action": mt5.TRADE_ACTION_DEAL,
                "symbol": symbol,
                "volume": volume,
                "type": close_type,
                "price": price,
                "deviation": 20,
                "magic": pos.magic,
                "comment": "rollback",
                "position": ticket,
                "type_filling": type_filling,
            }
            result = mt5.order_send(request)
            if result is None:
                err = mt5.last_error()
                bridge_log(f"close_position FAILED ticket={ticket} order_send error={err}")
                print(json.dumps({"ok": False, "message": str(err)}))
                sys.exit(1)
            if result.retcode != mt5.TRADE_RETCODE_DONE:
                bridge_log(f"close_position FAILED ticket={ticket} retcode={result.retcode} comment={result.comment!r}")
                out = {
                    "ok": False,
                    "message": result.comment or f"retcode={result.retcode}",
                    "retcode": result.retcode,
                }
                hint = hint_for_retcode(result.retcode)
                if hint:
                    out["hint"] = hint
                print(json.dumps(out))
                sys.exit(1)
            bridge_log(f"close_position OK ticket={ticket}")
            print(json.dumps({"ok": True, "message": "Position closed"}))

        elif action == "history_deals":
            # Optional: days back (default 30). Use wide range to avoid timezone mismatches with broker.
            days = int(body.get("days", 30))
            days = max(1, min(365, days))
            # Try UTC range first (MT5 often uses UTC)
            to_date_utc = datetime.utcnow() + timedelta(hours=24)
            from_date_utc = to_date_utc - timedelta(days=days + 1)
            deals = mt5.history_deals_get(from_date_utc, to_date_utc, group="*")
            # If no deals, try local-time range (some brokers use server/local time)
            if deals is None or len(deals) == 0:
                to_date_local = datetime.now() + timedelta(hours=24)
                from_date_local = to_date_local - timedelta(days=days + 1)
                deals_local = mt5.history_deals_get(from_date_local, to_date_local, group="*")
                if deals_local is not None and len(deals_local) > 0:
                    deals = deals_local
                    bridge_log("history_deals_get: UTC range empty, used local-time range")
            if deals is None:
                err = mt5.last_error()
                bridge_log(f"history_deals_get returned None: {err}")
                result = {"ok": True, "deals": [], "hint": str(err) if err else "No deals in range or MT5 error"}
            else:
                out = []
                for d in deals:
                    # Only include position deals (buy/sell); skip balance, credit, etc.
                    if d.type not in (mt5.DEAL_TYPE_BUY, mt5.DEAL_TYPE_SELL):
                        continue
                    t = getattr(d, "time", None)
                    if t is not None and hasattr(t, "timestamp"):
                        time_int = int(t.timestamp())
                    elif t is not None:
                        time_int = int(t)
                    else:
                        time_int = 0
                    # entry: 0=in, 1=out, 2=reverse, 3=out by reverse (MT5 DEAL_ENTRY_*)
                    entry = getattr(d, "entry", None)
                    if entry is not None and not isinstance(entry, int):
                        entry = int(entry) if entry is not None else None
                    out.append({
                        "ticket": d.ticket,
                        "time": time_int,
                        "symbol": d.symbol,
                        "type": "buy" if d.type == mt5.DEAL_TYPE_BUY else "sell",
                        "volume": d.volume,
                        "price": d.price,
                        "profit": getattr(d, "profit", 0) or 0,
                        "swap": getattr(d, "swap", 0) or 0,
                        "commission": getattr(d, "commission", 0) or 0,
                        "entry": entry,
                        "position_id": getattr(d, "position_id", None),
                        "comment": d.comment or "",
                    })
                # Newest first
                out.sort(key=lambda x: (x["time"], x["ticket"]), reverse=True)
                result = {"ok": True, "deals": out[:500]}
            print(json.dumps(result))

        elif action == "symbol_ticks":
            symbols_in = body.get("symbols") or []
            if not isinstance(symbols_in, list):
                symbols_in = []
            ticks = {}
            for sym in symbols_in:
                if not isinstance(sym, str) or not sym.strip():
                    continue
                symbol = sym.strip()
                resolved, _ = resolve_symbol(mt5, symbol)
                if resolved is None:
                    continue
                tick = mt5.symbol_info_tick(resolved)
                if tick is None:
                    continue
                ticks[symbol] = {"bid": tick.bid, "ask": tick.ask}
            print(json.dumps({"ok": True, "ticks": ticks}))

        else:
            print(json.dumps({"ok": False, "error": f"Unknown action: {action}"}))
            sys.exit(1)
    finally:
        mt5.shutdown()


if __name__ == "__main__":
    main()
