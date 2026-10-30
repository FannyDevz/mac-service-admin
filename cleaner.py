"""Pembersih ala CCleaner: cache aplikasi & browser, log, cache developer
(npm, pip, Gradle, Xcode, Homebrew, …), Trash, pencari file besar, dan daftar
item startup (LaunchAgents/Daemons).

Hanya path dari registry `CATS` (dan anak langsungnya hasil scan) yang boleh
dihapus; file besar hanya yang muncul di hasil scan terakhir. Cookie, riwayat
browser, dan data aplikasi tidak disentuh."""
import os
import plistlib
import re
import shutil
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from http import HTTPStatus

from core import BREW, HOME, ApiError, output, run, start_steps

L = f"{HOME}/Library"
C = f"{L}/Caches"
BROWSER_CACHES = [f"{C}/com.apple.Safari", f"{C}/Google/Chrome", f"{C}/Firefox", f"{C}/Microsoft Edge",
                  f"{C}/BraveSoftware", f"{C}/Arc", f"{C}/company.thebrowser.Browser", f"{C}/com.operasoftware.Opera",
                  f"{C}/com.vivaldi.Vivaldi"]

# id: (grup, nama, keterangan, [path], cara bersih)
#   "contents" = hapus isi folder (foldernya tetap), "brew" = brew cleanup, "trash" = kosongkan Trash via Finder
CATS = {
    "caches": ("Sistem", "Cache aplikasi", "~/Library/Caches. Dibuat ulang otomatis oleh aplikasi. Cache milik macOS (com.apple.*) dilewati.",
               [C], "contents"),
    "logs": ("Sistem", "Log & crash report", "~/Library/Logs, termasuk DiagnosticReports.", [f"{L}/Logs"], "contents"),
    "saved-state": ("Sistem", "Status jendela tersimpan", "Saved Application State: posisi jendela saat aplikasi dibuka lagi.",
                    [f"{L}/Saved Application State"], "contents"),
    "trash": ("Sistem", "Trash", "Kosongkan Trash (permanen).", [f"{HOME}/.Trash"], "trash"),
    "browser": ("Browser", "Cache browser", "Safari, Chrome, Firefox, Edge, Brave, Arc, Opera, Vivaldi. Cookie, riwayat, dan login tidak dihapus.",
                BROWSER_CACHES, "contents"),
    "brew": ("Developer", "Homebrew", "brew cleanup --prune=all: hapus download lama dan versi paket yang sudah tidak dipakai.",
             [f"{C}/Homebrew"], "brew"),
    "npm": ("Developer", "npm cache", "~/.npm/_cacache", [f"{HOME}/.npm/_cacache"], "contents"),
    "yarn": ("Developer", "Yarn cache", "~/Library/Caches/Yarn", [f"{C}/Yarn"], "contents"),
    "bun": ("Developer", "Bun cache", "~/.bun/install/cache", [f"{HOME}/.bun/install/cache"], "contents"),
    "pip": ("Developer", "pip cache", "~/Library/Caches/pip", [f"{C}/pip"], "contents"),
    "composer": ("Developer", "Composer cache", "Cache paket Composer.", [f"{C}/composer", f"{HOME}/.composer/cache"], "contents"),
    "go": ("Developer", "Go build cache", "~/Library/Caches/go-build (bukan module cache).", [f"{C}/go-build"], "contents"),
    "cargo": ("Developer", "Cargo registry cache", "~/.cargo/registry/cache (file .crate yang sudah di-download).",
              [f"{HOME}/.cargo/registry/cache"], "contents"),
    "gradle": ("Developer", "Gradle cache", "~/.gradle/caches. Dependensi di-download ulang saat build berikutnya.",
               [f"{HOME}/.gradle/caches"], "contents"),
    "cocoapods": ("Developer", "CocoaPods cache", "~/Library/Caches/CocoaPods", [f"{C}/CocoaPods"], "contents"),
    "derived": ("Developer", "Xcode DerivedData", "Hasil build Xcode; project perlu build ulang.",
                [f"{L}/Developer/Xcode/DerivedData"], "contents"),
    "device-support": ("Developer", "Xcode iOS DeviceSupport", "Simbol debug per versi iOS; dibuat ulang saat perangkat dicolok.",
                       [f"{L}/Developer/Xcode/iOS DeviceSupport"], "contents"),
}
# folder di dalam ~/Library/Caches yang sudah punya kategori sendiri
CLAIMED = {p for cid, c in CATS.items() if cid != "caches" for p in c[3] if os.path.dirname(p) == C}
CLAIMED |= {f"{C}/Google", f"{C}/BraveSoftware"}
SCAN = {}    # id -> {"items": {nama: ukuran}} dari scan terakhir (untuk validasi hapus per item)
LARGE = {}   # path -> ukuran dari pencarian file besar terakhir


def _skip(cid, path):
    """Anak folder yang tidak ikut dibersihkan."""
    name = os.path.basename(path)
    if cid == "caches":
        return path in CLAIMED or name.startswith("com.apple.") or name == "CloudKit"
    return False


def _du_children(path):
    """{anak: byte} untuk isi langsung sebuah folder, plus total. None kalau tidak terbaca."""
    if not os.path.isdir(path):
        return None, None
    try:
        out = subprocess.run(["du", "-k", "-d", "1", path], capture_output=True, text=True, timeout=120).stdout
    except subprocess.TimeoutExpired:
        return None, None
    items, total = {}, None
    for line in out.splitlines():
        kb, _, p = line.partition("\t")
        if not kb.isdigit():
            continue
        if p.rstrip("/") == path.rstrip("/"):
            total = int(kb) * 1024
        else:
            items[p] = int(kb) * 1024
    if total is None:  # mis. ~/.Trash tanpa Full Disk Access
        return None, None
    # file langsung di folder tidak tercetak oleh du -d 1
    try:
        for e in os.scandir(path):
            if e.is_file(follow_symlinks=False) and e.path not in items:
                items[e.path] = e.stat(follow_symlinks=False).st_blocks * 512
    except OSError:
        pass
    return items, total


def _items(cid, scan_sizes=True):
    """Item yang bisa dibersihkan: isi folder (kategori satu folder) atau folder per
    aplikasi (kategori multi-folder seperti browser). {path: {"size", "skip"}}"""
    paths = [p for p in CATS[cid][3] if os.path.exists(p)]
    items, readable = {}, True
    for p in paths:
        children, total = _du_children(p) if scan_sizes else ({e.path: 0 for e in os.scandir(p)}, 0)
        if children is None:
            readable = False
        elif len(CATS[cid][3]) > 1:
            items[p] = {"size": total, "skip": False}
        else:
            items |= {c: {"size": s, "skip": _skip(cid, c)} for c, s in children.items()}
    return paths, items, readable


def _scan_cat(cid):
    group, name, desc, _, method = CATS[cid]
    paths, items, readable = _items(cid)
    if not paths:
        return None
    SCAN[cid] = {"items": items}
    size = sum(i["size"] for i in items.values() if not i["skip"])
    top = sorted(({"path": p, "name": os.path.relpath(p, HOME) if p.startswith(HOME) else p, **v}
                  for p, v in items.items()), key=lambda x: -x["size"])
    return {"id": cid, "group": group, "name": name, "desc": desc, "method": method,
            "size": size if readable or items else None, "readable": readable, "items": top[:60],
            "count": len(items), "skipped": sum(1 for i in items.values() if i["skip"])}


def scan(q):
    with ThreadPoolExecutor(6) as pool:
        cats = [c for c in pool.map(_scan_cat, CATS) if c]
    cats.sort(key=lambda c: (["Sistem", "Browser", "Developer"].index(c["group"]), -(c["size"] or 0)))
    return {"cats": cats, "total": sum(c["size"] or 0 for c in cats),
            "running": _running_browsers(), "docker": os.path.exists("/usr/local/bin/docker") or bool(shutil.which("docker"))}


def _running_browsers():
    names = {"Safari": "Safari", "Google Chrome": "Chrome", "firefox": "Firefox", "Microsoft Edge": "Edge",
             "Brave Browser": "Brave", "Arc": "Arc"}
    ps = output(["ps", "-Axo", "comm="])
    return sorted({label for proc, label in names.items() if f"/{proc}.app/" in ps or f"/MacOS/{proc}\n" in ps + "\n"})


# ---------------------------------------------------------------- bersihkan

def _rm(path):
    if os.path.islink(path) or not os.path.isdir(path):
        os.unlink(path)
    else:
        shutil.rmtree(path)


def _clean_paths(paths, log):
    failed = 0
    for p in paths:
        try:
            _rm(p)
        except FileNotFoundError:
            pass
        except OSError as e:
            failed += 1
            if failed <= 5:
                log(f"  dilewati: {os.path.relpath(p, HOME)} ({e.strerror})")
    if failed > 5:
        log(f"  … dan {failed - 5} item lain dilewati (sedang dipakai / dilindungi macOS)")


def _du(path):
    try:
        out = subprocess.run(["du", "-sk", path], capture_output=True, text=True, timeout=120).stdout
        return int(out.split("\t")[0]) * 1024
    except (ValueError, IndexError, subprocess.TimeoutExpired):
        return 0


def _step(cid, only=None):
    group, name, desc, paths, method = CATS[cid]

    def clean(log):
        if method == "trash":
            code, out, err = run(["osascript", "-e", 'tell application "Finder" to empty trash'], timeout=300)
            if code != 0:
                raise RuntimeError((err or out).strip() or "gagal mengosongkan Trash")
            log("  Trash dikosongkan.")
            return
        targets = [p for p in paths if os.path.exists(p)]
        before = sum(_du(p) for p in targets)
        if method == "brew":
            code, out, err = run([BREW, "cleanup", "--prune=all", "-s"], timeout=600)
            for line in (out + err).strip().splitlines()[-15:]:
                log("  " + line)
        else:
            items = (SCAN.get(cid) or {}).get("items") or _items(cid, scan_sizes=False)[1]
            chosen = [only] if only else [p for p, v in items.items() if not v["skip"]]
            if len(paths) > 1:  # kategori multi-folder: kosongkan isi folder tiap aplikasi, foldernya tetap
                chosen = [e.path for p in chosen if os.path.isdir(p) for e in os.scandir(p)]
            _clean_paths(chosen, log)
        after = sum(_du(p) for p in targets)
        log(f"  Dibebaskan: {_fmt(max(before - after, 0))}")
    return (name + (f": {os.path.basename(only)}" if only else ""), clean, {"optional": True})


def _fmt(b):
    for unit in ("B", "KB", "MB", "GB"):
        if b < 1024:
            return f"{b:.0f} {unit}" if unit == "B" else f"{b:.1f} {unit}"
        b /= 1024
    return f"{b:.1f} TB"


def clean(body):
    ids = body.get("ids") or []
    if not isinstance(ids, list) or not ids or any(i not in CATS for i in ids):
        raise ApiError("kategori tidak dikenal")
    item = body.get("item")
    if item is not None:  # satu folder dari rincian kategori
        if len(ids) != 1 or item not in (SCAN.get(ids[0], {}).get("items") or {}) or CATS[ids[0]][4] != "contents":
            raise ApiError("item tidak dikenal, scan ulang dulu", HTTPStatus.CONFLICT)
    steps = [_step(i, item) for i in ids]
    return {"job": start_steps(f"Pembersih: {', '.join(CATS[i][1] for i in ids)}", steps, "cleaner")}


# ---------------------------------------------------------------- file besar

def large(q):
    scope = q.get("scope", "home")
    try:
        min_mb = max(10, min(int(q.get("min", 200)), 100000))
    except ValueError:
        min_mb = 200
    results = []
    if scope == "downloads":  # semua isi Downloads (file & folder), lama atau besar
        base = f"{HOME}/Downloads"
        children, _ = _du_children(base)
        for p, size in (children or {}).items():
            if os.path.basename(p).startswith("."):  # .localized, .DS_Store
                continue
            try:
                st = os.stat(p, follow_symlinks=False)
            except OSError:
                continue
            results.append({"path": p, "size": size, "mtime": st.st_mtime, "dir": os.path.isdir(p)})
    else:
        out = output(["mdfind", "-onlyin", HOME, f"kMDItemFSSize > {min_mb * 1024 * 1024}"], timeout=30)
        for p in out.splitlines():
            if not p.startswith(HOME + "/") or (scope == "home" and p.startswith(L + "/")) or ".app/" in p:
                continue
            try:
                st = os.stat(p, follow_symlinks=False)
            except OSError:
                continue
            if os.path.isfile(p):
                results.append({"path": p, "size": st.st_size, "mtime": st.st_mtime, "dir": False})
    results.sort(key=lambda r: -r["size"])
    results = results[:200]
    LARGE.clear()
    LARGE.update({r["path"]: r["size"] for r in results})
    for r in results:
        r["name"] = os.path.relpath(r["path"], HOME)
    return {"files": results, "total": sum(r["size"] for r in results), "now": time.time()}


def large_action(body):
    paths = body.get("paths") or []
    if not isinstance(paths, list) or not paths or any(p not in LARGE for p in paths):
        raise ApiError("file tidak dikenal, cari ulang dulu", HTTPStatus.CONFLICT)
    act = body.get("action")
    if act == "reveal":
        run(["open", "-R", paths[0]], timeout=10)
        return {"ok": True}
    if act == "trash":  # lewat Finder supaya bisa dikembalikan (Put Back)
        lst = ", ".join(f'POSIX file "{p.replace(chr(92), chr(92) * 2).replace(chr(34), chr(92) + chr(34))}"' for p in paths)
        code, out, err = run(["osascript", "-e", f'tell application "Finder" to delete {{{lst}}}'], timeout=300)
        if code != 0:
            raise ApiError((err or out).strip() or "gagal memindahkan ke Trash", HTTPStatus.INTERNAL_SERVER_ERROR)
        for p in paths:
            LARGE.pop(p, None)
        return {"ok": True, "count": len(paths)}
    raise ApiError("aksi tidak valid")


# ---------------------------------------------------------------- startup

STARTUP_DIRS = [("user", f"{L}/LaunchAgents"), ("global", "/Library/LaunchAgents"), ("daemon", "/Library/LaunchDaemons")]


def startup(q):
    loaded = {}
    for line in output(["launchctl", "list"], timeout=10).splitlines()[1:]:
        cols = line.split("\t")
        if len(cols) == 3:
            loaded[cols[2]] = cols[0]
    items = []
    for scope, d in STARTUP_DIRS:
        try:
            names = sorted(f for f in os.listdir(d) if f.endswith(".plist"))
        except OSError:
            continue
        for f in names:
            path = os.path.join(d, f)
            try:
                with open(path, "rb") as fh:
                    pl = plistlib.load(fh)
            except Exception:  # noqa: BLE001
                pl = {}
            label = pl.get("Label") or f[:-6]
            prog = pl.get("Program") or (pl.get("ProgramArguments") or [None])[0]
            pid = loaded.get(label)
            items.append({"scope": scope, "path": path, "label": label, "program": prog,
                          "run_at_load": bool(pl.get("RunAtLoad")), "keep_alive": bool(pl.get("KeepAlive")),
                          "disabled": bool(pl.get("Disabled")),
                          "loaded": scope != "daemon" and pid is not None, "pid": int(pid) if pid and pid.isdigit() else None,
                          "brew": bool(re.match(r"(homebrew\.mxcl|sh\.brew)\.", label))})
    return {"items": items,
            "login_items_url": "x-apple.systempreferences:com.apple.LoginItems-Settings.extension"}


def startup_action(body):
    act, path = body.get("action"), str(body.get("path", ""))
    if act == "login-items":
        run(["open", "x-apple.systempreferences:com.apple.LoginItems-Settings.extension"], timeout=10)
        return {"ok": True}
    if not any(os.path.dirname(path) == d for _, d in STARTUP_DIRS) or not path.endswith(".plist") \
            or not os.path.isfile(path) or "/../" in path:
        raise ApiError("item startup tidak dikenal")
    if act == "reveal":
        run(["open", "-R", path], timeout=10)
        return {"ok": True}
    raise ApiError("aksi tidak valid")
