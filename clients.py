"""Catatan client pembuatan web: kontak, web, tanggal, status, dan nilai proyek.
Berisi data pribadi client, disimpan 0600 di ~/.service-admin/clients.json."""
import json
import os
import re
import threading
import uuid
from datetime import date
from http import HTTPStatus
from urllib.parse import urlparse

from core import DATA_DIR, ApiError, write_json_versioned

FILE = os.path.join(DATA_DIR, "clients.json")
LOCK = threading.Lock()
STATUSES = ("prospek", "berjalan", "maintenance", "selesai", "batal")
CURRENCIES = ("IDR", "USD")
ID_RE = re.compile(r"^[0-9a-f]{12}$")
PHONE_RE = re.compile(r"^\+?[0-9][0-9 ()-]{5,24}$")
EMAIL_RE = re.compile(r"^[^\s@\"'<>]+@[^\s@\"'<>]+\.[^\s@\"'<>]+$")
URL_RE = re.compile(r"^https?://[^\s\"'<>]+$")
LIMITS = {"name": 200, "company": 200, "project": 200, "notes": 4000}


def _load():
    try:
        with open(FILE) as f:
            return json.load(f)["clients"]
    except FileNotFoundError:
        return []
    except (OSError, ValueError, KeyError, TypeError) as e:
        # jangan anggap kosong: simpan berikutnya akan menimpa catatan user
        raise ApiError(f"clients.json tidak terbaca: {e}", HTTPStatus.INTERNAL_SERVER_ERROR) from None


def _date(value, label):
    value = str(value or "").strip()
    if not value:
        return ""
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise ApiError(f"{label} harus berformat YYYY-MM-DD")
    try:
        date.fromisoformat(value)
    except ValueError:
        raise ApiError(f"{label} tidak valid") from None
    return value


def _clean(body):
    rec = {}
    for key, limit in LIMITS.items():
        value = str(body.get(key) or "").strip()
        if len(value) > limit:
            raise ApiError(f"Isian {key} terlalu panjang (maks {limit})")
        rec[key] = value
    if not rec["name"]:
        raise ApiError("Nama client wajib diisi")
    phone = str(body.get("phone") or "").strip()
    if phone and not PHONE_RE.match(phone):
        raise ApiError("Nomor HP tidak valid (contoh: 081234567890 atau +62 812 3456 7890)")
    email = str(body.get("email") or "").strip()
    if email and (len(email) > 200 or not EMAIL_RE.match(email)):
        raise ApiError("Email tidak valid")
    web = str(body.get("web") or "").strip()
    if web and "://" not in web:
        web = "https://" + web
    if web and (len(web) > 500 or not URL_RE.match(web)):  # dipakai sebagai href di UI
        raise ApiError("Alamat web tidak valid (contoh: example.com)")
    try:
        urlparse(web).port  # noqa: B018  melempar ValueError kalau port tidak valid
    except ValueError:
        raise ApiError("Alamat web tidak valid (contoh: example.com)") from None
    rec.update(phone=phone, email=email, web=web)
    rec["status"] = body.get("status")
    if rec["status"] not in STATUSES:
        raise ApiError("Status tidak valid")
    rec["start"] = _date(body.get("start"), "Tanggal mulai")
    rec["end"] = _date(body.get("end"), "Tanggal selesai")
    if rec["start"] and rec["end"] and rec["end"] < rec["start"]:
        raise ApiError("Tanggal selesai tidak boleh sebelum tanggal mulai")
    price = body.get("price")
    if price in (None, ""):
        rec["price"] = None
    else:
        try:
            rec["price"] = float(price)
        except (TypeError, ValueError):
            raise ApiError("Nilai proyek harus berupa angka") from None
        if not 0 <= rec["price"] < 1e15:
            raise ApiError("Nilai proyek tidak valid")
    rec["currency"] = body.get("currency") if body.get("currency") in CURRENCIES else "IDR"
    return rec


def info(q=None):
    items = _load()
    totals = {}
    for c in items:
        if c.get("price") and c.get("status") != "batal":
            totals[c["currency"]] = totals.get(c["currency"], 0) + c["price"]
    return {"clients": items, "totals": totals, "statuses": STATUSES}


def action(body):
    act = body.get("action")
    cid = str(body.get("id") or "")
    if cid and not ID_RE.match(cid):
        raise ApiError("id client tidak valid")
    with LOCK:
        items = _load()
        found = next((c for c in items if c["id"] == cid), None)
        if cid and not found:
            raise ApiError("Client tidak ditemukan", HTTPStatus.NOT_FOUND)
        if act == "save":
            rec = _clean(body)
            if found:
                found.update(rec)
            else:
                items.append({"id": uuid.uuid4().hex[:12], **rec})
        elif act == "delete" and found:
            items.remove(found)
        else:
            raise ApiError("Aksi tidak dikenal")
        write_json_versioned(FILE, {"clients": items})
    return {"ok": True}
