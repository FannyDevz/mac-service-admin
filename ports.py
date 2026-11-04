"""Port: daftar port TCP yang sedang listen, kegunaannya, project asalnya, dan cara mematikannya.

Tiap port diklasifikasikan supaya tombolnya benar: proses biasa dihentikan dengan sinyal, service
Homebrew lewat `brew services`, aplikasi lewat quit. Yang dikelola launchd/Herd/Docker atau milik macOS
tidak diberi tombol kill karena akan menyala lagi atau merusak fitur sistem."""
import os
import re
import signal
import time
from http import HTTPStatus

from core import HOME, ApiError, run

SELF_LABEL = "local.service-admin"
SHELLS = {"zsh", "bash", "fish", "login", "tmux"}
BREW_LABEL_RE = re.compile(r"^(?:homebrew\.mxcl|sh\.brew)\.(.+)$")
APP_RE = re.compile(r"^(?:%s)?/Applications/[^/]+\.app(?=/|$)" % re.escape(HOME))
# argumen perintah bisa berisi rahasia dan terlihat di `ps`, jadi disamarkan sebelum dikirim ke browser
SECRET_RE = re.compile(
    r"((?:authorization[:=]\s*)?bearer[\s:=]+"
    r"|--?[\w-]*(?:token|password|passwd|secret|api[-_]?key|apikey|credential)[\w-]*(?:[= ]+)"
    r"|\b[\w-]*(?:token|password|passwd|secret|api[-_]?key|apikey)[\w-]*=)\S+"
    r"|(://[^/\s:@]+:)[^/\s@]+(?=@)", re.I)

# (pola pada exe + argumen, judul, keterangan, membuka halaman web?)
DEV_RULES = [
    (r"\bvite\b", "Dev server Vite", "Server pengembangan frontend (React, Vue, Svelte, …).", True),
    (r"\bnext\b(?:[-/ ]|$)", "Dev server Next.js", "Server pengembangan aplikasi Next.js.", True),
    (r"\bnuxt\b", "Dev server Nuxt", "Server pengembangan aplikasi Nuxt.", True),
    (r"\bastro\b", "Dev server Astro", "Server pengembangan situs Astro.", True),
    (r"react-scripts", "Dev server Create React App", "Server pengembangan aplikasi React.", True),
    (r"\bwebpack\b", "Dev server Webpack", "Server pengembangan frontend.", True),
    (r"\bhugo\b", "Dev server Hugo", "Server pengembangan situs Hugo.", True),
    (r"\bremotion\b", "Remotion Studio", "Editor video Remotion.", True),
    (r"http\.server", "Server file statis (Python)", "Menyajikan isi folder lewat python -m http.server.", True),
    (r"artisan\s+serve", "Laravel (artisan serve)", "Server pengembangan aplikasi Laravel.", True),
    (r"manage\.py\s+runserver", "Django (runserver)", "Server pengembangan aplikasi Django.", True),
    (r"\buvicorn\b", "API Python (Uvicorn)", "Server aplikasi ASGI, misalnya FastAPI.", True),
    (r"\bgunicorn\b", "Aplikasi Python (Gunicorn)", "Server aplikasi WSGI.", True),
    (r"\bflask\b", "Aplikasi Flask", "Server pengembangan aplikasi Flask.", True),
    (r"\brails\b|\bpuma\b", "Aplikasi Rails", "Server aplikasi Ruby on Rails.", True),
    (r"\bjupyter\b", "Jupyter", "Server notebook Jupyter.", True),
    (r"\bphp\b.*\s-S\s", "Server bawaan PHP", "Server pengembangan dari php -S.", True),
    (r"\bngrok\b", "Tunnel ngrok", "Membuka port lokal ke internet.", False),
    (r"\bcloudflared\b", "Tunnel Cloudflare", "Membuka port lokal ke internet.", False),
    (r"\bmcp-remote\b", "Jembatan MCP", "Menghubungkan asisten AI ke server MCP jarak jauh.", False),
    (r"\bollama\b", "Ollama", "Server model AI lokal.", False),
]
# nama file exe -> (judul, keterangan)
DAEMONS = {
    "mysqld": ("MySQL", "Database MySQL."), "mariadbd": ("MariaDB", "Database MariaDB."),
    "postgres": ("PostgreSQL", "Database PostgreSQL."), "redis-server": ("Redis", "Cache & database Redis."),
    "mongod": ("MongoDB", "Database MongoDB."), "memcached": ("Memcached", "Cache Memcached."),
    "nginx": ("Nginx", "Web server Nginx."), "httpd": ("Apache", "Web server Apache."),
    "caddy": ("Caddy", "Web server Caddy."), "dnsmasq": ("dnsmasq", "Server DNS lokal."),
    "minio": ("MinIO", "Penyimpanan objek MinIO."), "mailpit": ("Mailpit", "Penangkap email untuk pengembangan."),
    "meilisearch": ("Meilisearch", "Mesin pencari Meilisearch."), "ollama": ("Ollama", "Server model AI lokal."),
}
RUNTIMES = {"node": "Aplikasi Node.js", "bun": "Aplikasi Bun", "deno": "Aplikasi Deno", "php": "Aplikasi PHP",
            "ruby": "Aplikasi Ruby", "java": "Aplikasi Java", "python": "Aplikasi Python", "python3": "Aplikasi Python"}
# hanya tebakan untuk proses yang tidak dikenali, jadi selalu ditampilkan sebagai "biasanya"
PORT_HINTS = {22: "SSH", 53: "DNS", 80: "HTTP", 443: "HTTPS", 1433: "SQL Server", 3000: "dev server web", 3306: "MySQL",
              5173: "Vite", 5432: "PostgreSQL", 6379: "Redis", 8000: "dev server web", 8080: "server web",
              8888: "Jupyter", 9000: "PHP-FPM", 9200: "Elasticsearch", 11211: "Memcached", 11434: "Ollama",
              27017: "MongoDB"}
SYSTEM = {
    "ControlCenter": ("AirPlay Receiver", "Menerima AirPlay dari perangkat Apple lain.",
                      "Matikan di System Settings → General → AirDrop & Handoff → AirPlay Receiver."),
    "rapportd": ("Handoff & Continuity", "Komunikasi antar perangkat Apple (Handoff, AirDrop, Universal Clipboard).",
                 "Layanan macOS. Bisa dibatasi di System Settings → General → AirDrop & Handoff."),
}
APPS = {
    "Discord": "Discord RPC: game dan aplikasi lain terhubung ke Discord.",
    "Visual Studio Code": "Port internal VS Code, biasanya server ekstensi.",
    "Cursor": "Port internal Cursor, biasanya server ekstensi.",
    "Claude": "Port internal aplikasi Claude.",
}


def _procs():
    """pid -> (ppid, etime, path exe) untuk semua proses."""
    _, out, _ = run(["ps", "-A", "-o", "pid=,ppid=,etime=,comm="], timeout=10)
    procs = {}
    for line in out.splitlines():
        m = re.match(r"\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$", line)
        if m:
            procs[int(m[1])] = (int(m[2]), m[3], m[4].strip())
    return procs


def _lsof_fields(cmd):
    """Baris `lsof -F` menjadi pasangan (pid, kode field, nilai)."""
    _, out, _ = run(cmd, timeout=10)  # lsof keluar dengan kode 1 kalau tidak ada hasil
    pid = None
    for line in out.splitlines():
        if line[:1] == "p":
            pid = int(line[1:])
        elif pid is not None and line:
            yield pid, line[0], line[1:]


def _listeners():
    """port -> {"addrs": set, "pids": set}. Tanpa sudo, lsof hanya melihat proses milik user ini."""
    ports = {}
    for pid, field, val in _lsof_fields(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-Fn"]):
        if field != "n" or ":" not in val:
            continue
        addr, _, port = val.rpartition(":")
        if port.isdigit():
            row = ports.setdefault(int(port), {"addrs": set(), "pids": set()})
            row["addrs"].add(addr)
            row["pids"].add(pid)
    return ports


def _labels():
    """pid -> label launchd. Aplikasi GUI (application.*) dilewati: dibuka user, bukan service."""
    _, out, _ = run(["launchctl", "list"], timeout=10)
    labels = {}
    for line in out.splitlines()[1:]:
        parts = line.split("\t")
        if len(parts) == 3 and parts[0].isdigit() and not parts[2].startswith("application."):
            labels[int(parts[0])] = parts[2]
    return labels


def _manager(pid, procs, labels):
    """Label launchd yang mengelola proses ini, menelusuri induknya (mysqld_safe -> mysqld).
    Berhenti di shell interaktif: yang dijalankan user dari terminal bukan milik service mana pun."""
    for _ in range(8):
        label = labels.get(pid)
        if label:
            return None if label == SELF_LABEL else label
        info = procs.get(pid)
        if not info or info[0] <= 1 or os.path.basename(info[2]).lstrip("-") in SHELLS:
            return None
        pid = info[0]
    return None


def _details(pids):
    """(pid -> folder kerja, pid -> perintah lengkap yang sudah disamarkan)."""
    joined = ",".join(map(str, sorted(pids)))
    cwds = {pid: val for pid, field, val in _lsof_fields(["lsof", "-a", "-p", joined, "-d", "cwd", "-Fn"]) if field == "n"}
    _, out, _ = run(["ps", "-ww", "-o", "pid=,command=", "-p", joined], timeout=10)
    cmds = {}
    for line in out.splitlines():
        m = re.match(r"\s*(\d+)\s+(.*)$", line)
        if m:
            cmds[int(m[1])] = mask(m[2])
    return cwds, cmds


def mask(cmd):
    return SECRET_RE.sub(lambda m: (m[1] or m[2]) + "•••", cmd)


def _project(cwd):
    """Folder kerja menjadi data project: nama dari root git kalau ada, dan path ringkas."""
    if not cwd or cwd == "/" or cwd == HOME or not (cwd.startswith(HOME + "/") or cwd.startswith(("/private/tmp/", "/tmp/"))):
        return None
    root, probe = cwd, cwd
    while probe.startswith(HOME + "/"):
        if os.path.exists(os.path.join(probe, ".git")):
            root = probe
            break
        probe = os.path.dirname(probe)
    return {"name": os.path.basename(root), "path": cwd.replace(HOME, "~", 1), "temp": not cwd.startswith(HOME),
            "missing": not os.path.isdir(cwd)}


def _classify(port, exe, cmd, label, is_self, cwd=""):
    """Kelompok, judul, keterangan, dan cara mematikan port ini."""
    # sebagian daemon mengganti nama prosesnya: "nginx: worker process", "postgres: writer"
    name = os.path.basename(exe).split(":")[0]
    daemon = DAEMONS.get(name)
    if is_self:
        return {"group": "service", "title": "Mac Service Admin", "desc": "Dashboard ini.",
                "hint": "Tidak bisa dimatikan dari halamannya sendiri.", "stop": None}
    if name in SYSTEM or exe.startswith(("/System/", "/usr/libexec/", "/usr/sbin/")) or (label or "").startswith("com.apple."):
        title, desc, hint = SYSTEM.get(name, (name, "Layanan bawaan macOS.", "Jangan dimatikan paksa: macOS akan menyalakannya lagi."))
        return {"group": "system", "title": title, "desc": desc, "hint": hint, "stop": None}
    if "/Herd.app/" in exe or "/Application Support/Herd/" in exe or "/Application Support/Herd/" in cwd:
        title = "Laravel Herd" if name == "Herd" else f"Laravel Herd · {(daemon or (name, ''))[0]}"
        return {"group": "service", "title": title, "desc": "Melayani situs lokal Herd." if name == "nginx" else "Bagian dari Laravel Herd.",
                "hint": "Dikelola Herd: hentikan dari aplikasi Herd.", "stop": {"type": "link", "label": "Buka Herd", "href": "#herd"}}
    if "OrbStack" in exe or "/Docker.app/" in exe or name.startswith(("com.docker", "docker")):
        return {"group": "service", "title": "Port container Docker", "desc": "Diteruskan ke container atau mesin Docker.",
                "hint": "Hentikan container-nya dari halaman Docker.", "stop": {"type": "link", "label": "Buka Docker", "href": "#docker"}}
    desc_daemon = daemon or ("", "")
    if port == 33060 and name == "mysqld":
        desc_daemon = ("MySQL X Protocol", "Protokol tambahan MySQL untuk mysqlsh dan X DevAPI.")
    brew = BREW_LABEL_RE.match(label or "")
    if brew:
        return {"group": "service", "title": desc_daemon[0] or brew[1], "desc": desc_daemon[1] or "Service Homebrew.",
                "hint": f"Service Homebrew {brew[1]}.", "stop": {"type": "brew", "name": brew[1]}}
    if label:
        return {"group": "service", "title": desc_daemon[0] or name, "desc": desc_daemon[1] or "Dijalankan otomatis oleh launchd.",
                "hint": f"Dikelola launchd ({label}), jadi akan menyala lagi kalau dimatikan paksa.",
                "stop": {"type": "link", "label": "Lihat Startup", "href": "#cleaner:startup"}}
    app = APP_RE.match(exe)
    if app:
        path = app[0]
        title = os.path.basename(path)[:-4]
        return {"group": "app", "title": title, "desc": APPS.get(title, f"Port internal aplikasi {title}."),
                "hint": "Port ini ikut tertutup kalau aplikasinya ditutup.", "stop": {"type": "app", "path": path, "name": title}}
    text = f"{exe} {cmd}"
    for pattern, title, desc, web in DEV_RULES:
        if re.search(pattern, text, re.I):
            return {"group": "project", "title": title, "desc": desc, "hint": "", "web": web, "stop": {"type": "kill"}}
    if desc_daemon[0]:
        return {"group": "service", "title": desc_daemon[0], "desc": desc_daemon[1], "hint": "", "stop": {"type": "kill"}}
    runtime = RUNTIMES.get(re.sub(r"[\d.]+$", "", name.lower())) or RUNTIMES.get(name.lower())
    guess = PORT_HINTS.get(port)
    desc = f"Port {port} biasanya dipakai untuk {guess}." if guess else "Kegunaannya tidak dikenali, cek perintah dan foldernya."
    return {"group": "project", "title": runtime or name, "desc": desc, "hint": "", "stop": {"type": "kill"}}


def _scan():
    listeners = _listeners()
    if not listeners:
        return []
    procs, labels = _procs(), _labels()
    cwds, cmds = _details({p for row in listeners.values() for p in row["pids"]})
    me = os.getpid()
    by_pid = {}
    for port, row in listeners.items():
        for pid in row["pids"]:
            by_pid.setdefault(pid, []).append(port)
    rows = []
    for port, row in listeners.items():
        pids = sorted(row["pids"])
        # proses utama: bukan anak dari proses lain di port yang sama (master nginx, bukan worker)
        main = next((p for p in pids if procs.get(p, (0,))[0] not in row["pids"]), pids[0])
        ppid, etime, exe = procs.get(main, (0, "", ""))
        cmd = cmds.get(main, exe)
        info = _classify(port, exe, cmd, _manager(main, procs, labels), me in row["pids"], cwds.get(main, ""))
        # folder kerja hanya berarti untuk proses yang dijalankan dari project
        project = _project(cwds.get(main)) if (info["stop"] or {}).get("type") == "kill" else None
        others = sorted({o for p in pids for o in by_pid[p]} - {port})
        rows.append({"port": port, "pid": main, "pids": pids, "process": os.path.basename(exe).split(":")[0], "exe": exe,
                     "command": cmd[:400], "etime": etime, "project": project, "others": others,
                     "public": any(a not in ("127.0.0.1", "[::1]", "localhost") for a in row["addrs"]),
                     "addrs": sorted(row["addrs"]), **info})
    return sorted(rows, key=lambda r: r["port"])


def info(q):
    return {"ports": _scan()}


def _still_open(port, pids):
    row = _listeners().get(port)
    return bool(row and row["pids"] & set(pids))


def action(body):
    """Hentikan proses di sebuah port. PID dari browser hanya dipakai sebagai pencocok: daftar proses
    selalu diambil ulang dari hasil scan, jadi tidak bisa dipakai untuk mengirim sinyal ke proses lain."""
    if body.get("action") != "stop":
        raise ApiError("aksi tidak valid")
    port, pid = body.get("port"), body.get("pid")
    if not isinstance(port, int) or not isinstance(pid, int) or isinstance(port, bool) or isinstance(pid, bool):
        raise ApiError("port atau PID tidak valid")
    row = next((r for r in _scan() if r["port"] == port and r["pid"] == pid), None)
    if not row:
        raise ApiError("Port ini sudah tidak dipakai proses tersebut. Muat ulang daftarnya.", HTTPStatus.CONFLICT)
    if (row["stop"] or {}).get("type") != "kill":
        raise ApiError(row["hint"] or "Port ini tidak bisa dihentikan dari sini.", HTTPStatus.FORBIDDEN)
    sig = signal.SIGKILL if body.get("force") else signal.SIGTERM
    for target in row["pids"]:
        try:
            os.kill(target, sig)
        except ProcessLookupError:
            pass
        except PermissionError:
            raise ApiError(f"Tidak punya izin menghentikan PID {target}.", HTTPStatus.FORBIDDEN)
    for _ in range(12):
        time.sleep(0.25)
        if not _still_open(port, row["pids"]):
            return {"ok": True, "stopped": True}
    return {"ok": True, "stopped": False}
