"""Helper bersama: menjalankan perintah, job background, state, dan
pengelolaan ~/.zshrc + shim runtime (~/.service-admin/bin)."""
import itertools
import json
import os
import re
import shlex
import shutil
import subprocess
import threading
import time
from collections import deque
from http import HTTPStatus

HOME = os.path.expanduser("~")
DATA_DIR = os.path.join(HOME, ".service-admin")
SHIM_DIR = os.path.join(DATA_DIR, "bin")
ENV_FILE = os.path.join(DATA_DIR, "env.zsh")
BACKUP_DIR = os.path.join(DATA_DIR, "backups")
STATE_FILE = os.path.join(DATA_DIR, "state.json")

BREW = shutil.which("brew") or "/opt/homebrew/bin/brew"
BREW_PREFIX = os.path.dirname(os.path.dirname(os.path.realpath(BREW)))
PKG_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9@._+/-]*$")

ZSH_FILES = [".zshrc", ".zprofile", ".zshenv", ".zlogin"]
ZSHRC_BLOCK_START = "# >>> mac-service-admin >>>"
ZSHRC_BLOCK = (f"{ZSHRC_BLOCK_START}\n"
               "# Versi runtime yang dipilih lewat Service Admin (PHP, Python, Java, ...)\n"
               'export PATH="$HOME/.service-admin/bin:$PATH"\n'
               '[ -f "$HOME/.service-admin/env.zsh" ] && source "$HOME/.service-admin/env.zsh"\n'
               "# <<< mac-service-admin <<<\n")

ENV = dict(os.environ, HOMEBREW_NO_ENV_HINTS="1", NONINTERACTIVE="1",
           PATH=f"{BREW_PREFIX}/bin:{BREW_PREFIX}/sbin:" + os.environ.get("PATH", "/usr/bin:/bin"))


class ApiError(Exception):
    def __init__(self, msg, status=HTTPStatus.BAD_REQUEST):
        super().__init__(msg)
        self.status = status


def run(cmd, timeout=60, cwd=None, env=None):
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout,
                          env=env or ENV, stdin=subprocess.DEVNULL, cwd=cwd)
    return proc.returncode, proc.stdout, proc.stderr


def output(cmd, timeout=20, **kw):
    """stdout+stderr sebuah perintah, atau "" kalau gagal dijalankan."""
    try:
        _, out, err = run(cmd, timeout=timeout, **kw)
        return (out + err).strip()
    except (OSError, subprocess.TimeoutExpired):
        return ""


def tail(path, lines=200):
    if not path or not os.path.isfile(path):
        return None
    with open(path, "r", errors="replace") as f:
        return "".join(deque(f, maxlen=lines))


def load_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_state(**changes):
    os.makedirs(DATA_DIR, exist_ok=True)
    state = {**load_state(), **changes}
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)


# ---------------------------------------------------------------- jobs
# Perintah lama (brew install, nvm install, ...) berjalan di background;
# UI mem-poll outputnya.

JOBS = {}
JOB_IDS = itertools.count(1)
JOB_LOCK = threading.Lock()


def start_job(label, cmd, kind, cwd=None, env=None, exclusive=True):
    with JOB_LOCK:
        if exclusive and any(j["kind"] == kind and not j["done"] for j in JOBS.values()):
            raise ApiError(f"Masih ada proses {kind} yang berjalan, tunggu sampai selesai.",
                           HTTPStatus.CONFLICT)
        job_id = str(next(JOB_IDS))
        job = JOBS[job_id] = {"id": job_id, "label": label, "kind": kind, "lines": [],
                              "done": False, "code": None, "started": time.time()}

    def worker():
        try:
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, cwd=cwd,
                                    stdin=subprocess.DEVNULL, text=True, env=env or ENV, bufsize=1,
                                    start_new_session=True)  # grup proses sendiri -> bisa dihentikan semua
            job["_proc"] = proc
            for line in proc.stdout:
                if line.startswith("__SA_PWD__"):  # folder kerja terakhir dari perintah shell
                    job["pwd"] = line[10:].strip()
                    if job["lines"] and job["lines"][-1] == "":
                        job["lines"].pop()  # baris kosong sebelum penanda
                    continue
                job["lines"].append(line.rstrip("\n"))
                del job["lines"][:-5000]
            job["code"] = proc.wait()
            if job.get("cancelled"):
                job["code"] = 143  # 128 + SIGTERM, walau trap EXIT di shell keluar dengan 0
                job["lines"].append("⏹  Dihentikan.")
        except Exception as e:  # noqa: BLE001
            job["lines"].append(f"ERROR: {e}")
            job["code"] = -1
        job["done"] = True

    threading.Thread(target=worker, daemon=True).start()
    return job_id


def start_steps(label, steps, kind):
    """Job berisi beberapa langkah berurutan; berhenti di langkah pertama yang gagal.
    steps: [(judul, cmd_list | callable(log) , {"cwd":..., "env":..., "optional": bool})]"""
    with JOB_LOCK:
        if any(j["kind"] == kind and not j["done"] for j in JOBS.values()):
            raise ApiError(f"Masih ada proses {kind} yang berjalan, tunggu sampai selesai.", HTTPStatus.CONFLICT)
        job_id = str(next(JOB_IDS))
        job = JOBS[job_id] = {"id": job_id, "label": label, "kind": kind, "lines": [],
                              "done": False, "code": None, "started": time.time()}

    def log(line):
        job["lines"].append(line)
        del job["lines"][:-5000]

    def worker():
        code = 0
        for i, (title, cmd, opt) in enumerate(steps, 1):
            log(f"\n▶ [{i}/{len(steps)}] {title}")
            try:
                if callable(cmd):
                    cmd(log)
                    rc = 0
                else:
                    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
                                            stdin=subprocess.DEVNULL, cwd=opt.get("cwd"), env=opt.get("env") or ENV)
                    for line in proc.stdout:
                        log(line.rstrip("\n"))
                    rc = proc.wait()
            except Exception as e:  # noqa: BLE001
                log(f"ERROR: {e}")
                rc = -1
            if rc != 0:
                if opt.get("optional"):
                    log(f"⚠️  Langkah ini gagal (exit {rc}), dilewati.")
                    continue
                log(f"❌ Gagal di langkah {i} (exit {rc}).")
                code = rc
                break
        else:
            log("\n✅ Selesai.")
        job["code"] = code
        job["done"] = True

    threading.Thread(target=worker, daemon=True).start()
    return job_id


def list_jobs(q=None):
    """Proses terbaru (untuk tombol terminal di header)."""
    jobs = sorted(JOBS.values(), key=lambda j: -j["started"])[:30]
    return {"jobs": [{k: v for k, v in j.items() if k != "lines" and not k.startswith("_")} | {"lines_count": len(j["lines"])}
                     for j in jobs]}


def cancel_job(body):
    """Hentikan job (SIGTERM ke seluruh grup prosesnya, SIGKILL kalau bandel)."""
    import signal
    job = JOBS.get(str(body.get("id", "")))
    if not job:
        raise ApiError("job tidak ditemukan", HTTPStatus.NOT_FOUND)
    proc = job.get("_proc")
    if job["done"] or not proc:
        return {"ok": True}
    job["cancelled"] = True
    try:
        os.killpg(proc.pid, signal.SIGTERM)
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    return {"ok": True}


def get_job(job_id, offset):
    job = JOBS.get(job_id)
    if not job:
        raise ApiError("job tidak ditemukan", HTTPStatus.NOT_FOUND)
    return {**{k: v for k, v in job.items() if k != "lines" and not k.startswith("_")},
            "lines": job["lines"][offset:], "offset": len(job["lines"])}


# ---------------------------------------------------------------- file zsh

def check_zsh_file(name):
    if name not in ZSH_FILES:
        raise ApiError("file tidak diizinkan")
    return os.path.join(HOME, name)


def read_home(name):
    try:
        with open(check_zsh_file(name), errors="replace") as f:
            return f.read()
    except FileNotFoundError:
        return ""


def list_backups(name):
    if not os.path.isdir(BACKUP_DIR):
        return []
    return sorted((f for f in os.listdir(BACKUP_DIR)
                   if re.fullmatch(re.escape(name) + r"\.\d{8}-\d{6}", f)), reverse=True)


def backup(name):
    path = check_zsh_file(name)
    if not os.path.isfile(path):
        return None
    os.makedirs(BACKUP_DIR, exist_ok=True)
    dest = os.path.join(BACKUP_DIR, f"{name}.{time.strftime('%Y%m%d-%H%M%S')}")
    if os.path.exists(dest):  # dua kali simpan di detik yang sama: pertahankan versi tertua
        return os.path.basename(dest)
    shutil.copy2(path, dest)
    for old in list_backups(name)[20:]:  # simpan 20 terakhir
        os.remove(os.path.join(BACKUP_DIR, old))
    return os.path.basename(dest)


def ensure_zshrc_block():
    """Pastikan blok Service Admin ada di PALING BAWAH .zshrc supaya
    menang dari baris PATH lain (mis. yang disuntik Herd)."""
    path = os.path.join(HOME, ".zshrc")
    content = read_home(".zshrc")
    stripped = re.sub(r"\n*# >>> mac-service-admin >>>.*?# <<< mac-service-admin <<<\n?", "\n",
                      content, flags=re.S).rstrip("\n")
    new = stripped + "\n\n" + ZSHRC_BLOCK
    if new != content:
        backup(".zshrc")
        with open(path, "w") as f:
            f.write(new)


# ---------------------------------------------------------------- shim & env per bahasa

def set_shims(lang, mapping):
    """Ganti symlink milik `lang` di ~/.service-admin/bin dengan {nama: target}.
    mapping kosong = hapus override bahasa itu."""
    os.makedirs(SHIM_DIR, exist_ok=True)
    state = load_state()
    shims = state.get("shims")
    if shims is None:  # versi lama: semua symlink milik PHP
        shims = {"php": [f for f in os.listdir(SHIM_DIR) if os.path.islink(os.path.join(SHIM_DIR, f))]}
    for name in shims.get(lang, []):
        p = os.path.join(SHIM_DIR, name)
        if os.path.islink(p):
            os.unlink(p)
    for other, names in shims.items():  # nama yang direbut bahasa lain
        if other != lang:
            shims[other] = [n for n in names if n not in mapping]
    for name, target in mapping.items():
        p = os.path.join(SHIM_DIR, name)
        if os.path.islink(p):
            os.unlink(p)
        os.symlink(target, p)
    shims[lang] = sorted(mapping)
    save_state(shims=shims)
    if mapping:
        ensure_zshrc_block()


def set_env(lang, variables):
    """Simpan variabel environment milik `lang` (mis. JAVA_HOME) ke env.zsh."""
    state = load_state()
    env = state.get("env", {})
    if variables:
        env[lang] = variables
    else:
        env.pop(lang, None)
    save_state(env=env)
    os.makedirs(DATA_DIR, exist_ok=True)
    lines = ["# Dibuat otomatis oleh Service Admin — jangan diedit manual"]
    for group in env.values():
        lines += [f"export {k}={shlex.quote(v)}" for k, v in group.items()]
    with open(ENV_FILE, "w") as f:
        f.write("\n".join(lines) + "\n")
    ensure_zshrc_block()


def shell_probe(names):
    """Path + nilai yang dipakai terminal baru (zsh interaktif) untuk tiap
    perintah, mis. {"python3": "/opt/.../python3"}. Juga env JAVA_HOME dll."""
    script = "; ".join(f'echo "__{n}__$(command -v {shlex.quote(n)})"' for n in names)
    script += '; echo "__ENV_JAVA_HOME__${JAVA_HOME}"'
    try:
        _, out, _ = run(["zsh", "-i", "-c", script], timeout=20)
    except subprocess.TimeoutExpired:
        return {}
    result = {}
    for line in out.splitlines():
        m = re.match(r"__(.+?)__(.*)", line)
        if m:
            result[m[1]] = m[2].strip()
    return result
