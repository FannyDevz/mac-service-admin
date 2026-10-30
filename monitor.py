"""Monitor uptime web (HTTP/HTTPS) dan server (TCP, ping): dicek berkala oleh thread
background, notifikasi macOS saat down/pulih, dan reminder dari records.py.
Hanya berjalan selama server ini hidup dan Mac menyala."""
import concurrent.futures
import http.client
import json
import os
import re
import socket
import ssl
import subprocess
import threading
import time
import urllib.error
import urllib.request
import uuid
from http import HTTPStatus
from urllib.parse import urlparse

import records
from core import DATA_DIR, ApiError, notify, run, write_json

FILE = os.path.join(DATA_DIR, "monitor.json")
KINDS = ("http", "tcp", "ping")
INTERVALS = (10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600, 43200, 86400)
TIMEOUT = 10
RETRY_AFTER = 15     # cek ulang cepat setelah gagal pertama
FAILS_TO_DOWN = 2    # gagal berturut-turut sebelum dianggap down
RENOTIFY = 3600      # ulangi notifikasi selama masih down
RECENT = 60
KEEP_HOURS = 24 * 30
KEEP_EVENTS = 200
ID_RE = re.compile(r"^[0-9a-f]{12}$")
HOST_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$")
CA_FILE = "/etc/ssl/cert.pem"
OPENER = urllib.request.build_opener(urllib.request.HTTPSHandler(context=ssl.create_default_context(
    cafile=CA_FILE if os.path.exists(CA_FILE) else None)))

LOCK = threading.RLock()
DATA = None
DIRTY = False
NEXT = {}        # id -> waktu cek berikutnya (tidak disimpan)
RUNNING = set()
ONLINE = {"ok": True, "t": 0}
STARTED = False


def _load():
    global DATA
    if DATA is not None:
        return DATA
    try:
        with open(FILE) as f:
            DATA = json.load(f)
    except FileNotFoundError:
        DATA = {}
    except (OSError, ValueError):
        os.replace(FILE, f"{FILE}.corrupt-{int(time.time())}")  # simpan untuk diperiksa, jangan ditimpa
        DATA = {}
    DATA.setdefault("targets", [])
    DATA.setdefault("events", [])
    DATA.setdefault("event_seq", 0)
    return DATA


def _flush():
    global DIRTY
    with LOCK:
        write_json(FILE, _load())
        DIRTY = False


def _event(kind, title, msg):
    with LOCK:
        d = _load()
        d["event_seq"] += 1
        d["events"].insert(0, {"id": d["event_seq"], "t": time.time(), "kind": kind, "title": title, "msg": msg})
        del d["events"][KEEP_EVENTS:]
    _flush()


def _alert(kind, title, msg):
    _event(kind, title, msg)
    notify(title, msg)


# ---------------------------------------------------------------- pengecekan

def _reason(e):
    if isinstance(e, urllib.error.URLError):
        e = e.reason
    if isinstance(e, ssl.SSLCertVerificationError):
        return f"Sertifikat SSL tidak valid: {e.verify_message}"
    if isinstance(e, (TimeoutError, socket.timeout)):
        return f"Timeout setelah {TIMEOUT} detik"
    if isinstance(e, socket.gaierror):
        return "Nama host tidak ditemukan (DNS)"
    if isinstance(e, ConnectionRefusedError):
        return "Koneksi ditolak"
    return str(e) or type(e).__name__


def probe(t):
    """Satu kali cek: (berhasil, ms, kode HTTP, pesan error)."""
    start = time.monotonic()
    ms = lambda: round((time.monotonic() - start) * 1000)  # noqa: E731
    try:
        if t["kind"] == "http":
            req = urllib.request.Request(t["url"], headers={"User-Agent": "ServiceAdmin-Uptime/1.0", "Accept": "*/*"})
            try:
                with OPENER.open(req, timeout=TIMEOUT) as r:
                    code = r.status
            except urllib.error.HTTPError as e:
                code = e.code
                e.close()
            expect = t.get("expect") or []
            ok = code in expect if expect else code < 400
            return ok, ms(), code, None if ok else f"HTTP {code}"
        if t["kind"] == "tcp":
            socket.create_connection((t["host"], t["port"]), timeout=TIMEOUT).close()
            return True, ms(), None, None
        code, out, _ = run(["/sbin/ping", "-c", "1", "-t", str(TIMEOUT), t["host"]], timeout=TIMEOUT + 2)
        found = re.search(r"time=([\d.]+)", out)
        if code == 0:
            return True, round(float(found[1])) if found else ms(), None, None
        return False, ms(), None, "Tidak ada balasan ping"
    except subprocess.TimeoutExpired:
        return False, ms(), None, f"Timeout setelah {TIMEOUT} detik"
    except (OSError, http.client.HTTPException, ValueError) as e:
        return False, ms(), None, _reason(e)


def is_online():
    """Mac terhubung internet? Kalau tidak, kegagalan cek bukan berarti target down."""
    if time.time() - ONLINE["t"] < 10:
        return ONLINE["ok"]
    ok = False
    for addr in (("1.1.1.1", 443), ("8.8.8.8", 53)):
        try:
            socket.create_connection(addr, timeout=3).close()
            ok = True
            break
        except OSError:
            pass
    ONLINE.update(ok=ok, t=time.time())
    return ok


def _apply(t, ok, ms, code, error):
    """Perbarui status target; kembalikan (kind, judul, pesan) kalau perlu notifikasi."""
    global DIRTY
    now = time.time()
    t.update(last_check=now, last_ms=ms, last_code=code, last_error=error)
    t["recent"] = (t.get("recent") or [])[-(RECENT - 1):] + [[int(now), int(ok), ms]]
    hour = int(now // 3600)
    hourly = t.setdefault("hourly", {})
    bucket = hourly.setdefault(str(hour), [0, 0])
    bucket[0] += int(ok)
    bucket[1] += 1
    for k in [k for k in hourly if int(k) < hour - KEEP_HOURS]:
        del hourly[k]
    DIRTY = True
    name = t["name"]
    if ok:
        was_down = t.get("status") == "down"
        down_for = now - (t.get("since") or now)
        t["fails"] = 0
        if t.get("status") != "up":
            t.update(status="up", since=now)
        if was_down:
            return "up", f"Pulih: {name}", f"Kembali UP setelah down {_dur(down_for)}"
        return None
    t["fails"] = (t.get("fails") or 0) + 1
    if t["fails"] < FAILS_TO_DOWN:
        return None
    if t.get("status") != "down":
        t.update(status="down", since=now, notified_at=now)
        return "down", f"DOWN: {name}", error or "Gagal dicek"
    if now - (t.get("notified_at") or 0) >= RENOTIFY:
        t["notified_at"] = now
        return "repeat", f"Masih DOWN: {name}", f"Sudah {_dur(now - t['since'])}. {error or ''}".strip()
    return None


def _dur(sec):
    sec = int(sec)
    if sec < 60:
        return f"{sec} detik"
    if sec < 3600:
        return f"{sec // 60} menit"
    if sec < 86400:
        return f"{sec // 3600} jam {sec % 3600 // 60} menit"
    return f"{sec // 86400} hari {sec % 86400 // 3600} jam"


def _find(tid):
    return next((t for t in _load()["targets"] if t["id"] == tid), None)


def _check(tid):
    with LOCK:
        t = _find(tid)
        if not t or tid in RUNNING:
            return
        RUNNING.add(tid)
        snapshot = dict(t)
    alert = None
    try:
        result = probe(snapshot)
        if result[0]:
            ONLINE.update(ok=True, t=time.time())
        online = result[0] or is_online()
        with LOCK:
            t = _find(tid)
            # target bisa dihapus/diubah selama pengecekan; offline = hasil tidak dihitung
            if t and online and all(t.get(k) == snapshot.get(k) for k in ("kind", "url", "host", "port")):
                alert = _apply(t, *result)
            if t:
                wait = min(RETRY_AFTER, t["interval"]) if online and not result[0] and t.get("status") != "down" else t["interval"]
                NEXT[tid] = time.time() + wait
    finally:
        with LOCK:
            RUNNING.discard(tid)
    if alert:
        kind, title, msg = alert
        if kind == "repeat":
            notify(title, msg)
        else:
            _alert(kind, title, msg)


def _loop():
    last_reminder = last_flush = 0
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=8, thread_name_prefix="monitor")
    while True:
        try:
            now = time.time()
            with LOCK:
                due = [t["id"] for t in _load()["targets"]
                       if t.get("enabled", True) and t["id"] not in RUNNING and NEXT.get(t["id"], 0) <= now]
                for tid in due:
                    NEXT[tid] = now + 60  # jaga-jaga kalau worker macet; _check menimpanya
            for tid in due:
                pool.submit(_check, tid)
            if now - last_reminder >= 600:
                last_reminder = now
                records.check_reminders(lambda title, msg: _alert("reminder", title, msg))
            if DIRTY and now - last_flush >= 30:
                last_flush = now
                _flush()
        except Exception as e:  # noqa: BLE001  thread ini harus tetap hidup
            print(f"monitor: {e}", flush=True)
        time.sleep(2)


def start():
    global STARTED
    if not STARTED:
        STARTED = True
        threading.Thread(target=_loop, daemon=True, name="monitor").start()


# ---------------------------------------------------------------- API

def _public(t):
    now_h = int(time.time() // 3600)
    uptime = {}
    for label, hours in (("24h", 24), ("7d", 24 * 7), ("30d", 24 * 30)):
        rows = [v for k, v in (t.get("hourly") or {}).items() if int(k) > now_h - hours]
        total = sum(v[1] for v in rows)
        uptime[label] = round(sum(v[0] for v in rows) * 100 / total, 2) if total else None
    pub = {k: v for k, v in t.items() if k != "hourly"}
    pub["uptime"] = uptime
    pub["checking"] = t["id"] in RUNNING
    return pub


def info(q=None):
    with LOCK:
        d = _load()
        targets = [_public(t) for t in d["targets"]]
        events = d["events"][:50]
    return {"targets": targets, "events": events, "online": ONLINE["ok"], "intervals": INTERVALS,
            "running": STARTED}


def alerts(q):
    try:
        since = int(q.get("since", 0) or 0)
    except ValueError:
        since = 0
    with LOCK:
        d = _load()
        down = sum(1 for t in d["targets"] if t.get("enabled", True) and t.get("status") == "down")
        new = [e for e in d["events"] if e["id"] > since]
        seq = d["event_seq"]
    return {"down": down, "due": records.due_count(), "seq": seq, "events": new[:5]}


def _clean(body):
    kind = body.get("kind")
    if kind not in KINDS:
        raise ApiError("Jenis monitor tidak valid")
    name = str(body.get("name") or "").strip()
    if not name or len(name) > 100:
        raise ApiError("Nama wajib diisi (maks 100 karakter)")
    try:
        interval = int(body.get("interval", 60))
    except (TypeError, ValueError):
        interval = 0
    if interval not in INTERVALS:
        raise ApiError("Interval tidak valid")
    t = {"kind": kind, "name": name, "interval": interval}
    if kind == "http":
        url = str(body.get("url") or "").strip()
        if url and "://" not in url:
            url = "https://" + url
        try:
            parsed = urlparse(url)
            parsed.port  # noqa: B018  melempar ValueError kalau port tidak valid
        except ValueError:
            raise ApiError("URL tidak valid") from None
        if parsed.scheme not in ("http", "https") or not parsed.hostname or not re.fullmatch(r"[!-~]+", url) or len(url) > 2000:
            raise ApiError("URL harus http:// atau https:// tanpa spasi (domain non-ASCII pakai bentuk punycode)")
        if parsed.username or parsed.password:
            raise ApiError("Jangan menaruh username/password di URL")
        expect = re.findall(r"\d+", str(body.get("expect") or ""))
        if any(not 100 <= int(c) <= 599 for c in expect):
            raise ApiError("Status HTTP harus 100–599")
        t.update(url=url, expect=[int(c) for c in expect])
        return t
    host = str(body.get("host") or "").strip()
    if not HOST_RE.match(host):
        raise ApiError("Host harus hostname atau IPv4 (contoh: server.example.com atau 203.0.113.10)")
    t["host"] = host
    if kind == "tcp":
        try:
            port = int(body.get("port"))
        except (TypeError, ValueError):
            port = 0
        if not 1 <= port <= 65535:
            raise ApiError("Port harus 1–65535")
        t["port"] = port
    return t


def action(body):
    act = body.get("action")
    if act == "notify-test":
        if not notify("Service Admin", "Tes notifikasi berhasil."):
            raise ApiError("osascript gagal mengirim notifikasi", HTTPStatus.BAD_GATEWAY)
        return {"ok": True}
    tid = str(body.get("id") or "")
    if tid and not ID_RE.match(tid):
        raise ApiError("id target tidak valid")
    if act == "save":
        clean = _clean(body)
        with LOCK:
            d = _load()
            if tid:
                t = _find(tid)
                if not t:
                    raise ApiError("Target tidak ditemukan", HTTPStatus.NOT_FOUND)
                if any(t.get(k) != clean.get(k) for k in ("kind", "url", "host", "port")):
                    # alamat berubah: riwayat lama bukan milik alamat baru
                    for k in ("status", "since", "fails", "recent", "hourly", "last_check", "last_ms",
                              "last_code", "last_error", "url", "host", "port", "expect"):
                        t.pop(k, None)
                t.update(clean)
            else:
                tid = uuid.uuid4().hex[:12]
                d["targets"].append({"id": tid, "enabled": True, **clean})
            NEXT[tid] = 0
        _flush()
        return {"ok": True, "id": tid}
    with LOCK:
        t = _find(tid)
        if not t:
            raise ApiError("Target tidak ditemukan", HTTPStatus.NOT_FOUND)
        if act == "delete":
            _load()["targets"].remove(t)
            NEXT.pop(tid, None)
        elif act == "toggle":
            t["enabled"] = not t.get("enabled", True)
            t["fails"] = 0
            if not t["enabled"]:
                t.pop("status", None)  # dijeda: jangan terhitung down
            NEXT[tid] = 0
        elif act != "check":
            raise ApiError("Aksi tidak dikenal")
    if act == "check":
        _check(tid)
        with LOCK:
            return {"ok": True, "target": _public(_find(tid))}
    _flush()
    return {"ok": True}
