"""Tailscale: status koneksi & perangkat (peer), connect/disconnect, exit node,
pengaturan (`tailscale set`), Serve/Funnel untuk membagikan port lokal, ping,
netcheck, dan ganti akun. Memakai CLI dari Tailscale.app atau Homebrew."""
import json
import os
import re
import shutil
import subprocess
from http import HTTPStatus

from core import ApiError, output, run, start_job

CANDIDATES = ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale",
              "/usr/local/bin/tailscale"]
# pengaturan yang boleh diubah dari UI: flag `tailscale set` -> kunci di `debug prefs`
SETTINGS = {
    "accept-dns": ("CorpDNS", "Pakai DNS tailnet (MagicDNS)"),
    "accept-routes": ("RouteAll", "Terima subnet route dari perangkat lain"),
    "shields-up": ("ShieldsUp", "Shields up: tolak semua koneksi masuk"),
    "exit-node-allow-lan-access": ("ExitNodeAllowLANAccess", "Tetap bisa akses LAN saat memakai exit node"),
    "advertise-exit-node": (None, "Jadikan Mac ini exit node"),
    "ssh": ("RunSSH", "Tailscale SSH server"),
    "auto-update": (None, "Update Tailscale otomatis"),
}
ACCOUNT_RE = re.compile(r"^[0-9a-f]{1,16}$")


def binary():
    for p in CANDIDATES:
        if os.path.exists(p):
            return p
    return shutil.which("tailscale")


def ts(*args, timeout=20):
    tsb = binary()
    if not tsb:
        raise ApiError("Tailscale belum terinstall", HTTPStatus.NOT_FOUND)
    try:
        return run([tsb, *args], timeout=timeout)
    except subprocess.TimeoutExpired:
        raise ApiError(f"tailscale {args[0]} timeout", HTTPStatus.GATEWAY_TIMEOUT) from None


def ts_json(*args):
    code, out, err = ts(*args)
    try:
        return json.loads(out)
    except ValueError:
        if code != 0:
            raise ApiError((err or out).strip() or f"tailscale {args[0]} gagal", HTTPStatus.BAD_GATEWAY) from None
        return {}


def _peer(p, users):
    return {
        "id": p.get("ID"), "name": p.get("HostName"), "dns": (p.get("DNSName") or "").rstrip("."),
        "os": p.get("OS"), "ips": p.get("TailscaleIPs") or [], "online": bool(p.get("Online")),
        "active": bool(p.get("Active")), "last_seen": p.get("LastSeen"),
        "direct": p.get("CurAddr") or None, "relay": p.get("Relay") or None,
        "rx": p.get("RxBytes", 0), "tx": p.get("TxBytes", 0),
        "exit_node": bool(p.get("ExitNode")), "exit_option": bool(p.get("ExitNodeOption")),
        "tags": p.get("Tags") or [], "ssh": bool(p.get("sshHostKeys")),
        "user": (users.get(str(p.get("UserID"))) or {}).get("LoginName"),
        "key_expiry": p.get("KeyExpiry"), "self": False,
    }


def _serve():
    """Konfigurasi Serve/Funnel sebagai daftar {host, port, path, target, funnel}."""
    try:
        cfg = ts_json("serve", "status", "--json")
    except ApiError:
        return []
    funnel = cfg.get("AllowFunnel") or {}
    items = []
    for hostport, web in (cfg.get("Web") or {}).items():
        port = hostport.rsplit(":", 1)[-1]
        for path, h in (web.get("Handlers") or {}).items():
            items.append({"host": hostport.rsplit(":", 1)[0], "port": int(port), "path": path,
                          "target": h.get("Proxy") or h.get("Path") or h.get("Text") or "",
                          "funnel": bool(funnel.get(hostport))})
    for port, t in (cfg.get("TCP") or {}).items():
        if t.get("TCPForward"):
            items.append({"host": "", "port": int(port), "path": "", "target": "tcp://" + t["TCPForward"], "funnel": False})
    return items


def _accounts():
    code, out, _ = ts("switch", "--list")
    accounts = []
    for line in out.splitlines()[1:] if code == 0 else []:
        cols = line.split()
        if len(cols) >= 3:
            accounts.append({"id": cols[0], "tailnet": cols[1], "account": cols[2].rstrip("*"),
                             "current": cols[2].endswith("*")})
    return accounts


def info(q):
    tsb = binary()
    if not tsb:
        return {"installed": False}
    st = ts_json("status", "--json")
    prefs = ts_json("debug", "prefs")
    users = st.get("User") or {}
    me = st.get("Self") or {}
    self_peer = _peer(me, users) | {"self": True}
    peers = sorted((_peer(p, users) for p in (st.get("Peer") or {}).values()),
                   key=lambda p: (not p["online"], (p["name"] or "").lower()))
    profile = (prefs.get("Config") or {}).get("UserProfile") or {}
    running = st.get("BackendState") == "Running"
    return {
        "installed": True, "binary": tsb, "app": tsb.startswith("/Applications"),
        "version": (st.get("Version") or "").split("-")[0],
        "state": st.get("BackendState"), "auth_url": st.get("AuthURL") or None,
        "health": st.get("Health") or [], "tailnet": st.get("CurrentTailnet") or {},
        "magic_suffix": st.get("MagicDNSSuffix"), "self": self_peer,
        "user": {"login": profile.get("LoginName"), "name": profile.get("DisplayName")},
        "peers": peers,
        # hanya preferensi yang aman ditampilkan (debug prefs juga berisi kunci privat yang dikosongkan)
        "prefs": {flag: prefs.get(key) for flag, (key, _) in SETTINGS.items() if key}
                 | {"advertise-exit-node": "0.0.0.0/0" in (prefs.get("AdvertiseRoutes") or []),
                    "auto-update": bool((prefs.get("AutoUpdate") or {}).get("Apply"))},
        "settings": {k: v[1] for k, v in SETTINGS.items()},
        "exit_node": next((p for p in peers if p["exit_node"]), None),
        "serve": _serve() if running else [],
        "accounts": _accounts(),
    }


def _peer_ip(ip, need_exit=False):
    st = ts_json("status", "--json")
    for p in (st.get("Peer") or {}).values():
        if ip in (p.get("TailscaleIPs") or []) and (p.get("ExitNodeOption") or not need_exit):
            return ip
    raise ApiError("perangkat tidak ditemukan di tailnet" + (" atau bukan exit node" if need_exit else ""))


def _ok(code, out, err, fallback):
    if code != 0:
        raise ApiError((err or out).strip() or fallback, HTTPStatus.BAD_GATEWAY)
    return {"ok": True, "output": (out + err).strip()}


def action(body):
    act = body.get("action")
    tsb = binary()
    if not tsb:
        raise ApiError("Tailscale belum terinstall", HTTPStatus.NOT_FOUND)
    if act == "open-app":
        run(["open", "-a", "Tailscale"], timeout=10)
        return {"ok": True}
    if act == "up":
        # bisa butuh login: URL login muncul di output job & di status (AuthURL)
        return {"job": start_job("tailscale up", [tsb, "up"], "tailscale")}
    if act == "down":
        return _ok(*ts("down"), "gagal memutus Tailscale")
    if act == "set":
        flag, value = str(body.get("flag", "")), body.get("value")
        if flag not in SETTINGS or not isinstance(value, bool):
            raise ApiError("pengaturan tidak dikenal")
        return _ok(*ts("set", f"--{flag}={'true' if value else 'false'}"), "tailscale set gagal")
    if act == "exit-node":
        ip = str(body.get("ip", ""))
        return _ok(*ts("set", f"--exit-node={_peer_ip(ip, True) if ip else ''}"), "gagal mengatur exit node")
    if act == "ping":
        ip = _peer_ip(str(body.get("ip", "")))
        return {"job": start_job(f"tailscale ping {ip}", [tsb, "ping", "--c=5", ip], "tailscale-ping")}
    if act == "netcheck":
        return {"job": start_job("tailscale netcheck", [tsb, "netcheck"], "tailscale-netcheck")}
    if act in ("serve", "funnel"):
        try:
            port, https = int(body.get("port")), int(body.get("https") or 443)
        except (TypeError, ValueError):
            raise ApiError("port harus angka") from None
        if not (1 <= port <= 65535) or https not in (443, 8443, 10000):
            raise ApiError("port tidak valid (HTTPS publik hanya 443, 8443, atau 10000)")
        return _ok(*ts(act, "--bg", f"--https={https}", str(port), timeout=30), f"tailscale {act} gagal")
    if act == "serve-off":
        try:
            https = int(body.get("https"))
        except (TypeError, ValueError):
            raise ApiError("port tidak valid") from None
        cmd = "funnel" if body.get("funnel") else "serve"
        return _ok(*ts(cmd, f"--https={https}", "off", timeout=30), "gagal mematikan serve")
    if act == "serve-reset":
        return _ok(*ts("serve", "reset", timeout=30), "gagal reset serve")
    if act == "switch":
        acc = str(body.get("id", ""))
        if not ACCOUNT_RE.match(acc) or acc not in {a["id"] for a in _accounts()}:
            raise ApiError("akun tidak dikenal")
        return _ok(*ts("switch", acc, timeout=30), "gagal ganti akun")
    raise ApiError("aksi tidak valid")


def nav_status():
    """Status singkat untuk sidebar (tanpa memanggil CLI berat)."""
    if not binary():
        return None
    try:
        return json.loads(output([binary(), "status", "--json", "--peers=false"], timeout=5) or "{}").get("BackendState")
    except ValueError:
        return None
