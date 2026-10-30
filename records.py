"""Catatan domain, server & subscription (AWS, Supabase, ...): lokasi (registrar/hosting), harga, tanggal register,
jatuh tempo, dan reminder perpanjangan. Disimpan di ~/.service-admin/records.json."""
import calendar
import json
import os
import re
import threading
import uuid
from datetime import date
from http import HTTPStatus

from core import DATA_DIR, ApiError, write_json, write_json_versioned

FILE = os.path.join(DATA_DIR, "records.json")
LOCK = threading.Lock()
KINDS = ("domain", "server", "subscription")
KIND_LABELS = {"domain": "domain", "server": "server", "subscription": "subscription"}
CURRENCIES = ("IDR", "USD")
CYCLES = (0, 1, 3, 6, 12, 24, 36)  # bulan; 0 = sekali bayar
LEVELS = (30, 14, 7, 3, 1, 0, -1)  # hari sebelum jatuh tempo; -1 = sudah lewat
DUE_DAYS = 30
ID_RE = re.compile(r"^[0-9a-f]{12}$")
DOMAIN_RE = re.compile(r"^[^\s/@:]+\.[^\s/@:]+$")
LIMITS = {"name": 200, "provider": 200, "account": 200, "address": 500, "notes": 4000}


def _load():
    try:
        with open(FILE) as f:
            return json.load(f)["records"]
    except FileNotFoundError:
        return []
    except (OSError, ValueError, KeyError, TypeError) as e:
        # jangan anggap kosong: simpan berikutnya akan menimpa catatan user
        raise ApiError(f"records.json tidak terbaca: {e}", HTTPStatus.INTERNAL_SERVER_ERROR) from None


def _save(items, keep_backup=True):
    (write_json_versioned if keep_backup else write_json)(FILE, {"records": items})


def add_months(d, n):
    y, m = divmod(d.year * 12 + d.month - 1 + n, 12)
    return date(y, m + 1, min(d.day, calendar.monthrange(y, m + 1)[1]))


def _date(value, label):
    value = str(value or "").strip()
    if not value:
        return ""
    try:
        date.fromisoformat(value)
    except ValueError:
        raise ApiError(f"{label} tidak valid") from None
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise ApiError(f"{label} harus berformat YYYY-MM-DD")
    return value


def _clean(body):
    kind = body.get("kind")
    if kind not in KINDS:
        raise ApiError("Jenis catatan tidak valid")
    rec = {"kind": kind}
    for key, limit in LIMITS.items():
        value = str(body.get(key) or "").strip()
        if len(value) > limit:
            raise ApiError(f"Isian {key} terlalu panjang (maks {limit})")
        rec[key] = value
    if not rec["name"]:
        raise ApiError("Nama wajib diisi")
    if kind == "domain":
        rec["name"] = rec["name"].lower()
        if not DOMAIN_RE.match(rec["name"]):
            raise ApiError("Nama domain tidak valid (contoh: example.com, tanpa https://)")
    price = body.get("price")
    if price in (None, ""):
        rec["price"] = None
    else:
        try:
            rec["price"] = float(price)
        except (TypeError, ValueError):
            raise ApiError("Harga harus berupa angka") from None
        if not 0 <= rec["price"] < 1e15:
            raise ApiError("Harga tidak valid")
    rec["currency"] = body.get("currency") if body.get("currency") in CURRENCIES else "IDR"
    try:
        rec["cycle"] = int(body.get("cycle", 12))
    except (TypeError, ValueError):
        rec["cycle"] = -1
    if rec["cycle"] not in CYCLES:
        raise ApiError("Siklus tagihan tidak valid")
    rec["registered"] = _date(body.get("registered"), "Tanggal register")
    rec["expires"] = _date(body.get("expires"), "Tanggal jatuh tempo")
    if rec["registered"] and rec["expires"] and rec["expires"] < rec["registered"]:
        raise ApiError("Jatuh tempo tidak boleh sebelum tanggal register")
    rec["auto_renew"] = bool(body.get("auto_renew"))
    return rec


def days_left(rec, today=None):
    return (date.fromisoformat(rec["expires"]) - (today or date.today())).days if rec.get("expires") else None


def info(q=None):
    items = _load()
    totals = {}
    for r in items:
        r["days_left"] = days_left(r)
        if r.get("price") and r.get("cycle"):
            totals[r["currency"]] = totals.get(r["currency"], 0) + r["price"] * 12 / r["cycle"]
    return {"records": items, "yearly": totals, "due_days": DUE_DAYS}


def due_count():
    try:
        return sum(1 for r in _load() if r.get("expires") and days_left(r) <= DUE_DAYS)
    except ApiError:
        return 0


def action(body):
    act = body.get("action")
    rec_id = str(body.get("id") or "")
    if rec_id and not ID_RE.match(rec_id):
        raise ApiError("id catatan tidak valid")
    with LOCK:
        items = _load()
        found = next((r for r in items if r["id"] == rec_id), None)
        if act == "save":
            rec = _clean(body)
            if rec_id:
                if not found:
                    raise ApiError("Catatan tidak ditemukan", HTTPStatus.NOT_FOUND)
                found.update(rec)
            else:
                items.append({"id": uuid.uuid4().hex[:12], **rec})
        elif act in ("delete", "renew"):
            if not found:
                raise ApiError("Catatan tidak ditemukan", HTTPStatus.NOT_FOUND)
            if act == "delete":
                items.remove(found)
            else:
                if not found.get("expires") or not found.get("cycle"):
                    raise ApiError("Perlu tanggal jatuh tempo dan siklus tagihan berulang")
                found["expires"] = add_months(date.fromisoformat(found["expires"]), found["cycle"]).isoformat()
        else:
            raise ApiError("Aksi tidak dikenal")
        _save(items)
    return {"ok": True}


def _message(rec, left):
    when = (f"sudah lewat {-left} hari" if left < 0 else "jatuh tempo hari ini" if left == 0
            else f"jatuh tempo {left} hari lagi")
    extra = " · auto-renew aktif, pastikan pembayaran lancar" if rec.get("auto_renew") else ""
    where = f" di {rec['provider']}" if rec.get("provider") else ""
    return f"{rec['name']}{where} {when} ({rec['expires']}){extra}"


def check_reminders(send, today=None):
    """Kirim satu reminder tiap kali melewati ambang LEVELS. Kalau Mac mati saat ambang
    terlewat, hanya ambang terdekat yang dikirim. Mengubah tanggal jatuh tempo mereset reminder."""
    pending = []
    with LOCK:
        items = _load()
        for rec in items:
            left = days_left(rec, today)
            if left is None or left > LEVELS[0]:
                continue
            level = min(x for x in LEVELS if left <= x)
            sent = rec.get("reminded") or {}
            if sent.get("expires") == rec["expires"] and sent.get("level", 99) <= level:
                continue
            rec["reminded"] = {"expires": rec["expires"], "level": level}
            pending.append((rec, left))
        if pending:
            _save(items, keep_backup=False)
    for rec, left in pending:
        send(f"Reminder {KIND_LABELS[rec['kind']]}", _message(rec, left))
    return len(pending)
