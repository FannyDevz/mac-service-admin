#!/usr/bin/env python3
"""Mac Service Admin — dashboard lokal untuk mengelola Mac dev environment:
brew services, aplikasi Homebrew, Docker, Herd, bahasa pemrograman
(PHP, Node.js, Python, Go, Rust, Java, Ruby, ...), statistik sistem, dan konfigurasi zsh.

Jalankan:  python3 server.py  [--port 8765]
Lalu buka: http://127.0.0.1:8765

Hanya bind ke 127.0.0.1, tanpa dependensi eksternal (stdlib saja).
"""
import argparse
import json
import plistlib
import os
import re
import shutil
import subprocess
import time
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import dockerx
import files
import ptyterm
import runtimes
import stats
import svc
from core import (BREW, BREW_PREFIX, ENV, HOME, PKG_RE, SHIM_DIR, ZSHRC_BLOCK_START, ApiError, DATA_DIR, cancel_job, get_job, list_jobs,
                  load_state, read_home, run, save_state, set_shims, start_job, start_steps, tail)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
HERD_BIN = os.path.join(HOME, "Library/Application Support/Herd/bin")
NVM_DIR = os.path.join(HOME, ".nvm")
NVM_SH = next((p for p in (os.path.join(NVM_DIR, "nvm.sh"),
                           os.path.join(BREW_PREFIX, "opt/nvm/nvm.sh")) if os.path.isfile(p)), None)

ALLOWED_HOSTS = {"127.0.0.1", "localhost"}
SERVICE_ACTIONS = {"start", "stop", "restart", "run", "kill"}
NODE_VER_RE = re.compile(r"^(v?\d+(\.\d+){0,2}|lts/[a-z*]+|node|system)$")


# ---------------------------------------------------------------- services

def list_services():
    code, out, err = run([BREW, "services", "info", "--all", "--json"])
    if code != 0:
        raise ApiError(err.strip() or "brew services gagal", HTTPStatus.INTERNAL_SERVER_ERROR)
    services = json.loads(out)
    stats = process_stats([str(s["pid"]) for s in services if s.get("pid")])
    for s in services:
        s.update(stats.get(str(s.get("pid")), {}))
    return services


def process_stats(pids):
    """CPU %, memori (MB) dan uptime per service, termasuk child process
    (mis. mysqld_safe -> mysqld)."""
    if not pids:
        return {}
    _, out, _ = run(["ps", "-A", "-o", "pid=,ppid=,pcpu=,rss=,etime="])
    procs, children = {}, {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) == 5:
            pid, ppid, cpu, rss, etime = parts
            procs[pid] = (float(cpu), int(rss), etime)
            children.setdefault(ppid, []).append(pid)
    stats = {}
    for root in pids:
        if root not in procs:
            continue
        cpu = rss = 0
        stack = [root]
        while stack:
            p = stack.pop()
            cpu += procs[p][0]
            rss += procs[p][1]
            stack.extend(children.get(p, []))
        stats[root] = {"cpu": round(cpu, 1), "mem_mb": round(rss / 1024, 1), "uptime": procs[root][2]}
    return stats


def known_service(name):
    svc = next((s for s in list_services() if s["name"] == name), None)
    if not svc:
        raise ApiError("service tidak dikenal", HTTPStatus.NOT_FOUND)
    return svc


def service_action(body):
    name, action = body.get("name", ""), body.get("action", "")
    if action not in SERVICE_ACTIONS:
        raise ApiError("aksi tidak valid")
    known_service(name)
    code, out, err = run([BREW, "services", action, name], timeout=120)
    if code != 0:
        raise ApiError((out + err).strip() or "gagal", HTTPStatus.INTERNAL_SERVER_ERROR)
    return {"ok": True, "output": (out + err).strip()}


def service_logs(q):
    svc = known_service(q.get("name", ""))
    same = svc.get("error_log_path") == svc.get("log_path")
    return {"log": tail(svc.get("log_path")),
            "error_log": None if same else tail(svc.get("error_log_path")),
            "log_path": svc.get("log_path"), "error_log_path": svc.get("error_log_path")}


# ---------------------------------------------------------------- apps (Homebrew)

def list_apps():
    code, out, err = run([BREW, "info", "--json=v2", "--installed"], timeout=120)
    if code != 0:
        raise ApiError(err.strip() or "brew info gagal", HTTPStatus.INTERNAL_SERVER_ERROR)
    data = json.loads(out)
    formulae = [{
        "name": f["name"], "type": "formula", "desc": f.get("desc") or "",
        "version": ", ".join(i["version"] for i in f.get("installed", [])),
        "latest": (f.get("versions") or {}).get("stable"),
        "outdated": bool(f.get("outdated")), "pinned": bool(f.get("pinned")),
        "on_request": any(i.get("installed_on_request") for i in f.get("installed", [])),
        "service": bool(f.get("service")), "homepage": f.get("homepage"),
    } for f in data.get("formulae", [])]
    casks = [{
        "name": c["token"], "type": "cask", "desc": c.get("desc") or ", ".join(c.get("name") or []),
        "version": c.get("installed") or "", "latest": c.get("version"),
        "outdated": bool(c.get("outdated")), "pinned": False, "on_request": True,
        "service": False, "homepage": c.get("homepage"),
    } for c in data.get("casks", [])]
    return {"apps": formulae + casks}


def search_apps(q):
    term = q.get("q", "").strip()
    if not PKG_RE.match(term):
        raise ApiError("kata kunci tidak valid")
    results = []
    for kind, flag in (("formula", "--formula"), ("cask", "--cask")):
        _, out, _ = run([BREW, "search", flag, term], timeout=60)
        for line in out.splitlines():
            name = line.strip().rstrip(" ✔")
            if name and not name.startswith("==>") and PKG_RE.match(name):
                results.append({"name": name, "type": kind, "installed": line.strip().endswith("✔")})
    return {"results": results[:100]}


def app_action(body):
    name, kind, action = body.get("name", ""), body.get("type"), body.get("action")
    if action == "upgrade-all":
        return {"job": start_job("brew upgrade (semua)", [BREW, "upgrade"], "brew")}
    if not PKG_RE.match(name) or kind not in ("formula", "cask"):
        raise ApiError("nama paket tidak valid")
    if action not in ("install", "uninstall", "upgrade", "reinstall"):
        raise ApiError("aksi tidak valid")
    cmd = [BREW, action, f"--{kind}", name]
    return {"job": start_job(f"brew {action} {name}", cmd, "brew")}


# ---------------------------------------------------------------- PHP

def php_versions():
    """Semua PHP yang terdeteksi: keg Homebrew + binary Laravel Herd."""
    found = []
    opt = os.path.join(BREW_PREFIX, "opt")
    seen = {}
    for entry in sorted(os.listdir(opt) if os.path.isdir(opt) else [], key=len):
        if not re.fullmatch(r"php(@\d+\.\d+)?", entry):
            continue
        real = os.path.realpath(os.path.join(opt, entry))
        if real in seen or not os.path.isfile(os.path.join(real, "bin/php")):
            continue
        seen[real] = entry
        found.append({"id": f"brew:{entry}", "source": "Homebrew", "formula": entry,
                      "bin": os.path.join(opt, entry, "bin/php"),
                      "version": os.path.basename(real)})
    if os.path.isdir(HERD_BIN):
        for entry in sorted(os.listdir(HERD_BIN)):
            m = re.fullmatch(r"php(\d)(\d)", entry)
            if m:
                found.append({"id": f"herd:{entry}", "source": "Herd",
                              "bin": os.path.join(HERD_BIN, entry),
                              "version": f"{m[1]}.{m[2]}"})
    for p in found:  # versi lengkap, mis. 8.4.23
        code, out, _ = run([p["bin"], "-r", "echo PHP_VERSION;"], timeout=10)
        if code == 0 and out.strip():
            p["version"] = out.strip()
    return found


def shell_check():
    """Apa yang benar-benar dipakai terminal baru (zsh interaktif)."""
    script = ('echo "__PHP__$(command -v php)"; echo "__PHPV__$(php -r \'echo PHP_VERSION;\' 2>/dev/null)"; '
              'echo "__NODE__$(command -v node)"; echo "__NODEV__$(node -v 2>/dev/null)"')
    try:
        _, out, _ = run(["zsh", "-i", "-c", script], timeout=20)
    except subprocess.TimeoutExpired:
        return {}
    result = {}
    for line in out.splitlines():
        m = re.match(r"__(PHP|PHPV|NODE|NODEV)__(.*)", line)
        if m:
            result[m[1].lower()] = m[2].strip()
    return result


HERD = os.path.join(HERD_BIN, "herd")


def herd_versions():
    """Parse tabel `herd php:list` -> [{version, installed, global, update}]."""
    if not os.path.isfile(HERD):
        return []
    try:
        _, out, _ = run([HERD, "php:list", "--no-ansi"], timeout=30)
    except subprocess.TimeoutExpired:
        return []
    rows = []
    for line in out.splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) == 3 and re.match(r"\d+\.\d+", cells[0]):
            rows.append({"version": cells[0].rstrip(" *"), "global": cells[0].endswith("*"),
                         "installed": cells[1] == "Installed", "update": cells[2] == "Yes"})
    return rows


def php_info():
    state = load_state()
    active = state.get("php")
    link = os.path.join(SHIM_DIR, "php")
    shell = shell_check()
    return {
        "versions": php_versions(), "selected": active if os.path.islink(link) else None,
        "shell": {"path": shell.get("php"), "version": shell.get("phpv")},
        "shim_active": shell.get("php") == link,
        "block_installed": ZSHRC_BLOCK_START in read_home(".zshrc"),
        "herd": herd_versions(),
    }


def php_select(body):
    choice = body.get("id")
    if choice in (None, "", "default"):
        set_shims("php", {})
        save_state(php=None)
        runtimes._cache["data"] = None
        return {"ok": True}
    target = next((p for p in php_versions() if p["id"] == choice), None)
    if not target:
        raise ApiError("versi PHP tidak dikenal", HTTPStatus.NOT_FOUND)
    if target["source"] == "Homebrew":
        bindir = os.path.dirname(target["bin"])  # php, phpize, php-config, pecl, pear, ...
        set_shims("php", {exe: os.path.join(bindir, exe) for exe in os.listdir(bindir)})
    else:
        # Herd: ganti versi global Herd (dipakai situs + shim `php` milik Herd),
        # lalu arahkan shim kita ke shim Herd agar mengikuti `herd use`.
        ver = re.sub(r"php(\d)(\d)", r"\1.\2", target["id"].split(":")[1])
        code, out, err = run([HERD, "use", ver, "--no-interaction", "--no-ansi"], timeout=120)
        if code != 0:
            raise ApiError((out + err).strip() or "herd use gagal", HTTPStatus.INTERNAL_SERVER_ERROR)
        set_shims("php", {"php": os.path.join(HERD_BIN, "php")})
    save_state(php=choice)
    runtimes._cache["data"] = None
    return {"ok": True}


def herd_action(body):
    action, ver = body.get("action"), str(body.get("version", ""))
    if not re.fullmatch(r"\d+\.\d+", ver) or action not in ("install", "update"):
        raise ApiError("permintaan tidak valid")
    return {"job": start_job(f"herd php:{action} {ver}",
                             [HERD, f"php:{action}", ver, "--no-interaction", "--no-ansi"], "herd")}


# ---------------------------------------------------------------- Node.js (nvm)

def nvm(*args, timeout=60):
    if not NVM_SH:
        raise ApiError("nvm tidak ditemukan", HTTPStatus.NOT_FOUND)
    script = f'export NVM_DIR="{NVM_DIR}"; . "$1" --no-use; shift; nvm "$@"'
    return ["bash", "-c", script, "_", NVM_SH, *args] if timeout is None else \
        run(["bash", "-c", script, "_", NVM_SH, *args], timeout=timeout)


def node_info():
    versions_dir = os.path.join(NVM_DIR, "versions/node")
    installed = sorted(os.listdir(versions_dir) if os.path.isdir(versions_dir) else [],
                       key=lambda v: [int(x) for x in re.findall(r"\d+", v)], reverse=True)
    alias = ""
    try:
        with open(os.path.join(NVM_DIR, "alias/default")) as f:
            alias = f.read().strip()
    except OSError:
        pass
    _, resolved, _ = nvm("version", "default") if NVM_SH else (0, "", "")
    system = None
    brew_node = os.path.join(BREW_PREFIX, "bin/node")
    if os.path.exists(brew_node):
        _, out, _ = run([brew_node, "-v"], timeout=10)
        system = out.strip()
    shell = shell_check()
    return {"nvm": bool(NVM_SH), "installed": installed, "default_alias": alias,
            "default_resolved": resolved.strip(), "system": system,
            "shell": {"path": shell.get("node"), "version": shell.get("nodev")}}


def node_remote():
    code, out, err = nvm("ls-remote", "--lts", timeout=60)
    if code != 0:
        raise ApiError(err.strip() or "gagal mengambil daftar versi", HTTPStatus.BAD_GATEWAY)
    latest = []
    for line in out.splitlines():
        m = re.search(r"(v\d+\.\d+\.\d+)\s+\(Latest LTS: ([^)]+)\)", line)
        if m:
            latest.append({"version": m[1], "codename": m[2]})
    return {"lts": latest[::-1]}


def node_action(body):
    action, version = body.get("action"), str(body.get("version", "")).strip()
    if not NODE_VER_RE.match(version):
        raise ApiError("versi tidak valid")
    if action == "default":
        runtimes._cache["data"] = None
        code, out, err = nvm("alias", "default", version)
        if code != 0:
            raise ApiError((out + err).strip(), HTTPStatus.INTERNAL_SERVER_ERROR)
        return {"ok": True, "output": out.strip()}
    if action == "install":
        return {"job": start_job(f"nvm install {version}", nvm("install", version, timeout=None), "nvm")}
    if action == "uninstall":
        return {"job": start_job(f"nvm uninstall {version}", nvm("uninstall", version, timeout=None), "nvm")}
    raise ApiError("aksi tidak valid")


# ---------------------------------------------------------------- Herd (situs, HTTPS, proxy)

HERD_LOG_DIR = os.path.join(HOME, "Library/Application Support/Herd/Log")
SITE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
PROXY_HOST_RE = re.compile(r"^https?://[A-Za-z0-9.-]+(:\d+)?/?$")


def herd(*args, timeout=60):
    """Jalankan CLI Herd dari $HOME (beberapa perintah bergantung pada cwd)."""
    if not os.path.isfile(HERD):
        raise ApiError("Herd tidak terinstall", HTTPStatus.NOT_FOUND)
    return run([HERD, *args, "--no-ansi", "--no-interaction"], timeout=timeout, cwd=HOME)


def parse_table(out):
    """Tabel ASCII Herd (+---+ | a | b |) -> list of dict."""
    rows = [[c.strip() for c in line.strip().strip("|").split("|")]
            for line in out.splitlines() if line.strip().startswith("|")]
    if not rows:
        return []
    head = rows[0]
    return [dict(zip(head, r)) for r in rows[1:]]


def herd_processes():
    procs = {"app": False, "nginx": False, "dnsmasq": False, "fpm": []}
    for line in sh_lines(["ps", "-Ao", "command="]):
        if "Herd.app/Contents/MacOS/Herd" in line:
            procs["app"] = True
        elif line.startswith("nginx: master") and "Herd" in line:
            procs["nginx"] = True
        elif "Herd.app" in line and "dnsmasq" in line:
            procs["dnsmasq"] = True
        m = re.search(r"php-fpm: master process .*Herd/config/fpm/([\d.]+)-fpm", line)
        if m:
            procs["fpm"].append(m[1])
    return procs


def sh_lines(cmd):
    try:
        return run(cmd, timeout=10)[1].splitlines()
    except subprocess.TimeoutExpired:
        return []


def herd_info():
    if not os.path.isfile(HERD):
        return {"installed": False}
    from concurrent.futures import ThreadPoolExecutor
    calls = {"sites": ("sites", "--json"), "links": ("links",), "isolated": ("isolated",),
             "proxies": ("proxies",), "paths": ("paths",), "tld": ("tld",), "version": ("--version",)}
    with ThreadPoolExecutor(len(calls) + 1) as pool:
        futures = {k: pool.submit(herd, *a) for k, a in calls.items()}
        versions_f = pool.submit(herd_versions)
        out = {k: f.result()[1] for k, f in futures.items()}
        versions = versions_f.result()
    try:
        sites = json.loads(out["sites"] or "[]")
    except ValueError:
        sites = []
    links = {r.get("Site") for r in parse_table(out["links"])}
    isolated = {r.get("Path", "").rsplit(".", 1)[0] for r in parse_table(out["isolated"])}
    global_php = next((v["version"] for v in versions if v["global"]), None)
    clean = []
    for s in sites:
        # PENTING: field "env" berisi isi .env (APP_KEY, password DB, ...) — jangan dikirim ke browser
        clean.append({
            "name": s.get("site"), "url": s.get("url"), "secured": bool(s.get("secured")),
            "php": s.get("phpVersion"), "node": s.get("nodeVersion"),
            "path": os.path.realpath(s.get("path") or ""), "favorite": bool(s.get("favorite")),
            "isolated": s.get("site") in isolated, "linked": s.get("site") in links,
            "has_db": bool(s.get("hasDatabaseCredentials")),
        })
    try:
        paths = sorted({p.rstrip("/") for p in json.loads(out["paths"] or "[]")})
    except ValueError:
        paths = []
    return {
        "installed": True, "version": out["version"].strip().replace("Herd ", ""),
        "tld": out["tld"].strip(), "global_php": global_php,
        "php_installed": [v["version"] for v in versions if v["installed"]],
        "processes": herd_processes(), "sites": clean,
        "proxies": parse_table(out["proxies"]), "paths": paths,
    }


def herd_site_action(body):
    action, name = body.get("action"), str(body.get("name", ""))
    if action in ("start", "stop", "restart"):
        return {"job": start_job(f"herd {action}", [HERD, action, "--no-ansi", "--no-interaction"], "herd", cwd=HOME)}
    if action == "open-app":
        run(["open", "-a", "Herd"])
        return {"ok": True}
    if action in ("link", "park", "forget"):
        path = os.path.realpath(os.path.expanduser(str(body.get("path", "")).strip()))
        if not os.path.isdir(path):
            raise ApiError(f"Folder tidak ditemukan: {path}")
        if action == "link":
            if name and not SITE_RE.match(name):
                raise ApiError("nama situs tidak valid")
            cmd = [HERD, "link", *([name] if name else []), "--no-ansi", "--no-interaction"]
            if body.get("secure"):
                cmd.append("--secure")
            if re.fullmatch(r"\d+\.\d+", str(body.get("php", ""))):
                cmd.append(f"--isolate={body['php']}")
            return {"job": start_job(f"herd link {name or os.path.basename(path)}", cmd, "herd", cwd=path)}
        return {"job": start_job(f"herd {action} {path}", [HERD, action, path, "--no-ansi", "--no-interaction"], "herd", cwd=HOME)}
    if action == "proxy":
        host = str(body.get("host", "")).strip()
        if not SITE_RE.match(name) or not PROXY_HOST_RE.match(host):
            raise ApiError("nama atau host proxy tidak valid (contoh host: http://localhost:3000)")
        cmd = [HERD, "proxy", name, host, "--no-ansi", "--no-interaction"] + (["--secure"] if body.get("secure") else [])
        return {"job": start_job(f"herd proxy {name}", cmd, "herd", cwd=HOME)}
    if not SITE_RE.match(name):
        raise ApiError("nama situs tidak valid")
    if action == "php":
        ver = str(body.get("php", ""))
        if ver == "global":
            cmd = [HERD, "unisolate", f"--site={name}"]
        elif re.fullmatch(r"\d+\.\d+", ver):
            cmd = [HERD, "isolate", ver, f"--site={name}"]
        else:
            raise ApiError("versi PHP tidak valid")
        return {"job": start_job(f"herd PHP {name} → {ver}", cmd + ["--no-ansi", "--no-interaction"], "herd", cwd=HOME)}
    if action == "folder":
        site = next((s for s in herd_info()["sites"] if s["name"] == name), None)
        if not site:
            raise ApiError("situs tidak ditemukan", HTTPStatus.NOT_FOUND)
        run(["open", site["path"]])
        return {"ok": True}
    cmds = {"secure": ["secure", name], "unsecure": ["unsecure", name],
            "unlink": ["unlink", name], "unproxy": ["unproxy", name]}
    if action not in cmds:
        raise ApiError("aksi tidak valid")
    return {"job": start_job(f"herd {' '.join(cmds[action])}", [HERD, *cmds[action], "--no-ansi", "--no-interaction"], "herd", cwd=HOME)}


SCAN_ROOTS = ["Documents", "Projects", "Code", "Sites", "Developer", "Herd", "Desktop"]
SCAN_SKIP = {"node_modules", "vendor", ".git", "storage", "Library", ".Trash", "bootstrap", "public", "resources"}


def project_type(path):
    has = lambda f: os.path.exists(os.path.join(path, f))  # noqa: E731
    if has("artisan"):
        return "Laravel"
    if has("wp-config.php") or has("wp-login.php"):
        return "WordPress"
    if has("composer.json"):
        return "PHP (Composer)"
    if has("index.php") or has("public/index.php"):
        return "PHP"
    return None


def php_constraint(path):
    try:
        with open(os.path.join(path, "composer.json")) as f:
            return (json.load(f).get("require") or {}).get("php")
    except (OSError, ValueError):
        return None


GENERIC_DIRS = {"portal", "app", "src", "web", "backend", "api", "server", "www", "public_html", "laravel", "site"}


def slugify(name):
    return re.sub(r"[^a-z0-9-]+", "-", name.lower()).strip("-") or "site"


def site_name(path):
    """Nama situs dari folder; folder generik (mis. portal/) diberi nama induknya."""
    base = os.path.basename(path.rstrip("/"))
    if base.lower() in GENERIC_DIRS:
        base = os.path.basename(os.path.dirname(path.rstrip("/"))) + "-" + base
    return slugify(base)


def herd_suggest(q):
    """Project PHP di folder kode yang belum dilayani Herd (belum di-link / di-park)."""
    info = herd_info()
    served = {os.path.realpath(s["path"]) for s in info.get("sites", [])}
    parked = [os.path.realpath(p) for p in info.get("paths", [])]
    found, deadline = [], time.time() + 4
    for root in (os.path.join(HOME, r) for r in SCAN_ROOTS):
        stack = [(root, 0)]
        while stack and time.time() < deadline:
            path, depth = stack.pop()
            try:
                entries = [e for e in os.scandir(path) if e.is_dir(follow_symlinks=False)]
            except OSError:
                continue
            kind = project_type(path) if depth else None
            if kind:
                real = os.path.realpath(path)
                if real not in served and os.path.dirname(real) not in parked:
                    found.append({"path": path, "name": site_name(path), "type": kind,
                                  "php": php_constraint(path), "modified": os.path.getmtime(path)})
                continue  # jangan masuk ke dalam project
            if depth < 3:
                stack += [(e.path, depth + 1) for e in entries
                          if e.name not in SCAN_SKIP and not e.name.startswith(".")]
    found.sort(key=lambda p: -p["modified"])
    return {"projects": found[:40]}


def pick_folder(body):
    """Dialog 'Pilih folder' bawaan macOS (Finder). Menunggu sampai user memilih."""
    start = os.path.realpath(os.path.expanduser(str(body.get("start") or "~/Documents")))
    if not os.path.isdir(start):
        start = HOME
    script = ('on run argv\n'
              '  activate\n'
              '  set f to choose folder with prompt (item 1 of argv) default location (POSIX file (item 2 of argv))\n'
              '  return POSIX path of f\n'
              'end run')
    prompt = str(body.get("prompt") or "Pilih folder project")[:120]
    try:
        code, out, err = run(["osascript", "-e", script, prompt, start], timeout=600)
    except subprocess.TimeoutExpired:
        raise ApiError("Dialog ditutup karena terlalu lama", HTTPStatus.REQUEST_TIMEOUT)
    if code != 0:
        if "-128" in err:  # user menekan Cancel
            return {"cancelled": True}
        raise ApiError(err.strip() or "gagal membuka dialog", HTTPStatus.INTERNAL_SERVER_ERROR)
    path = out.strip().rstrip("/")
    return {"path": path, "name": site_name(path), "type": project_type(path),
            "php": php_constraint(path)}


# ---------------------------------------------------------------- Herd: aplikasi Laravel baru

LARAVEL_PHP_MIN = {13: "8.3", 12: "8.2", 11: "8.2", 10: "8.1"}
EDITORS = {"vscode": ("Visual Studio Code", "Visual Studio Code"), "cursor": ("Cursor", "Cursor"),
           "phpstorm": ("PhpStorm", "PhpStorm"), "zed": ("Zed", "Zed"), "windsurf": ("Windsurf", "Windsurf"),
           "sublime": ("Sublime Text", "Sublime Text")}
_laravel_versions = {"t": 0, "v": None}


def laravel_versions():
    """Major version laravel/laravel dari Packagist (cache 1 hari), fallback statis."""
    if _laravel_versions["v"] and time.time() - _laravel_versions["t"] < 86400:
        return _laravel_versions["v"]
    majors = []
    try:
        _, out, _ = run(["curl", "-fsSL", "--max-time", "8", "https://repo.packagist.org/p2/laravel/laravel.json"], timeout=12)
        tags = [v["version"] for v in json.loads(out)["packages"]["laravel/laravel"]]
        majors = sorted({int(m[1]) for t in tags if (m := re.match(r"v?(\d+)\.\d+\.\d+$", t))}, reverse=True)
    except (ValueError, KeyError, subprocess.TimeoutExpired):
        pass
    majors = [m for m in majors if m >= 10][:4] or [13, 12, 11, 10]
    _laravel_versions.update(t=time.time(), v=majors)
    return majors


def herd_new_options(q):
    versions = herd_versions()
    installed = [v["version"] for v in versions if v["installed"]]
    return {
        "laravel": [{"major": m, "latest": i == 0, "php_min": LARAVEL_PHP_MIN.get(m, "8.2")}
                    for i, m in enumerate(laravel_versions())],
        "php_installed": installed, "global_php": next((v["version"] for v in versions if v["global"]), None),
        "editors": [{"id": k, "name": n} for k, (n, app) in EDITORS.items() if os.path.exists(f"/Applications/{app}.app")],
        "default_location": os.path.join(HOME, "Herd"), "tld": herd("tld")[1].strip() or "test",
        "mysql_running": any(s["name"].startswith(("mysql", "mariadb")) and s["running"] for s in list_services()),
        "postgres_running": any(s["name"].startswith("postgresql") and s["running"] for s in list_services()),
    }


def php_env(version):
    """ENV dengan `php` versi tertentu (Herd) paling depan di PATH, plus composer/laravel Herd."""
    shim = os.path.join(DATA_DIR, "php-shims", version)
    os.makedirs(shim, exist_ok=True)
    link = os.path.join(shim, "php")
    if os.path.islink(link):
        os.unlink(link)
    os.symlink(os.path.join(HERD_BIN, "php" + version.replace(".", "")), link)
    return dict(ENV, PATH=f"{shim}:{HERD_BIN}:" + ENV["PATH"]), link


def set_env_values(path, values):
    """Ubah/tambah KEY=VALUE di file .env."""
    with open(path) as f:
        text = f.read()
    for key, value in values.items():
        line = f"{key}={value}"
        text, n = re.subn(rf"^#?\s*{key}=.*$", line, text, count=1, flags=re.M)
        if not n:
            text = text.rstrip("\n") + f"\n{line}\n"
    with open(path, "w") as f:
        f.write(text)


def herd_new(body):
    name = str(body.get("name", "")).strip()
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,62}", name):
        raise ApiError("Nama project hanya boleh huruf kecil, angka, - dan _ (contoh: toko-online)")
    location = os.path.realpath(os.path.expanduser(str(body.get("location") or "~/Herd")))
    if not os.path.isdir(location):
        raise ApiError(f"Folder lokasi tidak ditemukan: {location}")
    path = os.path.join(location, name)
    if os.path.exists(path):
        raise ApiError(f"Folder {path} sudah ada")
    major = int(body.get("laravel") or 0)
    majors = laravel_versions()
    if major not in majors:
        raise ApiError("Versi Laravel tidak valid")
    latest = major == majors[0]
    php = str(body.get("php") or "")
    versions = herd_versions()
    installed = [v["version"] for v in versions if v["installed"]]
    if php not in installed:
        raise ApiError("Versi PHP Herd tidak valid")
    need = LARAVEL_PHP_MIN.get(major, "8.2")
    if tuple(map(int, php.split("."))) < tuple(map(int, need.split("."))):
        raise ApiError(f"Laravel {major} butuh PHP {need} atau lebih baru")
    db = body.get("database") or "sqlite"
    if db not in ("sqlite", "mysql", "mariadb", "pgsql"):
        raise ApiError("database tidak valid")
    env, php_bin = php_env(php)
    steps = []

    if latest:
        cmd = [php_bin, os.path.join(HERD_BIN, "laravel"), "new", name, "--no-interaction", f"--database={db}"]
        kit = body.get("starter") or "none"
        if kit in ("react", "vue", "svelte", "livewire"):
            cmd.append(f"--{kit}")
            auth = body.get("auth") or "laravel"
            if auth == "workos":
                cmd.append("--workos")
            elif auth == "none":
                cmd.append("--no-authentication")
            if body.get("teams"):
                cmd.append("--teams")
            if kit == "livewire" and body.get("livewire_class"):
                cmd.append("--livewire-class-components")
        cmd.append("--phpunit" if body.get("testing") == "phpunit" else "--pest")
        pm = body.get("js") or "npm"
        cmd.append({"npm": "--npm", "pnpm": "--pnpm", "bun": "--bun", "yarn": "--yarn"}.get(pm, "--no-node"))
        if body.get("git"):
            cmd.append("--git")
        cmd.append("--boost" if body.get("boost") else "--no-boost")
        steps.append((f"laravel new {name} (Laravel {major})", cmd, {"cwd": location, "env": env}))
    else:
        steps.append((f"composer create-project laravel/laravel:^{major}.0",
                      [php_bin, os.path.join(HERD_BIN, "composer"), "create-project", f"laravel/laravel:^{major}.0",
                       name, "--no-interaction", "--prefer-dist"], {"cwd": location, "env": env}))
        if db != "sqlite":
            steps.append(("Atur database di .env", lambda log: set_env_values(os.path.join(path, ".env"), {
                "DB_CONNECTION": db, "DB_HOST": "127.0.0.1", "DB_PORT": "5432" if db == "pgsql" else "3306",
                "DB_DATABASE": name.replace("-", "_"), "DB_USERNAME": "postgres" if db == "pgsql" else "root",
                "DB_PASSWORD": ""}), {}))
        if body.get("git"):
            steps += [("git init", ["git", "init", "-b", "main"], {"cwd": path, "optional": True}),
                      ("git add", ["git", "add", "-A"], {"cwd": path, "optional": True}),
                      ("commit awal", ["git", "commit", "-qm", "Initial commit"], {"cwd": path, "optional": True})]

    if db != "sqlite" and body.get("create_db"):
        dbname = name.replace("-", "_")
        if db in ("mysql", "mariadb"):
            mysql = shutil.which("mysql", path=f"{BREW_PREFIX}/bin:{BREW_PREFIX}/opt/mysql-client/bin:" + ENV["PATH"])
            if mysql:
                steps.append((f"Buat database MySQL `{dbname}`",
                              [mysql, "-uroot", "-h127.0.0.1", "-e", f"CREATE DATABASE IF NOT EXISTS `{dbname}`"],
                              {"optional": True}))
        else:
            createdb = shutil.which("createdb", path=f"{BREW_PREFIX}/bin:" + ENV["PATH"])
            if createdb:
                steps.append((f"Buat database PostgreSQL {dbname}", [createdb, dbname], {"optional": True}))
        if body.get("migrate"):
            steps.append(("php artisan migrate", [php_bin, "artisan", "migrate", "--force"],
                          {"cwd": path, "env": env, "optional": True}))

    # layani lewat Herd: folder di dalam parked path otomatis jadi situs; selain itu di-link
    parked = [os.path.realpath(p) for p in json.loads(herd("paths")[1] or "[]")]
    link = [HERD, "link", name, "--no-ansi", "--no-interaction", f"--isolate={php}"]
    if location in parked:
        link = [HERD, "isolate", php, f"--site={name}", "--no-ansi", "--no-interaction"]
    steps.append((f"Daftarkan ke Herd ({name}.test, PHP {php})", link, {"cwd": path}))
    if body.get("secure"):
        steps.append(("Aktifkan HTTPS", [HERD, "secure", name, "--no-ansi", "--no-interaction"], {"optional": True}))
    scheme = "https" if body.get("secure") else "http"
    steps.append(("Set APP_URL", lambda log: set_env_values(os.path.join(path, ".env"), {"APP_URL": f"{scheme}://{name}.test"}),
                  {"optional": True}))
    editor = body.get("editor")
    if editor in EDITORS:
        steps.append((f"Buka di {EDITORS[editor][0]}", ["open", "-a", EDITORS[editor][1], path], {"optional": True}))
    if body.get("open_browser"):
        steps.append(("Buka di browser", ["open", f"{scheme}://{name}.test"], {"optional": True}))
    return {"job": start_steps(f"Aplikasi Laravel baru: {name}", steps, "herd"), "path": path}


def herd_logs(q):
    name = q.get("file", "")
    if name not in ("nginx-error.log", "php-fpm.log"):
        raise ApiError("log tidak dikenal")
    return {"log": tail(os.path.join(HERD_LOG_DIR, name), 300), "path": os.path.join(HERD_LOG_DIR, name)}


# ---------------------------------------------------------------- zsh config

def expand(p):
    p = p.strip().strip('"\'')
    p = re.sub(r"^~(?=/|$)", HOME, p)
    return re.sub(r"\$\{?HOME\}?", HOME, p)


def diagnose(content):
    """Peringatan sederhana: PATH/source ke folder yang tidak ada, baris dobel."""
    issues, seen = [], {}
    for no, raw in enumerate(content.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line in seen:
            issues.append({"line": no, "msg": f"Duplikat dari baris {seen[line]}"})
        else:
            seen[line] = no
        m = re.match(r"(?:export\s+)?PATH=(.+)", line)
        if m:
            for part in m[1].strip('"\'').split(":"):
                if "PATH" in part or "$(" in part:
                    continue
                d = expand(part)
                if "$" not in d and d and not os.path.isdir(d):
                    issues.append({"line": no, "msg": f"Folder PATH tidak ada: {d}"})
        m = re.match(r"(?:source|\.)\s+([^\s;&|]+)", line)
        if m and "$(" not in m[1]:
            f = expand(m[1])
            if "$" not in f and not os.path.exists(f):
                issues.append({"line": no, "msg": f"File yang di-source tidak ada: {f}"})
    return issues










def file_read(q):
    data = files.read_file(q)
    if data["validator"] == "zsh":
        data["issues"] = diagnose(data["content"])  # PATH/source ke folder yang tidak ada, baris dobel
    return data


# ---------------------------------------------------------------- terminal

TERMINAL_APPS = {
    "terminal": ("Terminal", ["/System/Applications/Utilities/Terminal.app", "/Applications/Utilities/Terminal.app"]),
    "iterm": ("iTerm", ["/Applications/iTerm.app"]),
    "warp": ("Warp", ["/Applications/Warp.app"]),
    "ghostty": ("Ghostty", ["/Applications/Ghostty.app"]),
}


def terminal_apps(q=None):
    return {"apps": [{"id": k, "name": n} for k, (n, paths) in TERMINAL_APPS.items() if any(os.path.exists(p) for p in paths)]}


def open_in_terminal(body):
    """Jalankan perintah interaktif (claude, vim, ssh, tinker, ...) di aplikasi terminal sungguhan (punya TTY)."""
    import shlex
    command = str(body.get("command", "")).strip()
    cwd = os.path.realpath(os.path.expanduser(str(body.get("cwd") or "~")))
    if not os.path.isdir(cwd):
        cwd = HOME
    app = body.get("app") if body.get("app") in TERMINAL_APPS else "terminal"
    if app not in [a["id"] for a in terminal_apps()["apps"]]:
        app = "terminal"
    line = f"cd {shlex.quote(cwd)}" + (f" && {command}" if command else "")
    # perintah dikirim sebagai argumen (argv), bukan disisipkan ke teks AppleScript
    scripts = {
        "terminal": 'on run argv\n tell application "Terminal"\n  activate\n  do script (item 1 of argv)\n end tell\nend run',
        "iterm": ('on run argv\n tell application "iTerm"\n  activate\n  set w to (create window with default profile)\n'
                  '  tell current session of w to write text (item 1 of argv)\n end tell\nend run'),
    }
    if app in scripts:
        code, out, err = run(["osascript", "-e", scripts[app], line], timeout=20)
        if code != 0:
            raise ApiError(err.strip() or "gagal membuka terminal", HTTPStatus.INTERNAL_SERVER_ERROR)
        return {"ok": True, "app": TERMINAL_APPS[app][0], "pasted": False}
    # Warp/Ghostty: buka tab baru di folder tsb; perintah disalin ke clipboard untuk ditempel (⌘V)
    if command:
        subprocess.run(["pbcopy"], input=command, text=True, timeout=5)
    if app == "warp":
        from urllib.parse import quote
        run(["open", f"warp://action/new_tab?path={quote(cwd)}"], timeout=10)
    else:
        run(["open", "-na", "Ghostty", "--args", f"--working-directory={cwd}"], timeout=10)
    return {"ok": True, "app": TERMINAL_APPS[app][0], "pasted": bool(command)}


def open_activity_monitor(body):
    """Buka Activity Monitor; kalau belum jalan, pilih tab-nya dulu (CPU/Memori/Energi/Disk/Jaringan)."""
    tab = {"cpu": 0, "mem": 1, "energy": 2, "disk": 3, "network": 4}.get(body.get("tab"), 0)
    running = run(["pgrep", "-x", "Activity Monitor"], timeout=5)[0] == 0
    if not running:
        run(["defaults", "write", "com.apple.ActivityMonitor", "SelectedTab", "-int", str(tab)], timeout=5)
    code, out, err = run(["open", "-a", "Activity Monitor"], timeout=10)
    if code != 0:
        raise ApiError(err.strip() or "gagal membuka Activity Monitor", HTTPStatus.INTERNAL_SERVER_ERROR)
    return {"ok": True, "was_running": running}


# ---------------------------------------------------------------- sidebar

def nav_info(q):
    """Versi & status untuk sidebar: bahasa terdeteksi + Docker + Herd."""
    data = dict(runtimes.detect(q.get("refresh") == "1"))
    docker = None
    DOCKER = dockerx.DOCKER
    if os.path.exists(DOCKER):
        try:
            code, out, _ = run([DOCKER, "info", "--format", "{{.ServerVersion}}"], timeout=4)
        except subprocess.TimeoutExpired:
            code, out = 1, ""
        client = re.search(r"\d+\.\d+(\.\d+)?", run([DOCKER, "--version"], timeout=5)[1])
        docker = {"running": code == 0 and bool(out.strip()),
                  "version": out.strip() if code == 0 and out.strip() else (client[0] if client else None)}
    herd = None
    plist = "/Applications/Herd.app/Contents/Info.plist"
    if os.path.exists(plist):
        with open(plist, "rb") as f:
            version = plistlib.load(f).get("CFBundleShortVersionString")
        p = herd_processes()
        herd = {"version": version, "running": bool(p["nginx"] and p["fpm"])}
    return {**data, "docker": docker, "herd": herd}


# ---------------------------------------------------------------- HTTP

GET_ROUTES = {
    "/api/stats": lambda q: stats.SAMPLER.snapshot(int(q.get("since", 0) or 0)),
    "/api/services": lambda q: {"services": list_services()},
    "/api/services/catalog": svc.catalog,
    "/api/recommend": svc.recommendations,
    "/api/services/detail": lambda q: svc.service_detail(q, known_service),
    "/api/services/config": svc.config_read,
    "/api/cloudflared": svc.cf_info,
    "/api/logs": service_logs,
    "/api/apps": lambda q: list_apps(),
    "/api/apps/search": search_apps,
    "/api/php": lambda q: php_info(),
    "/api/node": lambda q: node_info(),
    "/api/node/remote": lambda q: node_remote(),
    "/api/runtimes": nav_info,
    "/api/lang": runtimes.lang_info,
    "/api/herd": lambda q: herd_info(),
    "/api/herd/logs": herd_logs,
    "/api/herd/suggest": herd_suggest,
    "/api/herd/new-options": herd_new_options,
    "/api/docker": dockerx.overview,
    "/api/docker/stats": dockerx.stats,
    "/api/docker/disk": dockerx.disk,
    "/api/docker/networks": dockerx.networks,
    "/api/docker/inspect": dockerx.inspect,
    "/api/docker/logs": dockerx.logs,
    "/api/docker/project-logs": dockerx.project_logs,
    "/api/docker/compose": dockerx.compose_read,
    "/api/docker/ports": dockerx.ports_check,
    "/api/docker/contexts": dockerx.contexts,
    "/api/files": files.list_files,
    "/api/files/read": file_read,
    "/api/files/backup": files.read_backup,
    "/api/ssh/keys": files.ssh_keys,
    "/api/git/identity": files.git_identity,
    "/api/jobs": list_jobs,
    "/api/terminal/apps": terminal_apps,
    "/api/pty/read": ptyterm.read,
    "/api/pty/list": ptyterm.list_sessions,
    "/api/job": lambda q: get_job(q.get("id", ""), int(q.get("offset", 0) or 0)),
}
POST_ROUTES = {
    "/api/action": service_action,
    "/api/terminal/open": open_in_terminal,
    "/api/pty/new": ptyterm.new_session,
    "/api/pty/write": ptyterm.write,
    "/api/pty/resize": ptyterm.resize,
    "/api/pty/kill": ptyterm.kill,
    "/api/activity-monitor": open_activity_monitor,
    "/api/job/cancel": cancel_job,
    "/api/services/config": svc.config_save,
    "/api/services/validate": svc.config_validate,
    "/api/services/install": svc.service_install,
    "/api/services/uninstall": lambda b: svc.service_uninstall(b, known_service),
    "/api/cloudflared": svc.cf_action,
    "/api/apps/action": app_action,
    "/api/php/select": php_select,
    "/api/php/herd": herd_action,
    "/api/herd/action": herd_site_action,
    "/api/pick-folder": pick_folder,
    "/api/herd/new": herd_new,
    "/api/lang/action": runtimes.lang_action,
    "/api/docker/action": dockerx.action,
    "/api/docker/run": dockerx.run_container,
    "/api/docker/exec": dockerx.exec_cmd,
    "/api/docker/context": dockerx.context_action,
    "/api/docker/compose/validate": dockerx.compose_validate,
    "/api/docker/compose/save": dockerx.compose_save,
    "/api/node/action": node_action,
    "/api/files/save": files.save_file,
    "/api/files/validate": files.validate_file,
    "/api/files/resolver": files.create_resolver,
    "/api/ssh/generate": files.ssh_generate,
}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    def log_message(self, fmt, *args):
        pass  # jangan spam terminal tiap polling

    def end_headers(self):
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")  # selalu ambil JS/CSS terbaru
        super().end_headers()

    # keamanan dasar: hanya localhost, tolak DNS rebinding & CSRF
    def _host_ok(self):
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0]
        return host in ALLOWED_HOSTS

    def _json(self, data, status=HTTPStatus.OK):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _dispatch(self, handler, arg):
        try:
            return self._json(handler(arg))
        except ApiError as e:
            return self._json({"error": str(e)}, e.status)
        except Exception as e:  # noqa: BLE001
            return self._json({"error": str(e)}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def do_GET(self):
        if not self._host_ok():
            return self._json({"error": "host tidak diizinkan"}, HTTPStatus.FORBIDDEN)
        url = urlparse(self.path)
        if url.path in GET_ROUTES:
            q = {k: v[0] for k, v in parse_qs(url.query).items()}
            return self._dispatch(GET_ROUTES[url.path], q)
        return super().do_GET()

    def do_POST(self):
        if not self._host_ok() or self.headers.get("X-Requested-With") != "service-admin":
            return self._json({"error": "request ditolak"}, HTTPStatus.FORBIDDEN)
        url = urlparse(self.path)
        if url.path not in POST_ROUTES:
            return self._json({"error": "not found"}, HTTPStatus.NOT_FOUND)
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            return self._json({"error": "JSON tidak valid"}, HTTPStatus.BAD_REQUEST)
        return self._dispatch(POST_ROUTES[url.path], body)


def main():
    parser = argparse.ArgumentParser(description="Mac Service Admin")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8765)))
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Mac Service Admin jalan di http://127.0.0.1:{args.port}  (Ctrl+C untuk berhenti)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nBerhenti.")


if __name__ == "__main__":
    main()
