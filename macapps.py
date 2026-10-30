"""Aplikasi Mac: daftar & cari aplikasi, buka/tutup/tampilkan di Finder, update
(Homebrew cask, App Store via `mas`, macOS), karantina Gatekeeper, pindahkan ke
Trash, dan izin privasi (TCC): status, reset, dan pintasan ke System Settings.

macOS tidak mengizinkan program memberi izin TCC (dilindungi SIP); yang bisa
dilakukan: membaca status (kalau database-nya terbaca), `tccutil reset`, dan
membuka panel Privacy & Security yang tepat."""
import glob
import json
import os
import plistlib
import re
import shutil
import sqlite3
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from http import HTTPStatus

from core import BREW, DATA_DIR, HOME, ApiError, output, run, start_job

ROOTS = ["/Applications", "/Applications/Utilities", f"{HOME}/Applications", "/System/Applications",
         "/System/Applications/Utilities"]
ICON_DIR = os.path.join(DATA_DIR, "cache", "icons")
BUNDLE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
MAS = shutil.which("mas", path="/opt/homebrew/bin:/usr/local/bin")

# layanan privasi: (kunci TCC, nama, anchor System Settings, kunci Info.plist yang menandakan app memintanya)
PRIVACY = [
    ("kTCCServiceCamera", "Kamera", "Privacy_Camera", "NSCameraUsageDescription"),
    ("kTCCServiceMicrophone", "Mikrofon", "Privacy_Microphone", "NSMicrophoneUsageDescription"),
    ("kTCCServiceScreenCapture", "Rekam layar & audio", "Privacy_ScreenCapture", None),
    ("kTCCServiceAccessibility", "Aksesibilitas", "Privacy_Accessibility", None),
    ("kTCCServiceListenEvent", "Input Monitoring", "Privacy_ListenEvent", None),
    ("kTCCServiceSystemPolicyAllFiles", "Full Disk Access", "Privacy_AllFiles", None),
    ("kTCCServiceSystemPolicyDocumentsFolder", "Folder Documents", "Privacy_FilesAndFolders", None),
    ("kTCCServiceSystemPolicyDownloadsFolder", "Folder Downloads", "Privacy_FilesAndFolders", None),
    ("kTCCServiceSystemPolicyDesktopFolder", "Folder Desktop", "Privacy_FilesAndFolders", None),
    ("kTCCServiceSystemPolicyNetworkVolumes", "Volume jaringan", "Privacy_FilesAndFolders", None),
    ("kTCCServiceSystemPolicyRemovableVolumes", "Volume eksternal", "Privacy_FilesAndFolders", None),
    ("kTCCServiceAppleEvents", "Automation", "Privacy_Automation", "NSAppleEventsUsageDescription"),
    ("kTCCServiceAddressBook", "Kontak", "Privacy_Contacts", "NSContactsUsageDescription"),
    ("kTCCServiceCalendar", "Kalender", "Privacy_Calendars", "NSCalendarsUsageDescription"),
    ("kTCCServiceReminders", "Pengingat", "Privacy_Reminders", "NSRemindersUsageDescription"),
    ("kTCCServicePhotos", "Foto", "Privacy_Photos", "NSPhotoLibraryUsageDescription"),
    ("kTCCServiceBluetoothAlways", "Bluetooth", "Privacy_Bluetooth", "NSBluetoothAlwaysUsageDescription"),
    ("kTCCServiceDeveloperTool", "Developer Tools", "Privacy_DevTools", None),
    ("kTCCServiceSpeechRecognition", "Pengenalan suara", "Privacy_SpeechRecognition", "NSSpeechRecognitionUsageDescription"),
    ("kTCCServiceMediaLibrary", "Media & Apple Music", "Privacy_Media", "NSAppleMusicUsageDescription"),
    ("kTCCServiceLocation", "Lokasi", "Privacy_LocationServices", "NSLocationUsageDescription"),
]
PRIV_BY_KEY = {p[0]: p for p in PRIVACY}
AUTH = {0: "ditolak", 1: "tidak diketahui", 2: "diizinkan", 3: "terbatas"}


def settings_url(anchor):
    return f"x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?{anchor}"


# ---------------------------------------------------------------- daftar aplikasi

def _bundles(include_system):
    seen, paths = set(), []
    for root in ROOTS:
        if root.startswith("/System") and not include_system:
            continue
        for p in sorted(glob.glob(os.path.join(root, "*.app"))):
            real = os.path.realpath(p)
            if real not in seen:
                seen.add(real)
                paths.append(p)
    return paths


def _info(path):
    try:
        with open(os.path.join(path, "Contents/Info.plist"), "rb") as f:
            return plistlib.load(f)
    except Exception:  # noqa: BLE001
        return {}


def _mdls(paths):
    """Ukuran & terakhir dibuka dari Spotlight (cepat, tanpa du)."""
    out = {}
    if not paths:
        return out
    try:
        raw = subprocess.run(["mdls", "-name", "kMDItemPhysicalSize", "-name", "kMDItemLastUsedDate", *paths],
                             capture_output=True, text=True, timeout=30).stdout
    except (OSError, subprocess.TimeoutExpired):
        return out
    blocks = raw.split("kMDItemLastUsedDate")[1:]
    for path, block in zip(paths, blocks):
        size = re.search(r"kMDItemPhysicalSize\s*=\s*(\d+)", block)
        used = re.match(r"\s*=\s*(\S+ \S+)", block)
        out[path] = {"size": int(size[1]) if size else None,
                     "last_used": used[1] if used and used[1] != "(null)" else None}
    return out


_cask_cache = {"t": 0, "data": {}}


def _casks():
    """{'Visual Studio Code.app': {'token':..., 'outdated':..., 'latest':...}} dari Homebrew."""
    if time.time() - _cask_cache["t"] < 120:
        return _cask_cache["data"]
    data = {}
    try:
        # hanya stdout: brew bisa mencetak peringatan tap ke stderr yang merusak JSON
        info = json.loads(run([BREW, "info", "--json=v2", "--installed", "--cask"], timeout=60)[1] or "{}")
        for c in info.get("casks", []):
            for art in c.get("artifacts", []):
                for a in art.get("app", []) if isinstance(art, dict) else []:
                    name = a if isinstance(a, str) else (a.get("target") if isinstance(a, dict) else None)
                    if name:
                        data[os.path.basename(name)] = {"token": c["token"], "outdated": bool(c.get("outdated")),
                                                        "latest": c.get("version"), "installed": c.get("installed")}
    except (ValueError, subprocess.TimeoutExpired):
        pass
    _cask_cache.update(t=time.time(), data=data)
    return data


def _running():
    """Bundle yang sedang jalan -> list PID."""
    procs = {}
    for line in output(["ps", "-Axo", "pid=,comm="]).splitlines():
        m = re.match(r"\s*(\d+)\s+(.+?\.app)/Contents/MacOS/", line)
        if m:
            procs.setdefault(os.path.realpath(m[2]), []).append(int(m[1]))
    return procs


def list_apps(q):
    include_system = q.get("system") == "1"
    paths = _bundles(include_system)
    with ThreadPoolExecutor(3) as pool:
        meta_f, cask_f, run_f = pool.submit(_mdls, paths), pool.submit(_casks), pool.submit(_running)
        meta, casks, running = meta_f.result(), cask_f.result(), run_f.result()
    apps = []
    for p in paths:
        info = _info(p)
        base = os.path.basename(p)
        cask = casks.get(base)
        mas = os.path.exists(os.path.join(p, "Contents/_MASReceipt/receipt"))
        source = "App Store" if mas else "Homebrew" if cask else "Apple" if p.startswith("/System") else "Manual"
        apps.append({
            "path": p, "name": info.get("CFBundleDisplayName") or info.get("CFBundleName") or base[:-4],
            "bundle_id": info.get("CFBundleIdentifier"), "version": info.get("CFBundleShortVersionString") or info.get("CFBundleVersion"),
            "category": (info.get("LSApplicationCategoryType") or "").replace("public.app-category.", ""),
            "source": source, "cask": cask["token"] if cask else None,
            "outdated": bool(cask and cask["outdated"]), "latest": cask["latest"] if cask else None,
            "size": (meta.get(p) or {}).get("size"), "last_used": (meta.get(p) or {}).get("last_used"),
            "running": os.path.realpath(p) in running, "system": p.startswith("/System"),
            "sparkle": bool(info.get("SUFeedURL")),
        })
    return {"apps": apps, "mas": bool(MAS)}


def find_app(path):
    """Validasi: path harus salah satu bundle yang terdaftar (tidak menerima path bebas)."""
    if path not in _bundles(True):
        raise ApiError("aplikasi tidak dikenal", HTTPStatus.NOT_FOUND)
    return path


def icon(q):
    """PNG 64px ikon aplikasi (dari .icns, fallback Quick Look), di-cache."""
    path = find_app(q.get("path", ""))
    info = _info(path)
    key = re.sub(r"[^A-Za-z0-9._-]", "_", (info.get("CFBundleIdentifier") or os.path.basename(path)))
    os.makedirs(ICON_DIR, exist_ok=True)
    png = os.path.join(ICON_DIR, key + ".png")
    if not os.path.exists(png) or os.path.getmtime(png) < os.path.getmtime(path):
        name = info.get("CFBundleIconFile") or info.get("CFBundleIconName") or ""
        icns = os.path.join(path, "Contents/Resources", name if name.endswith(".icns") else name + ".icns")
        ok = False
        if name and os.path.exists(icns):
            ok = run(["sips", "-s", "format", "png", "-Z", "64", icns, "--out", png], timeout=15)[0] == 0
        if not ok:  # Assets.car (aplikasi Apple modern): minta Quick Look membuat thumbnail
            tmp = os.path.join(ICON_DIR, "_ql")
            os.makedirs(tmp, exist_ok=True)
            run(["qlmanage", "-t", "-s", "64", "-o", tmp, path], timeout=15)
            made = os.path.join(tmp, os.path.basename(path) + ".png")
            if os.path.exists(made):
                shutil.move(made, png)
    if not os.path.exists(png):
        raise ApiError("ikon tidak tersedia", HTTPStatus.NOT_FOUND)
    with open(png, "rb") as f:
        return {"__raw__": f.read(), "__type__": "image/png"}


# ---------------------------------------------------------------- detail & izin

def _tcc_rows():
    """Baca database TCC (user & sistem) sejauh diizinkan macOS."""
    rows, readable = [], {}
    for scope, db in (("user", f"{HOME}/Library/Application Support/com.apple.TCC/TCC.db"),
                      ("system", "/Library/Application Support/com.apple.TCC/TCC.db")):
        try:
            con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=2)
            for service, client, auth, indirect in con.execute(
                    "SELECT service, client, auth_value, indirect_object_identifier FROM access"):
                rows.append({"service": service, "client": client, "auth": auth, "target": indirect, "scope": scope})
            con.close()
            readable[scope] = True
        except sqlite3.Error:
            readable[scope] = False
    return rows, readable


def detail(q):
    path = find_app(q.get("path", ""))
    info = _info(path)
    bid = info.get("CFBundleIdentifier")
    rows, readable = _tcc_rows()
    mine = [r for r in rows if r["client"] == bid]
    requested = {p[0] for p in PRIVACY if p[3] and p[3] in info}
    services = []
    for key, name, anchor, _ in PRIVACY:
        entries = [r for r in mine if r["service"] == key]
        if not entries and key not in requested:
            continue
        status = None
        if entries:
            best = max(entries, key=lambda r: r["auth"])
            status = AUTH.get(best["auth"], str(best["auth"]))
        services.append({"key": key, "name": name, "status": status, "requested": key in requested,
                         "settings": settings_url(anchor),
                         "targets": [r["target"] for r in entries if r["target"] and r["target"] != "UNUSED"]})
    xattr = output(["xattr", "-p", "com.apple.quarantine", path], timeout=5)
    sig = output(["codesign", "-dv", "--verbose=2", path], timeout=15)
    team = re.search(r"TeamIdentifier=(\S+)", sig)
    authority = re.search(r"Authority=(.+)", sig)
    return {
        "path": path, "bundle_id": bid, "name": info.get("CFBundleDisplayName") or info.get("CFBundleName"),
        "version": info.get("CFBundleShortVersionString"), "build": info.get("CFBundleVersion"),
        "min_os": info.get("LSMinimumSystemVersion"), "executable": info.get("CFBundleExecutable"),
        "copyright": info.get("NSHumanReadableCopyright"), "sparkle": info.get("SUFeedURL"),
        "arch": output(["lipo", "-archs", os.path.join(path, "Contents/MacOS", info.get("CFBundleExecutable") or "")], timeout=5),
        "signed_by": authority[1].strip() if authority else None, "team": team[1] if team and team[1] != "not" else None,
        "quarantined": bool(xattr and "No such xattr" not in xattr),
        "privacy": services, "tcc_readable": readable,
        "usage_texts": {p[1]: info[p[3]] for p in PRIVACY if p[3] and p[3] in info},
    }


def privacy_overview(q):
    """Semua izin yang tercatat, dikelompokkan per layanan."""
    rows, readable = _tcc_rows()
    groups = {}
    for r in rows:
        p = PRIV_BY_KEY.get(r["service"])
        if not p:
            continue
        groups.setdefault(r["service"], {"key": r["service"], "name": p[1], "settings": settings_url(p[2]), "apps": []})
        groups[r["service"]]["apps"].append({"client": r["client"], "status": AUTH.get(r["auth"], str(r["auth"])),
                                             "target": r["target"] if r["target"] != "UNUSED" else None})
    order = [p[0] for p in PRIVACY]
    return {"services": sorted(groups.values(), key=lambda g: order.index(g["key"])), "tcc_readable": readable,
            "panes": [{"name": p[1], "settings": settings_url(p[2])} for p in PRIVACY
                      if p[2] != "Privacy_FilesAndFolders" or p[0].endswith("DocumentsFolder")]}


# ---------------------------------------------------------------- aksi

def action(body):
    act = body.get("action")
    if act == "macos-updates":
        return {"job": start_job("Cek update macOS (softwareupdate -l)", ["softwareupdate", "--list"], "softwareupdate")}
    if act == "open-settings":
        url = str(body.get("url", ""))
        if not url.startswith("x-apple.systempreferences:"):
            raise ApiError("URL pengaturan tidak valid")
        run(["open", url], timeout=10)
        return {"ok": True}
    if act == "mas-outdated":
        if not MAS:
            raise ApiError("`mas` belum terinstall")
        return {"job": start_job("mas outdated", [MAS, "outdated"], "mas")}
    path = find_app(str(body.get("path", "")))
    info = _info(path)
    bid = info.get("CFBundleIdentifier") or ""
    if act == "open":
        run(["open", path], timeout=15)
        return {"ok": True}
    if act == "reveal":
        run(["open", "-R", path], timeout=10)
        return {"ok": True}
    if act == "quit":
        code, out, err = run(["osascript", "-e", f'quit app id "{bid}"'], timeout=20) if BUNDLE_RE.match(bid) else (1, "", "")
        return {"ok": code == 0, "output": (out + err).strip()}
    if act == "force-quit":
        pids = _running().get(os.path.realpath(path), [])
        for pid in pids:
            try:
                os.kill(pid, 9)
            except ProcessLookupError:
                pass
        return {"ok": True, "killed": len(pids)}
    if act == "unquarantine":
        code, out, err = run(["xattr", "-dr", "com.apple.quarantine", path], timeout=30)
        if code != 0:
            raise ApiError((err or out).strip() or "gagal", HTTPStatus.INTERNAL_SERVER_ERROR)
        return {"ok": True}
    if act == "trash":
        if path.startswith("/System"):
            raise ApiError("Aplikasi sistem tidak bisa dihapus")
        script = f'tell application "Finder" to delete (POSIX file {json.dumps(path)})'
        code, out, err = run(["osascript", "-e", script], timeout=120)
        if code != 0:
            raise ApiError((err or out).strip() or "gagal memindahkan ke Trash", HTTPStatus.INTERNAL_SERVER_ERROR)
        return {"ok": True}
    if act == "reset-permission":
        service = str(body.get("service", ""))
        if service not in PRIV_BY_KEY and service != "All":
            raise ApiError("layanan tidak dikenal")
        if not BUNDLE_RE.match(bid):
            raise ApiError("bundle id tidak valid")
        short = "All" if service == "All" else service.replace("kTCCService", "")
        code, out, err = run(["tccutil", "reset", short, bid], timeout=20)
        if code != 0:
            raise ApiError((err or out).strip() or "tccutil gagal (izin tingkat sistem mungkin butuh admin)",
                           HTTPStatus.INTERNAL_SERVER_ERROR)
        return {"ok": True, "output": (out + err).strip()}
    if act == "mas-upgrade":
        if not MAS:
            raise ApiError("`mas` belum terinstall")
        receipt = output(["mdls", "-raw", "-name", "kMDItemAppStoreAdamID", path], timeout=5)
        if not receipt.isdigit():
            raise ApiError("ID App Store tidak ditemukan")
        return {"job": start_job(f"mas upgrade {info.get('CFBundleName')}", [MAS, "upgrade", receipt], "mas")}
    raise ApiError("aksi tidak valid")
