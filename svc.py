"""Manajemen service Homebrew lanjutan: katalog install, uninstall, info
(port, data, log), editor file konfigurasi + validasi, dan panel cloudflared
(login, tunnel, DNS route, ingress, jalankan tunnel manual)."""
import glob
import json
import os
import re
import shutil
import signal
import subprocess
import time
from http import HTTPStatus

from core import (BREW, BREW_PREFIX, DATA_DIR, ENV, HOME, PKG_RE, ApiError, load_state, output, run,
                  save_state, start_job, tail)

ETC, VAR = f"{BREW_PREFIX}/etc", f"{BREW_PREFIX}/var"
CFG_BACKUP_DIR = os.path.join(DATA_DIR, "backups", "services")
LOG_DIR = os.path.join(DATA_DIR, "logs")
CF_DIR = os.path.join(HOME, ".cloudflared")

CATALOG = [
    # (formula, nama, kategori, deskripsi)
    ("mysql", "MySQL", "Database", "Database relasional paling populer"),
    ("mariadb", "MariaDB", "Database", "Fork MySQL yang kompatibel"),
    ("postgresql@17", "PostgreSQL 17", "Database", "Database relasional open-source yang andal"),
    ("redis", "Redis", "Database", "Cache & queue in-memory (Laravel cache/queue/session)"),
    ("valkey", "Valkey", "Database", "Fork Redis open-source (lisensi BSD)"),
    ("mongodb/brew/mongodb-community", "MongoDB", "Database", "Database dokumen NoSQL"),
    ("memcached", "Memcached", "Database", "Cache in-memory sederhana"),
    ("nginx", "Nginx", "Web server", "Web server & reverse proxy"),
    ("httpd", "Apache", "Web server", "Apache HTTP Server"),
    ("caddy", "Caddy", "Web server", "Web server dengan HTTPS otomatis"),
    ("php", "PHP-FPM", "Web server", "FastCGI PHP untuk Nginx/Apache"),
    ("dnsmasq", "dnsmasq", "Jaringan", "DNS lokal (mis. *.test → 127.0.0.1)"),
    ("cloudflared", "Cloudflare Tunnel", "Jaringan", "Publikasikan app lokal ke internet"),
    ("mailpit", "Mailpit", "Tools", "Tangkap email development + web UI"),
    ("meilisearch", "Meilisearch", "Tools", "Search engine cepat (Laravel Scout)"),
    ("minio", "MinIO", "Tools", "Object storage kompatibel S3"),
    ("rabbitmq", "RabbitMQ", "Tools", "Message broker"),
    ("ollama", "Ollama", "Tools", "Jalankan LLM secara lokal"),
    ("grafana", "Grafana", "Monitoring", "Dashboard monitoring"),
    ("prometheus", "Prometheus", "Monitoring", "Pengumpul metrik"),
]


# 100 paket development yang direkomendasikan (semua sudah dicek ada di Homebrew).
# (nama, tipe, kategori, deskripsi)
RECOMMENDED = [
    # Database & cache
    ("mysql", "formula", "Database & cache", "Database relasional paling populer"),
    ("mariadb", "formula", "Database & cache", "Fork MySQL yang kompatibel"),
    ("postgresql@17", "formula", "Database & cache", "Database relasional open-source yang andal"),
    ("redis", "formula", "Database & cache", "Cache/queue/session in-memory"),
    ("valkey", "formula", "Database & cache", "Fork Redis berlisensi BSD"),
    ("memcached", "formula", "Database & cache", "Cache in-memory sederhana"),
    ("sqlite", "formula", "Database & cache", "Database file tunggal, cocok untuk test"),
    ("duckdb", "formula", "Database & cache", "Database analitik in-process (CSV/Parquet)"),
    ("pgcli", "formula", "Database & cache", "Klien PostgreSQL dengan autocomplete"),
    ("mycli", "formula", "Database & cache", "Klien MySQL dengan autocomplete"),
    # Web server & jaringan
    ("nginx", "formula", "Web server & jaringan", "Web server & reverse proxy"),
    ("httpd", "formula", "Web server & jaringan", "Apache HTTP Server"),
    ("caddy", "formula", "Web server & jaringan", "Web server dengan HTTPS otomatis"),
    ("traefik", "formula", "Web server & jaringan", "Reverse proxy modern untuk container"),
    ("dnsmasq", "formula", "Web server & jaringan", "DNS lokal, mis. *.test → 127.0.0.1"),
    ("mkcert", "formula", "Web server & jaringan", "Sertifikat HTTPS lokal yang dipercaya browser"),
    ("cloudflared", "formula", "Web server & jaringan", "Cloudflare Tunnel: publikasikan app lokal"),
    ("ngrok", "cask", "Web server & jaringan", "Tunnel publik instan ke localhost"),
    ("httpie", "formula", "Web server & jaringan", "curl yang ramah manusia untuk uji API"),
    ("wget", "formula", "Web server & jaringan", "Download file dari terminal"),
    # Queue, search & storage
    ("rabbitmq", "formula", "Queue, search & storage", "Message broker AMQP"),
    ("kafka", "formula", "Queue, search & storage", "Event streaming platform"),
    ("nats-server", "formula", "Queue, search & storage", "Messaging ringan & cepat"),
    ("meilisearch", "formula", "Queue, search & storage", "Search engine cepat (Laravel Scout)"),
    ("opensearch", "formula", "Queue, search & storage", "Search & analytics (fork Elasticsearch)"),
    ("minio", "formula", "Queue, search & storage", "Object storage kompatibel S3"),
    ("mailpit", "formula", "Queue, search & storage", "Tangkap email development + web UI"),
    # AI & monitoring
    ("ollama", "formula", "AI & monitoring", "Jalankan LLM (Llama, Qwen, dll.) secara lokal"),
    ("llama.cpp", "formula", "AI & monitoring", "Inference LLM di CPU/GPU Apple Silicon"),
    ("grafana", "formula", "AI & monitoring", "Dashboard monitoring"),
    ("prometheus", "formula", "AI & monitoring", "Pengumpul metrik"),
    ("btop", "formula", "AI & monitoring", "Monitor resource yang cantik di terminal"),
    ("htop", "formula", "AI & monitoring", "Monitor proses interaktif"),
    # Bahasa & version manager
    ("fnm", "formula", "Bahasa & version manager", "Node version manager super cepat (alternatif nvm)"),
    ("pnpm", "formula", "Bahasa & version manager", "Package manager Node hemat disk"),
    ("yarn", "formula", "Bahasa & version manager", "Package manager Node"),
    ("deno", "formula", "Bahasa & version manager", "Runtime JS/TS modern dan aman"),
    ("bun", "formula", "Bahasa & version manager", "Runtime JS all-in-one yang sangat cepat"),
    ("uv", "formula", "Bahasa & version manager", "Package & project manager Python super cepat"),
    ("pyenv", "formula", "Bahasa & version manager", "Kelola banyak versi Python"),
    ("pipx", "formula", "Bahasa & version manager", "Install aplikasi CLI Python terisolasi"),
    ("go", "formula", "Bahasa & version manager", "Bahasa Go"),
    ("rustup", "formula", "Bahasa & version manager", "Installer & toolchain manager Rust"),
    ("rbenv", "formula", "Bahasa & version manager", "Kelola banyak versi Ruby"),
    ("openjdk", "formula", "Bahasa & version manager", "Java Development Kit"),
    ("maven", "formula", "Bahasa & version manager", "Build tool Java"),
    ("gradle", "formula", "Bahasa & version manager", "Build tool Java/Kotlin/Android"),
    ("composer", "formula", "Bahasa & version manager", "Package manager PHP"),
    ("php", "formula", "Bahasa & version manager", "PHP terbaru + PHP-FPM"),
    ("mise", "formula", "Bahasa & version manager", "Satu version manager untuk semua bahasa"),
    ("direnv", "formula", "Bahasa & version manager", "Env var otomatis per folder project"),
    # CLI produktivitas
    ("jq", "formula", "CLI produktivitas", "Olah JSON di terminal"),
    ("yq", "formula", "CLI produktivitas", "Olah YAML/JSON/XML di terminal"),
    ("fzf", "formula", "CLI produktivitas", "Fuzzy finder untuk file, history, dll."),
    ("ripgrep", "formula", "CLI produktivitas", "Cari teks di kode, sangat cepat (rg)"),
    ("fd", "formula", "CLI produktivitas", "Pengganti find yang simpel & cepat"),
    ("bat", "formula", "CLI produktivitas", "cat dengan syntax highlight"),
    ("eza", "formula", "CLI produktivitas", "ls modern dengan ikon & git status"),
    ("zoxide", "formula", "CLI produktivitas", "cd pintar yang mengingat folder"),
    ("tlrc", "formula", "CLI produktivitas", "tldr: contoh singkat pemakaian perintah"),
    ("tree", "formula", "CLI produktivitas", "Tampilkan struktur folder"),
    ("tmux", "formula", "CLI produktivitas", "Terminal multiplexer (split & session)"),
    ("neovim", "formula", "CLI produktivitas", "Editor Vim modern"),
    ("starship", "formula", "CLI produktivitas", "Prompt shell cepat & informatif"),
    ("zsh-autosuggestions", "formula", "CLI produktivitas", "Saran perintah dari history di zsh"),
    ("zsh-syntax-highlighting", "formula", "CLI produktivitas", "Warna sintaks perintah di zsh"),
    ("shellcheck", "formula", "CLI produktivitas", "Linter untuk script shell"),
    ("just", "formula", "CLI produktivitas", "Task runner (alternatif Makefile)"),
    ("watchman", "formula", "CLI produktivitas", "File watcher (React Native, Jest)"),
    # Git
    ("git", "formula", "Git", "Git versi terbaru"),
    ("gh", "formula", "Git", "GitHub CLI: PR, issue, Actions"),
    ("git-lfs", "formula", "Git", "Simpan file besar di Git"),
    ("lazygit", "formula", "Git", "UI Git di terminal"),
    ("git-delta", "formula", "Git", "Tampilan git diff yang jauh lebih enak"),
    ("pre-commit", "formula", "Git", "Jalankan linter otomatis sebelum commit"),
    ("act", "formula", "Git", "Jalankan GitHub Actions secara lokal"),
    # DevOps & cloud
    ("kubernetes-cli", "formula", "DevOps & cloud", "kubectl untuk Kubernetes"),
    ("helm", "formula", "DevOps & cloud", "Package manager Kubernetes"),
    ("k9s", "formula", "DevOps & cloud", "UI terminal untuk Kubernetes"),
    ("kind", "formula", "DevOps & cloud", "Cluster Kubernetes lokal di Docker"),
    ("opentofu", "formula", "DevOps & cloud", "Infrastructure as code (fork Terraform)"),
    ("awscli", "formula", "DevOps & cloud", "CLI Amazon Web Services"),
    ("flyctl", "formula", "DevOps & cloud", "Deploy app ke Fly.io"),
    ("ansible", "formula", "DevOps & cloud", "Otomasi konfigurasi server"),
    # Keamanan & testing
    ("mitmproxy", "cask", "Keamanan & testing", "Intip & ubah traffic HTTP(S)"),
    ("trivy", "formula", "Keamanan & testing", "Scan kerentanan image & dependency"),
    ("sops", "formula", "Keamanan & testing", "Enkripsi file secret (.env, YAML)"),
    ("age", "formula", "Keamanan & testing", "Enkripsi file yang simpel"),
    ("k6", "formula", "Keamanan & testing", "Load testing API dengan script JS"),
    ("cocoapods", "formula", "Keamanan & testing", "Dependency manager iOS (React Native/Flutter)"),
    # Aplikasi GUI
    ("visual-studio-code", "cask", "Aplikasi GUI", "Code editor paling populer"),
    ("zed", "cask", "Aplikasi GUI", "Code editor super cepat"),
    ("orbstack", "cask", "Aplikasi GUI", "Docker & Linux VM ringan untuk Mac"),
    ("tableplus", "cask", "Aplikasi GUI", "GUI database (MySQL, Postgres, Redis, ...)"),
    ("dbeaver-community", "cask", "Aplikasi GUI", "GUI database universal gratis"),
    ("bruno", "cask", "Aplikasi GUI", "API client offline (alternatif Postman)"),
    ("postman", "cask", "Aplikasi GUI", "API client & testing"),
    ("proxyman", "cask", "Aplikasi GUI", "Debug traffic HTTP(S) dengan GUI"),
    ("fork", "cask", "Aplikasi GUI", "Git client GUI yang cepat"),
    ("raycast", "cask", "Aplikasi GUI", "Launcher produktif pengganti Spotlight"),
]


def recommendations(q):
    formulae = set(output([BREW, "list", "--formula", "-1"], timeout=30).split())
    casks = set(output([BREW, "list", "--cask", "-1"], timeout=30).split())
    return {"items": [{"name": n, "type": t, "category": c, "desc": d,
                       "installed": n in (casks if t == "cask" else formulae)} for n, t, c, d in RECOMMENDED]}


def brew_versions():
    out = output([BREW, "list", "--formula", "--versions"], timeout=30)
    return {line.split()[0]: line.split()[-1] for line in out.splitlines() if line.strip()}


def catalog(q):
    installed = brew_versions()
    return {"catalog": [{"formula": f, "name": n, "category": c, "desc": d,
                         "installed": f.split("/")[-1] in installed} for f, n, c, d in CATALOG]}


# ---------------------------------------------------------------- konfigurasi per service

def php_dir(name):
    """php -> etc/php/8.5, php@8.3 -> etc/php/8.3"""
    m = re.match(r"php@(\d+\.\d+)$", name)
    if m:
        return f"{ETC}/php/{m[1]}"
    ver = re.match(r"\d+\.\d+", brew_versions().get(name, "") or "")
    return f"{ETC}/php/{ver[0]}" if ver else None


def service_spec(name):
    """File config, validator, dan folder data untuk sebuah service."""
    opt = f"{BREW_PREFIX}/opt/{name}"
    files, validate, data = [], None, None
    if re.match(r"(mysql|mariadb)", name):
        files = [f"{ETC}/my.cnf", *sorted(glob.glob(f"{ETC}/my.cnf.d/*.cnf"))]
        validate = lambda f: [f"{opt}/bin/mysqld", f"--defaults-file={f}", "--validate-config"]  # noqa: E731
        data = f"{VAR}/mysql"
    elif name.startswith("postgresql"):
        data = f"{VAR}/{name}"
        files = [f"{data}/postgresql.conf", f"{data}/pg_hba.conf"]
    elif name in ("redis", "valkey"):
        files = [f"{ETC}/{name}.conf"]
        data = f"{VAR}/db/{name}"
    elif name == "nginx":
        files = [f"{ETC}/nginx/nginx.conf", *sorted(glob.glob(f"{ETC}/nginx/servers/*"))]
        validate = lambda f: [f"{opt}/bin/nginx", "-t"]  # noqa: E731
        data = f"{VAR}/www"
    elif name == "httpd":
        files = [f"{ETC}/httpd/httpd.conf", f"{ETC}/httpd/extra/httpd-vhosts.conf"]
        validate = lambda f: [f"{opt}/bin/apachectl", "-t"]  # noqa: E731
    elif name == "caddy":
        files = [f"{ETC}/Caddyfile"]
        validate = lambda f: [f"{opt}/bin/caddy", "validate", "--config", f, "--adapter", "caddyfile"]  # noqa: E731
    elif re.match(r"php(@\d+\.\d+)?$", name):
        d = php_dir(name)
        if d:
            files = [f"{d}/php.ini", f"{d}/php-fpm.conf", *sorted(glob.glob(f"{d}/php-fpm.d/*.conf")),
                     *sorted(glob.glob(f"{d}/conf.d/*.ini"))]
        validate = lambda f: [f"{opt}/sbin/php-fpm", "-t"]  # noqa: E731
    elif name == "dnsmasq":
        files = [f"{ETC}/dnsmasq.conf", *sorted(glob.glob(f"{ETC}/dnsmasq.d/*"))]
        validate = lambda f: [f"{opt}/sbin/dnsmasq", "--test", f"--conf-file={f}"]  # noqa: E731
    elif name == "cloudflared":
        files = [f"{CF_DIR}/config.yml", f"{CF_DIR}/config.yaml"]
        validate = lambda f: [f"{opt}/bin/cloudflared", "tunnel", "--config", f, "ingress", "validate"]  # noqa: E731
    elif name == "mongodb-community":
        files = [f"{ETC}/mongod.conf"]
        data = f"{VAR}/mongodb"
    elif name == "rabbitmq":
        files = [f"{ETC}/rabbitmq/rabbitmq-env.conf", f"{ETC}/rabbitmq/rabbitmq.conf"]
    return {"files": [f for f in files if os.path.isfile(f)], "validate": validate,
            "data": data if data and os.path.isdir(data) else None}


def descendants(pid):
    out = output(["ps", "-A", "-o", "pid=,ppid="])
    children = {}
    for line in out.splitlines():
        p = line.split()
        if len(p) == 2:
            children.setdefault(p[1], []).append(p[0])
    result, stack = [], [str(pid)]
    while stack:
        p = stack.pop()
        result.append(p)
        stack += children.get(p, [])
    return result


def listening_ports(pid):
    if not pid:
        return []
    out = output(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", ",".join(descendants(pid))], timeout=10)
    ports = sorted({m[1] for m in re.finditer(r"TCP \S*:(\d+) \(LISTEN\)", out)}, key=int)
    return ports


def service_detail(q, known_service):
    name = q.get("name", "")
    svc = known_service(name)
    spec = service_spec(name)
    formula_info = {}
    try:
        info = json.loads(output([BREW, "info", "--json=v2", name], timeout=30))["formulae"][0]
        formula_info = {"desc": info.get("desc"), "homepage": info.get("homepage"),
                        "version": (info.get("installed") or [{}])[0].get("version"),
                        "caveats": info.get("caveats")}
    except (ValueError, KeyError, IndexError):
        pass
    return {"service": svc, "formula": formula_info, "config_files": spec["files"],
            "can_validate": bool(spec["validate"]), "data_dir": spec["data"],
            "ports": listening_ports(svc.get("pid")), "backup_dir": CFG_BACKUP_DIR}


def config_path(name, path):
    spec = service_spec(name)
    if path not in spec["files"]:
        raise ApiError("file config tidak dikenal untuk service ini", HTTPStatus.FORBIDDEN)
    return path, spec


def config_read(q):
    path, _ = config_path(q.get("name", ""), q.get("path", ""))
    with open(path, errors="replace") as f:
        return {"path": path, "content": f.read()}


def validate_config(spec, path):
    if not spec["validate"]:
        return True, "Service ini tidak punya validator bawaan."
    try:
        code, out, err = run(spec["validate"](path), timeout=30)
    except (OSError, subprocess.TimeoutExpired) as e:
        return True, f"Validator tidak bisa dijalankan: {e}"
    return code == 0, (out + err).strip() or ("OK" if code == 0 else f"exit {code}")


def config_save(body):
    name = body.get("name", "")
    path, spec = config_path(name, body.get("path", ""))
    content = body.get("content")
    if not isinstance(content, str):
        raise ApiError("konten tidak valid")
    os.makedirs(CFG_BACKUP_DIR, exist_ok=True)
    backup = os.path.join(CFG_BACKUP_DIR, f"{name.replace('/', '_')}__{os.path.basename(path)}.{time.strftime('%Y%m%d-%H%M%S')}")
    shutil.copy2(path, backup)
    with open(path, "w") as f:
        f.write(content)
    ok, msg = validate_config(spec, path)
    if not ok and not body.get("force"):
        shutil.copy2(backup, path)  # kembalikan: config baru tidak valid
        raise ApiError(f"Konfigurasi TIDAK valid, perubahan dibatalkan:\n{msg}", HTTPStatus.UNPROCESSABLE_ENTITY)
    result = {"ok": True, "backup": backup, "validation": msg}
    if body.get("restart"):
        code, out, err = run([BREW, "services", "restart", name], timeout=120)
        result["restart"] = (out + err).strip()
    return result


def config_validate(body):
    path, spec = config_path(body.get("name", ""), body.get("path", ""))
    ok, msg = validate_config(spec, path)
    return {"ok": ok, "output": msg}


def service_install(body):
    formula = str(body.get("formula", ""))
    if not PKG_RE.match(formula):
        raise ApiError("nama formula tidak valid")
    return {"job": start_job(f"brew install {formula}", [BREW, "install", formula], "brew")}


def service_uninstall(body, known_service):
    name = body.get("name", "")
    known_service(name)
    run([BREW, "services", "stop", name], timeout=120)  # hentikan dulu agar launchd bersih
    return {"job": start_job(f"brew uninstall {name}", [BREW, "uninstall", name], "brew")}


# ---------------------------------------------------------------- cloudflared

def cf_bin():
    p = f"{BREW_PREFIX}/bin/cloudflared"
    if not os.path.exists(p):
        raise ApiError("cloudflared belum terinstall", HTTPStatus.NOT_FOUND)
    return p


def cf_config_file():
    return next((f for f in (f"{CF_DIR}/config.yml", f"{CF_DIR}/config.yaml") if os.path.isfile(f)), None)


def parse_ingress(text):
    """Parser YAML minimal untuk blok ingress cloudflared (hostname/service)."""
    rules, cur = [], None
    for line in text.splitlines():
        m = re.match(r"\s*-\s*(hostname|service):\s*(\S+)", line)
        if m:
            cur = {m[1]: m[2]}
            rules.append(cur)
            continue
        m = re.match(r"\s+(hostname|service|path):\s*(\S+)", line)
        if m and cur is not None:
            cur[m[1]] = m[2]
    return [r for r in rules if "service" in r]


def cf_processes():
    """Proses `cloudflared tunnel run` yang sedang jalan (dari dashboard atau terminal)."""
    procs = []
    for line in output(["ps", "-Ao", "pid=,command="]).splitlines():
        m = re.match(r"\s*(\d+)\s+(.*cloudflared.*\btunnel\b.*\brun\b.*)", line)
        if m and "ps -Ao" not in m[2]:
            procs.append({"pid": int(m[1]), "command": m[2].strip()})
    return procs


def cf_info(q):
    binary = cf_bin()
    cfg = cf_config_file()
    content = open(cfg, errors="replace").read() if cfg else ""
    tunnel_id = re.search(r"^tunnel:\s*(\S+)", content, re.M)
    logged_in = os.path.isfile(f"{CF_DIR}/cert.pem")
    tunnels, err = [], None
    if logged_in:
        code, out, e = run([binary, "tunnel", "list", "--output", "json"], timeout=20)
        try:
            tunnels = json.loads(out) if code == 0 else []
        except ValueError:
            tunnels = []
        err = None if code == 0 else (e.strip() or out.strip())
    creds = {os.path.basename(f)[:-5] for f in glob.glob(f"{CF_DIR}/*.json")}
    managed = load_state().get("cf_runs", {})
    procs = cf_processes()
    running_pids = {p["pid"] for p in procs}
    for t in tunnels:
        t["has_credentials"] = t["id"] in creds
        t["connections"] = len(t.get("connections") or [])
        run_info = managed.get(t["name"])
        t["managed_pid"] = run_info["pid"] if run_info and run_info["pid"] in running_pids else None
        t["in_config"] = bool(tunnel_id and tunnel_id[1] in (t["id"], t["name"]))
    return {"version": output([binary, "--version"]).split(" (")[0], "logged_in": logged_in,
            "config_file": cfg, "config_tunnel": tunnel_id[1] if tunnel_id else None,
            "ingress": parse_ingress(content), "tunnels": tunnels, "error": err, "processes": procs}


TUNNEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")
HOST_RE = re.compile(r"^(?=.{1,253}$)([A-Za-z0-9-]+\.)+[A-Za-z]{2,}$")
ORIGIN_RE = re.compile(r"^(https?|tcp|ssh|unix)://[A-Za-z0-9._:/-]+$|^http_status:\d{3}$")


def cf_action(body):
    binary = cf_bin()
    action = body.get("action")
    name = str(body.get("name", "")).strip()
    if action == "login":
        if os.path.isfile(f"{CF_DIR}/cert.pem"):
            if not body.get("relogin"):
                raise ApiError("Sudah login. Pakai 'Login ulang' untuk ganti akun/zone.")
            os.rename(f"{CF_DIR}/cert.pem", f"{CF_DIR}/cert.pem.bak-{time.strftime('%Y%m%d-%H%M%S')}")
        return {"job": start_job("cloudflared tunnel login", [binary, "tunnel", "login"], "cloudflared")}
    if action in ("create", "delete", "route", "run", "stop", "logs") and not TUNNEL_RE.match(name):
        raise ApiError("nama tunnel tidak valid")
    if action == "create":
        return {"job": start_job(f"tunnel create {name}", [binary, "tunnel", "create", name], "cloudflared")}
    if action == "delete":
        return {"job": start_job(f"tunnel delete {name}", [binary, "tunnel", "delete", "-f", name], "cloudflared")}
    if action == "route":
        host = str(body.get("hostname", "")).strip().lower()
        if not HOST_RE.match(host):
            raise ApiError("hostname tidak valid (contoh: app.domainmu.com)")
        return {"job": start_job(f"route dns {name} → {host}", [binary, "tunnel", "route", "dns", name, host], "cloudflared")}
    if action == "run":
        return cf_run(binary, name)
    if action == "stop":
        return cf_stop(name, body.get("pid"))
    if action == "logs":
        return {"log": tail(os.path.join(LOG_DIR, f"cloudflared-{name}.log"), 300) or "(belum ada log dari dashboard)"}
    if action == "add-ingress":
        return cf_add_ingress(body)
    raise ApiError("aksi tidak valid")


def cf_run(binary, name):
    """Jalankan tunnel di background (bukan lewat launchd), log ke ~/.service-admin/logs."""
    runs = load_state().get("cf_runs", {})
    if name in runs and any(p["pid"] == runs[name]["pid"] for p in cf_processes()):
        raise ApiError(f"Tunnel {name} sudah berjalan")
    os.makedirs(LOG_DIR, exist_ok=True)
    log = open(os.path.join(LOG_DIR, f"cloudflared-{name}.log"), "a")
    log.write(f"\n===== {time.strftime('%Y-%m-%d %H:%M:%S')} start {name} =====\n")
    log.flush()
    proc = subprocess.Popen([binary, "tunnel", "run", name], stdout=log, stderr=subprocess.STDOUT,
                            stdin=subprocess.DEVNULL, env=ENV, cwd=HOME, start_new_session=True)
    runs[name] = {"pid": proc.pid, "started": time.time()}
    save_state(cf_runs=runs)
    return {"ok": True, "pid": proc.pid}


def cf_stop(name, pid=None):
    """Hentikan tunnel yang dijalankan dashboard, atau PID cloudflared tertentu."""
    runs = load_state().get("cf_runs", {})
    target = int(pid) if pid else (runs.get(name) or {}).get("pid")
    if not target or target not in {p["pid"] for p in cf_processes()}:
        raise ApiError("Proses tunnel tidak ditemukan (mungkin sudah berhenti)", HTTPStatus.NOT_FOUND)
    os.kill(target, signal.SIGTERM)
    runs.pop(name, None)
    save_state(cf_runs=runs)
    return {"ok": True}


def cf_add_ingress(body):
    """Tambah aturan hostname -> service sebelum aturan catch-all di config.yml."""
    host = str(body.get("hostname", "")).strip().lower()
    origin = str(body.get("service", "")).strip()
    if not HOST_RE.match(host) or not ORIGIN_RE.match(origin):
        raise ApiError("hostname/service tidak valid (contoh: app.domain.com → http://localhost:8000)")
    cfg = cf_config_file()
    if not cfg:
        raise ApiError("config.yml belum ada di ~/.cloudflared")
    text = open(cfg).read()
    rule = f"  - hostname: {host}\n    service: {origin}\n\n"
    m = re.search(r"^(\s*)-\s*service:\s*http_status:\d+\s*$", text, re.M)
    if m:
        # sisipkan SEBELUM komentar yang menempel di atas aturan catch-all
        lines = text[:m.start()].split("\n")
        cut = len(lines) - 1
        while cut > 0 and lines[cut - 1].strip().startswith("#"):
            cut -= 1
        head, tail_part = "\n".join(lines[:cut]), "\n".join(lines[cut:]) + text[m.start():]
        text = head.rstrip("\n") + "\n\n" + rule + tail_part.lstrip("\n")
    elif re.search(r"^ingress:\s*$", text, re.M):
        text = re.sub(r"^ingress:\s*$", "ingress:\n" + rule.rstrip("\n"), text, count=1, flags=re.M)
    else:
        text = text.rstrip("\n") + "\n\ningress:\n" + rule + "  - service: http_status:404\n"
    return config_save({"name": "cloudflared", "path": cfg, "content": text})
