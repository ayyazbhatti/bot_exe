"""
Best-effort MT5 terminal login via Windows UI Automation (pywinauto).
Reads JSON from stdin: { "exe_path", "login", "password", "server" }
Prints JSON to stdout: { "ok", "message"?, "error"? }
Does not echo credentials. Requires the same Windows session as the MT5 window (run API locally).
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time


def _out(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False))
    sys.stdout.flush()


def _load_stdin() -> dict:
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    return json.loads(raw)


def _exe_seems_valid(path: str) -> tuple[bool, str]:
    """
    Reject obvious non-executables before CreateProcess.
    Error 193 (not a valid Win32 application) means the file is corrupt, truncated, or not a PE.
    """
    try:
        size = os.path.getsize(path)
    except OSError as e:
        return False, f"Cannot read file: {e}"
    if size < 1024:
        return (
            False,
            f"terminal64.exe is only {size} bytes (expected several MB). "
            "The clone is incomplete or corrupt. Delete this folder (e.g. EXNESS_clone_001) and "
            "re-create clones from the panel, or copy the full MT5 EXNESS folder again. "
            "Avoid OneDrive/cloud-only placeholders on that path.",
        )
    try:
        with open(path, "rb") as f:
            magic = f.read(2)
    except OSError as e:
        return False, f"Cannot read terminal64.exe: {e}"
    if magic != b"MZ":
        return (
            False,
            "terminal64.exe does not look like a Windows program (missing MZ header). "
            "Replace it by copying from "
            r'"C:\Program Files\MetaTrader 5 EXNESS\terminal64.exe" '
            "or delete the clone and run Exness terminal clones again.",
        )
    return True, ""


def _start_terminal_exe(exe_path: str, work_dir: str) -> None:
    """
    Start MT5 the same way Explorer does (ShellExecute 'open' with working directory).
    pywinauto.Application.start() uses CreateProcess in a way that can return WinError 193
    for valid terminal64.exe paths (e.g. under the user profile) even when double-click works.
    """
    exe_path = os.path.normpath(exe_path)
    work_dir = os.path.normpath(work_dir)

    if sys.platform == "win32":
        import ctypes

        rc = int(
            ctypes.windll.shell32.ShellExecuteW(
                None,
                "open",
                exe_path,
                None,
                work_dir,
                1,  # SW_SHOWNORMAL
            )
        )
        if rc > 32:
            return
        # ShellExecute failed (rc is a Win32 error code for values <= 32)
        try:
            subprocess.Popen([exe_path], cwd=work_dir)
            return
        except OSError as e:
            raise RuntimeError(
                f"Could not start terminal (ShellExecute returned {rc}, subprocess: {e})"
            ) from e

    subprocess.Popen([exe_path], cwd=work_dir)


def _find_mt_window():
    """Return a visible top-level window that looks like MT5 and has login edits."""
    from pywinauto import Desktop

    d = Desktop(backend="uia")
    candidates = []
    for w in d.windows():
        try:
            if not w.is_visible():
                continue
            title = w.window_text() or ""
            if "MetaTrader" not in title:
                continue
            edits = w.descendants(control_type="Edit")
            if len(edits) >= 2:
                candidates.append((len(edits), w))
        except Exception:
            continue
    if not candidates:
        return None
    candidates.sort(key=lambda x: -x[0])
    return candidates[0][1]


def _fill_and_submit(win, login: str, password: str, server: str) -> tuple[bool, str]:
    from pywinauto.keyboard import send_keys

    win.set_focus()
    time.sleep(0.35)
    edits = win.descendants(control_type="Edit")
    if len(edits) < 2:
        return False, "Could not find login/password fields (need at least 2 Edit controls)."

    try:
        edits[0].set_edit_text(login)
        time.sleep(0.15)
        edits[1].set_edit_text(password)
    except Exception as e:
        return False, f"Could not fill fields: {e}"

    time.sleep(0.2)

    # Server: often 3rd Edit or a ComboBox
    if server:
        if len(edits) >= 3:
            try:
                edits[2].set_edit_text(server)
            except Exception:
                pass
        combos = win.descendants(control_type="ComboBox")
        if combos:
            try:
                combos[0].set_edit_text(server)
            except Exception:
                try:
                    combos[0].type_keys(server, with_spaces=True, pause=0.02)
                except Exception:
                    pass

    time.sleep(0.2)

    # OK / Login button
    for btn in win.descendants(control_type="Button"):
        try:
            t = (btn.window_text() or "").strip().lower()
            if t in ("ok", "login", "вход", "connexion"):
                btn.click_input()
                return True, "Login submitted. Check the terminal; complete 2FA in the app if required."
        except Exception:
            continue

    try:
        send_keys("{ENTER}")
        return True, "Sent Enter to confirm. Check the terminal."
    except Exception as e:
        return False, f"No OK button found and Enter failed: {e}"


def run(data: dict) -> dict:
    try:
        import pywinauto  # noqa: F401 — ensure dependency present
    except ImportError:
        return {
            "ok": False,
            "error": "pywinauto is not installed. Run: pip install -r python_bridge/requirements.txt",
        }

    exe_path = (data.get("exe_path") or "").strip()
    login = str(data.get("login", "")).strip()
    password = str(data.get("password", ""))
    server = str(data.get("server", "")).strip()

    if not exe_path:
        return {"ok": False, "error": "exe_path is required"}
    exe_path = os.path.abspath(exe_path)
    if not os.path.isfile(exe_path):
        return {"ok": False, "error": f"terminal64.exe not found: {exe_path}"}
    if not login:
        return {"ok": False, "error": "login (account number) is required"}

    ok_pe, pe_err = _exe_seems_valid(exe_path)
    if not ok_pe:
        return {"ok": False, "error": pe_err}

    work_dir = os.path.dirname(exe_path)

    try:
        _start_terminal_exe(exe_path, work_dir)
    except Exception as e:
        return {"ok": False, "error": f"Failed to start terminal: {e}"}

    time.sleep(5)

    win = None
    for _ in range(45):
        win = _find_mt_window()
        if win is not None:
            break
        time.sleep(1)

    if win is None:
        return {
            "ok": False,
            "error": "MetaTrader window with login fields not found in time. Try again or log in manually once.",
        }

    ok, msg = _fill_and_submit(win, login, password, server)
    if not ok:
        return {"ok": False, "error": msg}
    return {"ok": True, "message": msg}


def main() -> None:
    try:
        data = _load_stdin()
        result = run(data)
        _out(result)
    except json.JSONDecodeError as e:
        _out({"ok": False, "error": f"Invalid JSON: {e}"})
        sys.exit(1)
    except Exception as e:
        _out({"ok": False, "error": str(e)})
        sys.exit(1)


if __name__ == "__main__":
    main()
