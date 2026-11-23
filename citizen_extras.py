"""Citizen sign-up with a phone code, profile photo and the full application form (stdlib only).

server.py forwards the routes below here. Every function receives the server module as `srv`,
so this file never imports server.py (no circular import).

Routes:
  POST /api/register/code    - checks NID, name and phone; sends or shows a 6-digit code
  POST /api/register/verify  - checks the code and creates the account
  GET  /api/me/photo         - the logged-in citizen's profile photo (data URL or null)
  POST /api/me/photo         - saves a JPEG or PNG photo (max 2 MB); {"remove": true} deletes it
"""
import base64
import binascii
import json
import re
import secrets
import sqlite3
from datetime import date, datetime

import sms_gateway

PHOTO_MAX_BYTES = 2 * 1024 * 1024
PHOTO_BODY_MAX = 3 * 1024 * 1024        # base64 makes the upload about a third bigger
GENDERS = ("Male", "Female", "Other")

# every text field of the application form that is stored (service-specific ones stay empty otherwise)
APPLICATION_TEXT_KEYS = [
    "father_name", "mother_name", "date_of_birth", "gender", "phone", "email", "permanent_address",
    "birth_place", "ward_no", "business_name", "business_address", "trade_type", "purpose",
]

# columns added on start-up, so databases from earlier versions are upgraded in place
COLUMNS = [("authorized_users", "photo_data", "BLOB"),
           ("authorized_users", "photo_type", "TEXT NOT NULL DEFAULT ''"),
           # new sign-ups wait for an administrator; accounts that already exist stay approved
           ("authorized_users", "approval", "TEXT NOT NULL DEFAULT 'approved'"),
           ("authorized_users", "email", "TEXT NOT NULL DEFAULT ''"),
           ("applications", "photo_data", "BLOB"),
           ("applications", "photo_type", "TEXT NOT NULL DEFAULT ''")]
COLUMNS += [("applications", key, "TEXT NOT NULL DEFAULT ''") for key in APPLICATION_TEXT_KEYS]

TEXT_RULES = {
    "father_name": (3, 100, "Enter the father's full name."),
    "mother_name": (3, 100, "Enter the mother's full name."),
    "permanent_address": (5, 200, "Enter the permanent address (5 to 200 characters)."),
}
# extra required fields for each service (the others are not asked for)
SERVICE_RULES = {
    "Birth Certificate": {"birth_place": (3, 120, "Enter the place of birth.")},
    "Citizenship Certificate": {"ward_no": (1, 20, "Enter your ward number.")},
    "Trade Licence": {
        "business_name": (3, 120, "Enter the business name."),
        "business_address": (5, 200, "Enter the business address."),
        "trade_type": (3, 100, "Enter the type of trade."),
    },
    "Other Certificate": {"purpose": (5, 200, "Describe the purpose of this certificate.")},
}
DETAIL_LABELS = [
    ("father_name", "Father's name"), ("mother_name", "Mother's name"), ("date_of_birth", "Date of birth"),
    ("gender", "Gender"), ("phone", "Mobile"), ("email", "Email"), ("permanent_address", "Permanent address"),
    ("birth_place", "Place of birth"), ("ward_no", "Ward number"), ("business_name", "Business name"),
    ("business_address", "Business address"), ("trade_type", "Trade type"), ("purpose", "Purpose"),
]
PHONE_RE = re.compile(r"01[3-9][0-9]{8}")
EMAIL_RE = re.compile(r"[^@\s]+@[^@\s]+\.[^@\s]+")


def ensure_schema(conn):
    sms_gateway.ensure_schema(conn)
    for table, column, definition in COLUMNS:
        names = [row[1] for row in conn.execute("PRAGMA table_info(%s)" % table).fetchall()]
        if column not in names:
            conn.execute("ALTER TABLE %s ADD COLUMN %s %s" % (table, column, definition))


APPROVAL_MESSAGE = "Registration received. An administrator must approve your account before you can log in."


def handle(srv, handler, method, path):
    if path == "/api/me/photo":
        return photo(srv, handler, method)
    if path == "/api/me/profile":
        return profile(srv, handler, method)
    if method != "POST":
        raise srv.ApiError(405, "Method not allowed.")
    if path == "/api/register/code":
        return request_code(srv, handler)
    if path == "/api/register/verify":
        return verify(srv, handler)
    raise srv.ApiError(404, "Not found.")


def read_json(srv, handler, limit):
    """Like the server's own reader, with a size limit chosen by the caller (photos need more room)."""
    if not handler.headers.get("Content-Type", "").lower().startswith("application/json"):
        raise srv.ApiError(415, "Content-Type must be application/json.")
    try:
        length = int(handler.headers.get("Content-Length", "0"))
    except ValueError:
        raise srv.ApiError(400, "Bad Content-Length.")
    if length <= 0:
        raise srv.ApiError(400, "Empty request.")
    if length > limit:
        raise srv.ApiError(413, "Request is too large.")
    try:
        data = json.loads(handler.rfile.read(length).decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise srv.ApiError(400, "Invalid JSON.")
    if not isinstance(data, dict):
        raise srv.ApiError(400, "A JSON object is expected.")
    return data


# ---------- sign-up with a phone code ----------

def registry_record(srv, clean):
    """The demo NID record, but only if the NID, full name and phone all match it."""
    conn = srv.connect()
    try:
        record = conn.execute(
            "SELECT nid_number, full_name, phone_number, address FROM nid_registry WHERE nid_number = ?",
            (clean["nid"],)).fetchone()
    finally:
        conn.close()
    matches = (record is not None
               and srv.normalize_name(record["full_name"]) == srv.normalize_name(clean["name"])
               and srv.normalize_phone(record["phone_number"]) == clean["phone"])
    if not matches:
        # one generic message: do not reveal which field was wrong
        raise srv.ApiError(400, "Registration failed: the NID, full name and phone number do not match the demo NID database.")
    return dict(record)


def create_account(srv, nid, full_name, phone, address, salt, digest):
    conn = srv.connect()
    try:
        with conn:
            if conn.execute("SELECT 1 FROM authorized_users WHERE nid_number = ?", (nid,)).fetchone():
                raise srv.ApiError(409, "An account already exists for this NID. Please log in.")
            conn.execute(
                "INSERT INTO authorized_users (full_name, nid_number, phone_number, address, password_salt, password_hash, approval) "
                "VALUES (?, ?, ?, ?, ?, ?, 'pending')",
                (full_name, nid, phone, address, salt, digest))
    except sqlite3.IntegrityError:
        raise srv.ApiError(409, "An account already exists for this NID. Please log in.")
    finally:
        conn.close()


def request_code(srv, handler):
    if not srv.register_rate_ok(handler.client_address[0]):
        raise srv.ApiError(429, "Too many registration attempts. Please wait a few minutes and try again.")
    data = read_json(srv, handler, srv.MAX_BODY)
    clean, errors = srv.validate_registration(data)
    if errors:
        raise srv.ApiError(400, "Please correct the highlighted fields.", errors)
    record = registry_record(srv, clean)
    salt = secrets.token_hex(16)
    digest = srv.password_digest(clean["password"], salt)
    settings = sms_gateway.get_settings(srv)

    if settings["mode"] == "off":
        create_account(srv, clean["nid"], record["full_name"], record["phone_number"], record["address"], salt, digest)
        srv.log("REGISTERED new account for NID %s" % srv.mask_nid(clean["nid"]))
        return 201, {"ok": True, "verified": True, "message": APPROVAL_MESSAGE}

    pending = {"nid": clean["nid"], "full_name": record["full_name"], "phone_number": record["phone_number"],
               "address": record["address"], "password_salt": salt, "password_hash": digest}
    code = sms_gateway.issue_code(srv, srv.SESSION_SECRET, pending, settings)
    srv.log("VERIFICATION CODE issued for NID %s (%s mode)" % (srv.mask_nid(clean["nid"]), settings["mode"]))
    payload = {"ok": True, "verified": False, "step": "code", "mode": settings["mode"],
               "masked_phone": sms_gateway.mask_phone(record["phone_number"]),
               "expires_in": sms_gateway.OTP_TTL_SECONDS, "resend_in": sms_gateway.OTP_RESEND_SECONDS}
    if settings["mode"] == "demo":
        payload["demo_code"] = code          # demo only: nothing is sent, so the code is shown on screen
    return 200, payload


def verify(srv, handler):
    data = read_json(srv, handler, srv.MAX_BODY)
    nid = str(data.get("nid", "")).strip()
    code = str(data.get("code", "")).strip()
    if not re.fullmatch(r"[0-9]{10}", nid):
        raise srv.ApiError(400, "Please correct the highlighted fields.", {"nid": "NID must contain exactly 10 digits."})
    if not re.fullmatch(r"[0-9]{6}", code):
        raise srv.ApiError(400, "Please correct the highlighted fields.", {"code": "Enter the 6-digit code."})
    row = sms_gateway.check_code(srv, srv.SESSION_SECRET, nid, code)
    create_account(srv, nid, row["full_name"], row["phone_number"], row["address"],
                   row["password_salt"], row["password_hash"])
    sms_gateway.delete_pending(srv, nid)
    srv.log("REGISTERED new account for NID %s (phone verified)" % srv.mask_nid(nid))
    return 201, {"ok": True, "verified": True, "message": APPROVAL_MESSAGE}


# ---------- profile photo ----------

def photo_data_url(row):
    """A data URL for a row that has photo_data and photo_type, or None."""
    if row is None or not row["photo_data"]:
        return None
    return "data:%s;base64,%s" % (row["photo_type"], base64.b64encode(bytes(row["photo_data"])).decode("ascii"))


def decode_image(srv, raw):
    text = str(raw or "").strip()
    if text.startswith("data:") and ";base64," in text:
        text = text.split(";base64,", 1)[1]
    text = re.sub(r"\s", "", text)
    unreadable = {"image": "The photo could not be read. Choose a JPEG or PNG image."}
    try:
        blob = base64.b64decode(text, validate=True)
    except (binascii.Error, ValueError):
        raise srv.ApiError(400, "Please correct the highlighted fields.", unreadable)
    if not blob:
        raise srv.ApiError(400, "Please correct the highlighted fields.", unreadable)
    if len(blob) > PHOTO_MAX_BYTES:
        raise srv.ApiError(413, "The photo is larger than 2 MB. Choose a smaller image.", {"image": "Use an image under 2 MB."})
    if blob[:3] == b"\xff\xd8\xff":
        kind = "image/jpeg"
    elif blob[:8] == b"\x89PNG\r\n\x1a\n":
        kind = "image/png"
    else:
        raise srv.ApiError(400, "Please correct the highlighted fields.", {"image": "Only JPEG or PNG images are allowed."})
    return kind, blob


def photo(srv, handler, method):
    user = srv.session_user(handler)
    if not user:
        raise srv.ApiError(401, "Please log in.")
    if method == "GET":
        conn = srv.connect()
        try:
            row = conn.execute("SELECT photo_data, photo_type FROM authorized_users WHERE id = ?", (user["id"],)).fetchone()
        finally:
            conn.close()
        return 200, {"photo": photo_data_url(row)}
    if method != "POST":
        raise srv.ApiError(405, "Method not allowed.")
    data = read_json(srv, handler, PHOTO_BODY_MAX)
    if data.get("remove") is True:
        _store_photo(srv, user["id"], None, "")
        return 200, {"photo": None, "message": "Photo removed."}
    kind, blob = decode_image(srv, data.get("image"))
    _store_photo(srv, user["id"], blob, kind)
    return 200, {"photo": "data:%s;base64,%s" % (kind, base64.b64encode(blob).decode("ascii")),
                 "message": "Photo saved."}


def _store_photo(srv, user_id, blob, kind):
    conn = srv.connect()
    try:
        with conn:
            conn.execute("UPDATE authorized_users SET photo_data = ?, photo_type = ? WHERE id = ?", (blob, kind, user_id))
    finally:
        conn.close()


def user_has_photo(srv, user_id):
    conn = srv.connect()
    try:
        row = conn.execute("SELECT photo_data FROM authorized_users WHERE id = ?", (user_id,)).fetchone()
    finally:
        conn.close()
    return bool(row and row["photo_data"])


# ---------- application form ----------

def clean_application(data):
    """Checks the application form. Returns (clean values, errors). Only the fields for this service are asked."""
    clean, errors = {}, {}
    service = str(data.get("service", "")).strip()
    rules = dict(TEXT_RULES)
    rules.update(SERVICE_RULES.get(service, {}))
    for key in APPLICATION_TEXT_KEYS:
        clean[key] = ""
    for key, (low, high, message) in rules.items():
        value = " ".join(str(data.get(key, "")).split())
        if not low <= len(value) <= high:
            errors[key] = message
        else:
            clean[key] = value

    dob = str(data.get("date_of_birth", "")).strip()
    try:
        # strptime, not date.fromisoformat: the cPanel host runs Python 3.6
        born = datetime.strptime(dob, "%Y-%m-%d").date()
        today = date.today()
        if not (today.year - 120 <= born.year and born <= today):
            raise ValueError
        clean["date_of_birth"] = born.isoformat()
    except ValueError:
        errors["date_of_birth"] = "Enter a valid date of birth."

    gender = str(data.get("gender", "")).strip()
    if gender in GENDERS:
        clean["gender"] = gender
    else:
        errors["gender"] = "Choose a gender."

    phone = re.sub(r"[\s-]", "", str(data.get("phone", "")))
    if phone.startswith("+88"):
        phone = phone[3:]
    elif phone.startswith("88") and len(phone) == 13:
        phone = phone[2:]
    if PHONE_RE.fullmatch(phone):
        clean["phone"] = phone
    else:
        errors["phone"] = "Enter a valid 11-digit mobile number (01XXXXXXXXX)."

    email = str(data.get("email", "")).strip()
    if email and (len(email) > 120 or not EMAIL_RE.fullmatch(email)):
        errors["email"] = "Enter a valid email address or leave it empty."
    clean["email"] = email if not errors.get("email") else ""

    if data.get("declaration") is not True:
        errors["declaration"] = "Please confirm that the information is correct."
    return clean, errors


def profile(srv, handler, method):
    """My Profile: the account's details (GET) and the email address (POST)."""
    user = srv.session_user(handler)
    if not user:
        raise srv.ApiError(401, "Please log in.")
    conn = srv.connect()
    try:
        if method == "GET":
            row = conn.execute(
                "SELECT full_name, nid_number, phone_number, address, email, approval, created_at "
                "FROM authorized_users WHERE id = ?", (user["id"],)).fetchone()
            return 200, {"profile": {
                "name": row["full_name"], "nid": row["nid_number"], "phone": row["phone_number"],
                "address": row["address"], "email": row["email"], "status": row["approval"],
                "registered": row["created_at"]}}
        if method != "POST":
            raise srv.ApiError(405, "Method not allowed.")
        data = handler._read_json()
        email = str(data.get("email", "")).strip()[:120]
        if email and not EMAIL_RE.fullmatch(email):
            raise srv.ApiError(400, "Please correct the highlighted fields.",
                               {"email": "Enter a valid email address, or leave the box empty."})
        with conn:
            conn.execute("UPDATE authorized_users SET email = ? WHERE id = ?", (email, user["id"]))
        return 200, {"ok": True, "email": email, "message": "Email saved."}
    finally:
        conn.close()


def application_details(row):
    """The extra form fields of one application, for the administrator's case view."""
    keys = row.keys()
    return [{"label": label, "value": row[key]} for key, label in DETAIL_LABELS if key in keys and row[key]]
