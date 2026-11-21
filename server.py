#!/usr/bin/env python3
"""
GovShield - Government Service Portal
Web server + database (uses only Python's built-in libraries, nothing to install)

START THE PORTAL
    python server.py                 then open  http://localhost:8000
    python server.py --port 8080     use another port

USE THE TERMINAL AS A DATABASE
    While the server is running you get a  govshield>  prompt:
        show                         show applications and payments
        show applications            show only applications
        show payments                show only payments
        sql SELECT * FROM payments   run any read-only SQL query
        help                         list the commands
        quit                         stop the server

    Without starting the server you can also run:
        python server.py show
        python server.py show payments
        python server.py sql "SELECT status, COUNT(*) FROM applications GROUP BY status"
        python server.py reset       delete all data and start fresh

The data is stored in the file  govshield.db  (created next to this file).
"""

import argparse
import json
import hashlib
import hmac
import secrets
import time
import os
import re
import sqlite3
import sys
import threading
import traceback
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "govshield.db")
MAX_BODY = 10 * 1024          # requests bigger than 10 KB are refused
SESSION_TTL_SECONDS = 8 * 60 * 60
# Login tokens live in the sessions table, so a server restart (Render sleeps and wakes) does not log anyone out.
DEMO_PASSWORD_PREFIX = "GovDemo#"
# Administrators have their own accounts (table admin_users) and their own login page.
ADMIN_USERNAME = os.environ.get("GOVSHIELD_ADMIN_USER", "admin").strip() or "admin"
# Set GOVSHIELD_ADMIN_PASSWORD on the server. The fallback is for the local demo only.
ADMIN_PASSWORD = os.environ.get("GOVSHIELD_ADMIN_PASSWORD", "GovAdmin#2026")
APP_STATUSES = ("Pending", "Processing", "Approved", "Rejected")
ACTIVITY_ACTIONS = ("Track", "Document")     # citizen actions the portal reports itself

SERVICES = ["Birth Certificate", "Citizenship Certificate", "Trade Licence", "Other Certificate"]
PAYMENT_TYPES = ["Tax", "Electricity Bill", "Water Bill", "Gas Bill"]
PAYMENT_METHODS = ["bKash", "Nagad", "Card"]

# ----------------------------------------------------------------------
# DATABASE
# ----------------------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS applications (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    app_code       TEXT UNIQUE,
    service        TEXT NOT NULL,
    applicant_name TEXT NOT NULL,
    national_id    TEXT NOT NULL,
    address        TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'Pending'
                   CHECK (status IN ('Pending', 'Processing', 'Approved', 'Rejected')),
    created_at     TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS authorized_users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name     TEXT NOT NULL,
    nid_number    TEXT NOT NULL UNIQUE,
    phone_number  TEXT NOT NULL,
    address       TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at    TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- Demo NID database: the only identities that are allowed to self-register.
CREATE TABLE IF NOT EXISTS nid_registry (
    nid_number   TEXT PRIMARY KEY CHECK (length(nid_number) = 10),
    full_name    TEXT NOT NULL,
    phone_number TEXT NOT NULL,
    address      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    txn_code     TEXT UNIQUE,
    payment_type TEXT NOT NULL,
    reference_no TEXT NOT NULL,
    amount       REAL NOT NULL CHECK (amount > 0 AND amount <= 1000000),
    method       TEXT NOT NULL CHECK (method IN ('bKash', 'Nagad', 'Card')),
    status       TEXT NOT NULL DEFAULT 'Paid',
    created_at   TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- Login tokens for citizens (kind = citizen) and administrators (kind = admin).
CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    kind       TEXT NOT NULL CHECK (kind IN ('citizen', 'admin')),
    account_id INTEGER NOT NULL,
    expires_at REAL NOT NULL
);

-- Administrator accounts. Completely separate from citizen accounts (authorized_users).
CREATE TABLE IF NOT EXISTS admin_users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    full_name     TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
);

-- Admin dashboard: one row per important action (login, logout, register, apply, pay).
CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_label  TEXT NOT NULL,
    ip_address  TEXT NOT NULL,
    action      TEXT NOT NULL,
    result      TEXT NOT NULL,
    severity    TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
"""

# demo applications that exist the first time the database is created
SEED_APPLICATIONS = [
    ("Birth Certificate", "Mithila Parvin", "Approved", "2026-10-01 10:00:00"),
    ("Trade Licence", "Mithila Parvin", "Processing", "2026-10-03 11:30:00"),
    ("Citizenship Certificate", "Mithila Parvin", "Pending", "2026-10-04 09:15:00"),
]



# Fictional demonstration identities only. Replace these with an authorized,
# lawfully obtained test-user roster before any real deployment.
DEMO_USERS = [
    ("Amina Rahman", "1000000001", "00000000001", "Demo Address 1, Sylhet"),
    ("Hasan Mahmud", "1000000002", "00000000002", "Demo Address 2, Dhaka"),
    ("Nusrat Jahan", "1000000003", "00000000003", "Demo Address 3, Chattogram"),
    ("Tanvir Ahmed", "1000000004", "00000000004", "Demo Address 4, Cumilla"),
    ("Fatema Akter", "1000000005", "00000000005", "Demo Address 5, Rajshahi"),
    ("Sakib Hossain", "1000000006", "00000000006", "Demo Address 6, Khulna"),
    ("Mim Sultana", "1000000007", "00000000007", "Demo Address 7, Barishal"),
    ("Imran Kabir", "1000000008", "00000000008", "Demo Address 8, Rangpur"),
    ("Sadia Islam", "1000000009", "00000000009", "Demo Address 9, Mymensingh"),
    ("Arif Hossain", "1000000010", "00000000010", "Demo Address 10, Sylhet"),
    ("Jannat Ara", "1000000011", "00000000011", "Demo Address 11, Dhaka"),
    ("Mehedi Hasan", "1000000012", "00000000012", "Demo Address 12, Bogura"),
    ("Rafiq Uddin", "1000000013", "00000000013", "Demo Address 13, Feni"),
    ("Sumaiya Noor", "1000000014", "00000000014", "Demo Address 14, Habiganj"),
    ("Abdullah Karim", "1000000015", "00000000015", "Demo Address 15, Sunamganj"),
]


# More fictional identities that exist ONLY in the demo NID database. They have no
# login account yet, so they can be used to try self-registration.
EXTRA_REGISTRY = [
    ("Rubina Yasmin", "1000000016", "01700000016", "Demo Address 16, Sylhet"),
    ("Kamrul Islam", "1000000017", "01700000017", "Demo Address 17, Dhaka"),
    ("Shirin Sultana", "1000000018", "01700000018", "Demo Address 18, Chattogram"),
    ("Nayeem Chowdhury", "1000000019", "01700000019", "Demo Address 19, Sylhet"),
    ("Lutfa Begum", "1000000020", "01700000020", "Demo Address 20, Moulvibazar"),
    ("Faisal Ahmed", "1000000021", "01700000021", "Demo Address 21, Rajshahi"),
    ("Tahmina Khatun", "1000000022", "01700000022", "Demo Address 22, Khulna"),
    ("Shahriar Alam", "1000000023", "01700000023", "Demo Address 23, Barishal"),
    ("Ruma Akter", "1000000024", "01700000024", "Demo Address 24, Rangpur"),
    ("Omar Faruk", "1000000025", "01700000025", "Demo Address 25, Cumilla"),
]


def seed_nid_registry(conn):
    """Fill the demo NID database. Safe to run on every start (existing rows are kept)."""
    for name, nid, phone, address in DEMO_USERS + EXTRA_REGISTRY:
        conn.execute(
            "INSERT OR IGNORE INTO nid_registry (nid_number, full_name, phone_number, address) VALUES (?, ?, ?, ?)",
            (nid, name, phone, address),
        )


def normalize_name(value):
    return " ".join(str(value).split()).casefold()


def normalize_phone(value):
    """Digits only; +88 / 88 country prefix removed. Returns '' if it is not an 11-digit number."""
    digits = re.sub(r"\D", "", str(value))
    if len(digits) == 13 and digits.startswith("88"):
        digits = digits[2:]
    return digits if re.fullmatch(r"\d{11}", digits) else ""


def validate_registration(data):
    errors = {}
    nid = str(data.get("nid", "")).strip()
    name = " ".join(str(data.get("name", "")).split())
    phone = normalize_phone(str(data.get("phone", "")).strip())
    password = str(data.get("password", ""))

    if not re.fullmatch(r"[0-9]{10}", nid):
        errors["nid"] = "NID must contain exactly 10 digits."
    if not 3 <= len(name) <= 100:
        errors["name"] = "Enter your full name (3 to 100 characters)."
    if not phone:
        errors["phone"] = "Enter an 11-digit phone number."
    if not 8 <= len(password) <= 128 or not re.search(r"[A-Za-z]", password) or not re.search(r"\d", password):
        errors["password"] = "Password must be 8-128 characters and include a letter and a number."
    return {"nid": nid, "name": name, "phone": phone, "password": password}, errors


def register_account(clean):
    """Create a login account only if NID + full name + phone all match the demo NID database."""
    conn = connect()
    try:
        with conn:
            record = conn.execute(
                "SELECT full_name, phone_number, address FROM nid_registry WHERE nid_number = ?",
                (clean["nid"],),
            ).fetchone()
            matches = (
                record is not None
                and normalize_name(record["full_name"]) == normalize_name(clean["name"])
                and normalize_phone(record["phone_number"]) == clean["phone"]
            )
            if not matches:
                # one generic message: do not reveal which field was wrong
                raise ApiError(400, "Registration failed: the NID, full name and phone number do not match the demo NID database.")
            if conn.execute("SELECT 1 FROM authorized_users WHERE nid_number = ?", (clean["nid"],)).fetchone():
                raise ApiError(409, "An account already exists for this NID. Please log in.")
            salt = secrets.token_hex(16)
            conn.execute(
                "INSERT INTO authorized_users (full_name, nid_number, phone_number, address, password_salt, password_hash) VALUES (?, ?, ?, ?, ?, ?)",
                (record["full_name"], clean["nid"], record["phone_number"], record["address"],
                 salt, password_digest(clean["password"], salt)),
            )
    except sqlite3.IntegrityError:
        raise ApiError(409, "An account already exists for this NID. Please log in.")
    finally:
        conn.close()


# small in-memory limiter so the NID database cannot be guessed by brute force
REGISTER_ATTEMPTS = {}     # ip -> list of timestamps
REGISTER_MAX = 10
REGISTER_WINDOW = 10 * 60


def register_rate_ok(ip):
    now = time.time()
    recent = [t for t in REGISTER_ATTEMPTS.get(ip, []) if now - t < REGISTER_WINDOW]
    if len(recent) >= REGISTER_MAX:
        REGISTER_ATTEMPTS[ip] = recent
        return False
    recent.append(now)
    REGISTER_ATTEMPTS[ip] = recent
    return True


def password_digest(password, salt):
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), 240000).hex()


def seed_authorized_users(conn):
    count = conn.execute("SELECT COUNT(*) FROM authorized_users").fetchone()[0]
    if count == 0:
        for i, (name, nid, phone, address) in enumerate(DEMO_USERS, start=1):
            salt = secrets.token_hex(16)
            password = "%s%04d" % (DEMO_PASSWORD_PREFIX, i)
            digest = password_digest(password, salt)
            conn.execute(
                "INSERT INTO authorized_users (full_name, nid_number, phone_number, address, password_salt, password_hash) VALUES (?, ?, ?, ?, ?, ?)",
                (name, nid, phone, address, salt, digest),
            )


def seed_admin_user(conn):
    """Creates or refreshes the single administrator account from the server settings."""
    salt = secrets.token_hex(16)
    digest = password_digest(ADMIN_PASSWORD, salt)
    conn.execute(
        "INSERT INTO admin_users (username, full_name, password_salt, password_hash) VALUES (?, ?, ?, ?) "
        "ON CONFLICT(username) DO UPDATE SET password_salt = excluded.password_salt, "
        "password_hash = excluded.password_hash, is_active = 1",
        (ADMIN_USERNAME, "System Administrator", salt, digest),
    )


def authenticate_user(nid, password):
    conn = connect()
    try:
        row = conn.execute(
            "SELECT id, full_name, nid_number, password_salt, password_hash, is_active FROM authorized_users WHERE nid_number = ?",
            (nid.strip(),),
        ).fetchone()
    finally:
        conn.close()
    if not row or not row["is_active"]:
        return None
    candidate = password_digest(password, row["password_salt"])
    if not hmac.compare_digest(candidate, row["password_hash"]):
        return None
    return {"id": row["id"], "name": row["full_name"], "nid": row["nid_number"]}


def create_session(kind, account_id):
    """Stores a new login token in the database and returns it."""
    token = secrets.token_urlsafe(32)
    conn = connect()
    try:
        with conn:
            conn.execute("DELETE FROM sessions WHERE expires_at < ?", (time.time(),))
            conn.execute(
                "INSERT INTO sessions (token, kind, account_id, expires_at) VALUES (?, ?, ?, ?)",
                (token, kind, account_id, time.time() + SESSION_TTL_SECONDS),
            )
    finally:
        conn.close()
    return token


def end_session(token):
    if not token:
        return
    conn = connect()
    try:
        with conn:
            conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
    finally:
        conn.close()


def session_account_id(kind, handler):
    """The account id behind the Bearer token, if the token is valid, unexpired and of this kind."""
    header = handler.headers.get("Authorization", "")
    token = header[7:].strip() if header.startswith("Bearer ") else ""
    if not token:
        return None
    conn = connect()
    try:
        row = conn.execute(
            "SELECT account_id, expires_at FROM sessions WHERE token = ? AND kind = ?", (token, kind)
        ).fetchone()
        if row and row["expires_at"] < time.time():
            with conn:
                conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
            return None
        return row["account_id"] if row else None
    finally:
        conn.close()


def session_user(handler):
    user_id = session_account_id("citizen", handler)
    if user_id is None:
        return None
    conn = connect()
    try:
        row = conn.execute("SELECT id, full_name, nid_number, is_active FROM authorized_users WHERE id = ?", (user_id,)).fetchone()
    finally:
        conn.close()
    if not row or not row["is_active"]:
        return None
    return {"id": row["id"], "name": row["full_name"], "nid": row["nid_number"]}

def authenticate_admin(username, password):
    conn = connect()
    try:
        row = conn.execute(
            "SELECT id, username, full_name, password_salt, password_hash, is_active FROM admin_users WHERE username = ?",
            (username,),
        ).fetchone()
    finally:
        conn.close()
    if not row or not row["is_active"]:
        return None
    candidate = password_digest(password, row["password_salt"])
    if not hmac.compare_digest(candidate, row["password_hash"]):
        return None
    return {"id": row["id"], "username": row["username"], "name": row["full_name"]}


def admin_session_user(handler):
    admin_id = session_account_id("admin", handler)
    if admin_id is None:
        return None
    conn = connect()
    try:
        row = conn.execute("SELECT id, username, full_name, is_active FROM admin_users WHERE id = ?", (admin_id,)).fetchone()
    finally:
        conn.close()
    if not row or not row["is_active"]:
        return None
    return {"id": row["id"], "username": row["username"], "name": row["full_name"]}

def connect(read_only=False):
    if read_only:
        conn = sqlite3.connect(Path(DB_PATH).as_uri() + "?mode=ro", uri=True, timeout=10)
    else:
        conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def seed_if_empty(conn):
    count = conn.execute("SELECT COUNT(*) FROM applications").fetchone()[0]
    if count == 0:
        for service, name, status, created in SEED_APPLICATIONS:
            conn.execute(
                "INSERT INTO applications (service, applicant_name, national_id, address, status, created_at) "
                "VALUES (?, ?, '', '', ?, ?)",
                (service, name, status, created),
            )
        conn.execute("UPDATE applications SET app_code = 'APP-' || (1000 + id) WHERE app_code IS NULL")


def ensure_column(conn, table, column, definition):
    """Adds a column to a table created by an older version (CREATE TABLE IF NOT EXISTS does not)."""
    names = [r[1] for r in conn.execute("PRAGMA table_info(%s)" % table).fetchall()]
    if column not in names:
        conn.execute("ALTER TABLE %s ADD COLUMN %s %s" % (table, column, definition))


def init_db():
    conn = connect()
    try:
        with conn:
            conn.executescript(SCHEMA)
            ensure_column(conn, "audit_log", "detail", "TEXT NOT NULL DEFAULT ''")
            ensure_column(conn, "payments", "payer_nid", "TEXT NOT NULL DEFAULT ''")
            seed_if_empty(conn)
            seed_authorized_users(conn)
            seed_admin_user(conn)
            seed_nid_registry(conn)
    finally:
        conn.close()


def reset_db():
    conn = connect()
    try:
        with conn:
            conn.executescript(SCHEMA)
            conn.execute("DELETE FROM applications")
            conn.execute("DELETE FROM payments")
            conn.execute("DELETE FROM sqlite_sequence WHERE name IN ('applications', 'payments')")
            seed_if_empty(conn)
    finally:
        conn.close()


def mask_nid(nid):
    if not nid:
        return "-"
    return "*" * max(len(nid) - 4, 0) + nid[-4:]


def application_json(row):
    return {
        "id": row["app_code"],
        "service": row["service"],
        "date": row["created_at"][:10],
        "status": row["status"],
        "name": row["applicant_name"],
        "nid": mask_nid(row["national_id"]),      # the browser never receives the full NID
        "address": row["address"],
    }


def payment_json(row):
    return {
        "id": row["txn_code"],
        "type": row["payment_type"],
        "reference": row["reference_no"],
        "amount": "%.2f" % row["amount"],
        "method": row["method"],
        "status": row["status"],
        "date": row["created_at"],
    }


def list_applications():
    conn = connect()
    try:
        rows = conn.execute("SELECT * FROM applications ORDER BY id DESC LIMIT 500").fetchall()
        return [application_json(r) for r in rows]
    finally:
        conn.close()


def list_payments():
    conn = connect()
    try:
        rows = conn.execute("SELECT * FROM payments ORDER BY id DESC LIMIT 500").fetchall()
        return [payment_json(r) for r in rows]
    finally:
        conn.close()


def create_application(clean):
    conn = connect()
    try:
        with conn:
            cur = conn.execute(
                "INSERT INTO applications (service, applicant_name, national_id, address) VALUES (?, ?, ?, ?)",
                (clean["service"], clean["name"], clean["nid"], clean["address"]),
            )
            new_id = cur.lastrowid
            conn.execute("UPDATE applications SET app_code = 'APP-' || (1000 + id) WHERE id = ?", (new_id,))
        row = conn.execute("SELECT * FROM applications WHERE id = ?", (new_id,)).fetchone()
        return application_json(row)
    finally:
        conn.close()


def create_payment(clean):
    conn = connect()
    try:
        with conn:
            cur = conn.execute(
                "INSERT INTO payments (payment_type, reference_no, amount, method, payer_nid) VALUES (?, ?, ?, ?, ?)",
                (clean["type"], clean["reference"], clean["amount"], clean["method"], clean.get("payer_nid", "")),
            )
            new_id = cur.lastrowid
            conn.execute("UPDATE payments SET txn_code = 'TXN-' || (10000000 + id) WHERE id = ?", (new_id,))
        row = conn.execute("SELECT * FROM payments WHERE id = ?", (new_id,)).fetchone()
        return payment_json(row)
    finally:
        conn.close()


# ----------------------------------------------------------------------
# ADMIN AUDIT LOG (used by the Security Admin Dashboard)
# ----------------------------------------------------------------------

# which POST requests are written to the audit log, and the name shown in the dashboard
AUDIT_ACTIONS = {
    "/api/login": "Login",
    "/api/logout": "Logout",
    "/api/register": "Register",
    "/api/applications": "Application",
    "/api/payments": "Payment",
    "/api/admin/login": "Admin login",
    "/api/admin/logout": "Admin logout",
}


def record_audit(user_label, ip, action, result, severity, detail=""):
    conn = connect()
    try:
        with conn:
            conn.execute(
                "INSERT INTO audit_log (user_label, ip_address, action, result, severity, detail) VALUES (?, ?, ?, ?, ?, ?)",
                (user_label, ip, action, result, severity, detail),
            )
    finally:
        conn.close()


def count_recent_login_failures(ip, action="Login"):
    conn = connect()
    try:
        return conn.execute(
            "SELECT COUNT(*) FROM audit_log WHERE action = ? AND result = 'Failed' AND ip_address = ? "
            "AND created_at >= datetime('now', 'localtime', '-10 minutes')",
            (action, ip),
        ).fetchone()[0]
    finally:
        conn.close()


def admin_summary():
    conn = connect()
    try:
        def count(sql):
            return conn.execute(sql).fetchone()[0]
        return {
            "totalLogins": count("SELECT COUNT(*) FROM audit_log WHERE action = 'Login' AND result = 'Success'"),
            "failedLogins": count("SELECT COUNT(*) FROM audit_log WHERE action = 'Login' AND result = 'Failed'"),
            "securityAlerts": count("SELECT COUNT(*) FROM audit_log WHERE severity = 'High'"),
        }
    finally:
        conn.close()


def admin_audit_rows():
    conn = connect()
    try:
        rows = conn.execute("SELECT * FROM audit_log ORDER BY id DESC LIMIT 200").fetchall()
        return [
            {
                "user": r["user_label"],
                "ip": r["ip_address"],
                "action": r["action"],
                "result": r["result"],
                "severity": r["severity"],
                "time": r["created_at"],
                "detail": r["detail"],
            }
            for r in rows
        ]
    finally:
        conn.close()


# ----------------------------------------------------------------------
# ADMIN DASHBOARD DATA (administrator sessions only)
# ----------------------------------------------------------------------

def change_application_status(app_code, status):
    conn = connect()
    try:
        with conn:
            row = conn.execute("SELECT status FROM applications WHERE app_code = ?", (app_code,)).fetchone()
            if not row:
                raise ApiError(404, "Application not found.")
            conn.execute("UPDATE applications SET status = ? WHERE app_code = ?", (status, app_code))
            return row["status"]
    finally:
        conn.close()


def admin_overview():
    conn = connect()
    try:
        today = datetime.now().strftime("%Y-%m-%d")
        days = [(datetime.now().date() - timedelta(days=i)).isoformat() for i in range(13, -1, -1)]
        since = days[0]

        def one(sql, *params):
            return conn.execute(sql, params).fetchone()[0]

        def pairs(sql, *params):
            return {r[0]: r[1] for r in conn.execute(sql, params).fetchall()}

        def per_day(table, extra=""):
            counts = pairs("SELECT substr(created_at, 1, 10), COUNT(*) FROM %s "
                           "WHERE substr(created_at, 1, 10) >= ? %s GROUP BY 1" % (table, extra), since)
            return [counts.get(d, 0) for d in days]

        return {
            "citizens": one("SELECT COUNT(*) FROM authorized_users WHERE is_active = 1"),
            "applications": one("SELECT COUNT(*) FROM applications"),
            "applicationsToday": one("SELECT COUNT(*) FROM applications WHERE substr(created_at, 1, 10) = ?", today),
            "pending": one("SELECT COUNT(*) FROM applications WHERE status IN ('Pending', 'Processing')"),
            "applicationsByStatus": pairs("SELECT status, COUNT(*) FROM applications GROUP BY status"),
            "applicationsByService": pairs("SELECT service, COUNT(*) FROM applications GROUP BY service"),
            "payments": one("SELECT COUNT(*) FROM payments"),
            "paymentsTotal": one("SELECT COALESCE(SUM(amount), 0) FROM payments"),
            "paymentsByMethod": pairs("SELECT method, COALESCE(SUM(amount), 0) FROM payments GROUP BY method"),
            "loginsToday": one("SELECT COUNT(*) FROM audit_log WHERE action = 'Login' AND result = 'Success' "
                               "AND substr(created_at, 1, 10) = ?", today),
            "failedToday": one("SELECT COUNT(*) FROM audit_log WHERE action = 'Login' AND result = 'Failed' "
                               "AND substr(created_at, 1, 10) = ?", today),
            "alerts": one("SELECT COUNT(*) FROM audit_log WHERE severity = 'High'"),
            "events": one("SELECT COUNT(*) FROM audit_log"),
            "series": {
                "days": days,
                "applications": per_day("applications"),
                "payments": per_day("payments"),
                "logins": per_day("audit_log", "AND action = 'Login' AND result = 'Success'"),
            },
        }
    finally:
        conn.close()


def admin_citizens():
    conn = connect()
    try:
        rows = conn.execute("""
            SELECT u.full_name, u.nid_number, u.phone_number, u.is_active, u.created_at,
                   (SELECT COUNT(*) FROM applications a
                     WHERE a.national_id = u.nid_number OR a.applicant_name = u.full_name) AS app_count,
                   (SELECT COUNT(*) FROM payments p WHERE p.payer_nid = u.nid_number) AS pay_count,
                   (SELECT COALESCE(SUM(p.amount), 0) FROM payments p WHERE p.payer_nid = u.nid_number) AS pay_sum,
                   (SELECT MAX(l.created_at) FROM audit_log l
                     WHERE l.user_label = u.full_name AND l.action = 'Login' AND l.result = 'Success') AS last_login
            FROM authorized_users u ORDER BY u.id
        """).fetchall()
        return [
            {
                "name": r["full_name"],
                "nid": mask_nid(r["nid_number"]),
                "phone": mask_nid(r["phone_number"]),
                "active": bool(r["is_active"]),
                "registered": r["created_at"],
                "applications": r["app_count"],
                "payments": r["pay_count"],
                "paid": "%.2f" % r["pay_sum"],
                "lastLogin": r["last_login"] or "",
            }
            for r in rows
        ]
    finally:
        conn.close()


# ----------------------------------------------------------------------
# VALIDATION (the server checks everything again, never trust the browser)
# ----------------------------------------------------------------------

def validate_application(data):
    errors = {}
    service = str(data.get("service", "")).strip()
    name = str(data.get("name", "")).strip()
    nid = str(data.get("nid", "")).strip()
    address = str(data.get("address", "")).strip()

    if service not in SERVICES:
        errors["service"] = "Please select a service."
    if not 3 <= len(name) <= 100:
        errors["name"] = "Enter the applicant name (3 to 100 characters)."
    if not re.fullmatch(r"\d{10}|\d{13}|\d{17}", nid):
        errors["nid"] = "NID must be 10, 13 or 17 digits."
    if not 5 <= len(address) <= 200:
        errors["address"] = "Enter your address (5 to 200 characters)."

    return {"service": service, "name": name, "nid": nid, "address": address}, errors


def validate_payment(data):
    errors = {}
    ptype = str(data.get("type", "")).strip()
    reference = str(data.get("reference", "")).strip()
    method = str(data.get("method", "")).strip()
    amount = None

    if ptype not in PAYMENT_TYPES:
        errors["type"] = "Please select a payment type."
    if not re.fullmatch(r"[A-Za-z0-9-]{6,20}", reference):
        errors["reference"] = "6-20 characters (letters, numbers, hyphen)."
    if method not in PAYMENT_METHODS:
        errors["method"] = "Please select a payment method."

    try:
        value = Decimal(str(data.get("amount", "")).strip())
        if not value.is_finite() or not Decimal("0") < value <= Decimal("1000000"):
            errors["amount"] = "Enter an amount between 1 and 1,000,000."
        elif value != value.quantize(Decimal("0.01")):
            errors["amount"] = "Use at most 2 decimal places."
        else:
            amount = float(value)
    except InvalidOperation:
        errors["amount"] = "Enter an amount between 1 and 1,000,000."

    return {"type": ptype, "reference": reference, "method": method, "amount": amount}, errors


# ----------------------------------------------------------------------
# WEB SERVER
# ----------------------------------------------------------------------

def log(message):
    print("[%s] %s" % (datetime.now().strftime("%H:%M:%S"), message), flush=True)


class ApiError(Exception):
    def __init__(self, status, message, errors=None):
        Exception.__init__(self, message)
        self.status = status
        self.message = message
        self.errors = errors or {}


# only these folders / file types are ever sent to the browser
# (so govshield.db and server.py can never be downloaded)
PUBLIC_DIRS = {"css", "js"}
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
}
LOCAL_ORIGIN = re.compile(r"^http://(localhost|127\.0\.0\.1)(:\d+)?$")


class Handler(BaseHTTPRequestHandler):
    server_version = "GovShield"

    def log_message(self, fmt, *args):      # silence the default log, we print our own
        pass

    # ---------- helpers ----------

    def _headers(self, status, content_type, length):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Cache-Control", "no-store")
        origin = self.headers.get("Origin", "")
        if LOCAL_ORIGIN.match(origin):      # lets VS Code Live Server talk to this server
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()

    def _json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self._headers(status, "application/json; charset=utf-8", len(body))
        self.wfile.write(body)

    def _read_json(self):
        if not self.headers.get("Content-Type", "").lower().startswith("application/json"):
            raise ApiError(415, "Content-Type must be application/json.")
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise ApiError(400, "Bad Content-Length.")
        if length <= 0:
            raise ApiError(400, "Empty request.")
        if length > MAX_BODY:
            raise ApiError(413, "Request is too large.")
        try:
            data = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            raise ApiError(400, "Invalid JSON.")
        if not isinstance(data, dict):
            raise ApiError(400, "A JSON object is expected.")
        return data

    # ---------- API ----------

    def _api(self, method, path):
        if path == "/api/health":
            if method != "GET":
                raise ApiError(405, "Method not allowed.")
            return 200, {"ok": True}

        if path == "/api/login":
            if method != "POST":
                raise ApiError(405, "Method not allowed.")
            data = self._read_json()
            nid = str(data.get("nid", "")).strip()
            password = str(data.get("password", ""))
            if not re.fullmatch(r"[0-9]{10}", nid):
                raise ApiError(400, "National ID must contain exactly 10 digits.")
            if not password or len(password) > 256:
                raise ApiError(400, "Enter your password.")
            user = authenticate_user(nid, password)
            if not user:
                self.audit_user = "NID " + mask_nid(nid)          # audit log only
                raise ApiError(401, "Invalid National ID or password, or account not authorized.")
            token = create_session("citizen", user["id"])
            self.audit_user = user["name"]                        # audit log only
            log("AUTHENTICATED authorized demo account %s" % user["nid"])
            return 200, {"token": token, "user": {"name": user["name"], "nid": user["nid"]}}

        if path == "/api/register":
            if method != "POST":
                raise ApiError(405, "Method not allowed.")
            if not register_rate_ok(self.client_address[0]):
                raise ApiError(429, "Too many registration attempts. Please wait a few minutes and try again.")
            data = self._read_json()
            clean, errors = validate_registration(data)
            if errors:
                raise ApiError(400, "Please correct the highlighted fields.", errors)
            register_account(clean)
            log("REGISTERED new account for NID %s" % mask_nid(clean["nid"]))
            return 201, {"ok": True, "message": "Registration successful. You can now log in."}

        if path == "/api/logout":
            if method != "POST":
                raise ApiError(405, "Method not allowed.")
            header = self.headers.get("Authorization", "")
            token = header[7:].strip() if header.startswith("Bearer ") else ""
            end_session(token)
            return 200, {"ok": True}

        if path == "/api/me":
            if method != "GET":
                raise ApiError(405, "Method not allowed.")
            user = session_user(self)
            if not user:
                raise ApiError(401, "Please log in.")
            return 200, {"user": {"name": user["name"], "nid": user["nid"]}}

        # Administrator routes use their own login page, accounts and sessions.
        if path == "/api/admin/login":
            if method != "POST":
                raise ApiError(405, "Method not allowed.")
            data = self._read_json()
            username = str(data.get("username", "")).strip()[:64]
            password = str(data.get("password", ""))
            if not username or not password or len(password) > 256:
                self.audit_user = "Admin " + (username or "(blank)")
                raise ApiError(400, "Enter the administrator username and password.")
            admin = authenticate_admin(username, password)
            if not admin:
                self.audit_user = "Admin " + username
                raise ApiError(401, "Invalid administrator username or password.")
            token = create_session("admin", admin["id"])
            self.audit_user = admin["name"]
            log("ADMIN LOGIN %s" % admin["username"])
            return 200, {"token": token, "admin": {"name": admin["name"], "username": admin["username"]}}

        if path == "/api/admin/logout":
            if method != "POST":
                raise ApiError(405, "Method not allowed.")
            admin = admin_session_user(self)
            if admin:
                self.audit_user = admin["name"]
            header = self.headers.get("Authorization", "")
            end_session(header[7:].strip() if header.startswith("Bearer ") else "")
            return 200, {"ok": True}

        if path == "/api/admin/me":
            if method != "GET":
                raise ApiError(405, "Method not allowed.")
            admin = admin_session_user(self)
            if not admin:
                raise ApiError(401, "Please log in as an administrator.")
            return 200, {"admin": {"name": admin["name"], "username": admin["username"]}}

        if path.startswith("/api/admin/"):
            admin = admin_session_user(self)
            if not admin:
                raise ApiError(401, "Please log in as an administrator.")
            self.audit_user = admin["name"]
            return self._admin_api(method, path)

        # All portal data endpoints require a valid server-issued session.
        user = session_user(self)
        if not user:
            raise ApiError(401, "Please log in to access the portal.")

        if path == "/api/activity":
            # citizen actions the browser reports itself (track page, document download)
            if method != "POST":
                raise ApiError(405, "Method not allowed.")
            data = self._read_json()
            action = str(data.get("action", "")).strip()
            detail = " ".join(str(data.get("detail", "")).split())[:120]
            if action not in ACTIVITY_ACTIONS:
                raise ApiError(400, "Unknown activity.")
            record_audit(user["name"], self.client_address[0], action, "Success", "Low", detail)
            return 201, {"ok": True}

        if path == "/api/applications":
            if method == "GET":
                return 200, list_applications()
            if method != "POST":
                raise ApiError(405, "Method not allowed.")
            data = self._read_json()
            clean, errors = validate_application(data)
            if errors:
                raise ApiError(400, "Please correct the highlighted fields.", errors)
            app = create_application(clean)
            log("SAVED application %s | %s | %s | NID %s" % (app["id"], app["service"], app["name"], app["nid"]))
            self.audit_detail = "%s - %s" % (app["id"], app["service"])
            return 201, app

        if path == "/api/payments":
            if method == "GET":
                return 200, list_payments()
            if method != "POST":
                raise ApiError(405, "Method not allowed.")
            data = self._read_json()
            clean, errors = validate_payment(data)
            if errors:
                raise ApiError(400, "Please correct the highlighted fields.", errors)
            clean["payer_nid"] = user["nid"]
            pay = create_payment(clean)
            log("SAVED payment %s | %s | BDT %s | %s" % (pay["id"], pay["type"], pay["amount"], pay["method"]))
            self.audit_detail = "%s - %s - BDT %s" % (pay["id"], pay["type"], pay["amount"])
            return 201, pay

        raise ApiError(404, "Not found.")

    def _admin_api(self, method, path):
        """Admin dashboard routes. The caller has already been checked for an administrator session."""
        readers = {
            "/api/admin/summary": admin_summary,
            "/api/admin/audit": admin_audit_rows,
            "/api/admin/overview": admin_overview,
            "/api/admin/applications": list_applications,
            "/api/admin/payments": list_payments,
            "/api/admin/citizens": admin_citizens,
        }
        if path in readers:
            if method != "GET":
                raise ApiError(405, "Method not allowed.")
            return 200, readers[path]()

        match = re.fullmatch(r"/api/admin/applications/(APP-\d+)/status", path)
        if match:
            if method != "POST":
                raise ApiError(405, "Method not allowed.")
            data = self._read_json()
            status = str(data.get("status", "")).strip()
            if status not in APP_STATUSES:
                raise ApiError(400, "Please choose a valid status.", {"status": "Choose a valid status."})
            app_code = match.group(1)
            old_status = change_application_status(app_code, status)
            record_audit(self.audit_user or "Administrator", self.client_address[0], "Status", "Success", "Low",
                         "%s - %s -> %s" % (app_code, old_status, status))
            return 200, {"ok": True, "id": app_code, "status": status}

        raise ApiError(404, "Not found.")

    def _handle_api(self, method, path):
        status = 500
        self.audit_user = None
        self.audit_detail = ""
        try:
            who = session_user(self)            # the logged-in user, if any (audit log only)
            self.audit_user = who["name"] if who else None
            status, payload = self._api(method, path)
            self._json(status, payload)
        except ApiError as e:
            status = e.status
            if e.status == 400 and e.errors:
                log("REJECTED %s %s | %s" % (method, path, ", ".join(sorted(e.errors))))
            self._json(e.status, {"error": e.message, "errors": e.errors})
        except Exception:
            traceback.print_exc()
            self._json(500, {"error": "Server error."})
        finally:
            self._audit(method, path, status)

    def _audit(self, method, path, status):
        """Adds one row to the admin audit log for each important POST action."""
        action = AUDIT_ACTIONS.get(path)
        if method != "POST" or not action:
            return
        try:
            if status < 300:
                result, severity = "Success", "Low"
            elif status == 429:
                result, severity = "Blocked", "High"
            else:
                result, severity = "Failed", ("Medium" if action in ("Login", "Admin login") else "Low")
            ip = self.client_address[0]
            if action in ("Login", "Admin login") and result == "Failed" and count_recent_login_failures(ip, action) >= 4:
                severity = "High"               # 5th failed login from this address in 10 minutes
            record_audit(self.audit_user or "Unknown user", ip, action, result, severity, self.audit_detail)
        except Exception:
            traceback.print_exc()               # logging must never break the portal

    # ---------- static files ----------

    def _static(self, path):
        path = unquote(path)
        if path in ("/", "/index.html"):
            relative = "index.html"
        elif path in ("/admin", "/admin.html"):
            relative = "admin.html"
        else:
            relative = path.lstrip("/")
            if relative.split("/")[0] not in PUBLIC_DIRS:
                return self._not_found()
        try:
            full = os.path.normpath(os.path.join(BASE_DIR, relative))
            inside = os.path.commonpath([full, BASE_DIR]) == BASE_DIR
        except ValueError:
            inside = False
        extension = os.path.splitext(full)[1].lower() if inside else ""
        if not inside or extension not in CONTENT_TYPES or not os.path.isfile(full):
            return self._not_found()
        with open(full, "rb") as f:
            body = f.read()
        self._headers(200, CONTENT_TYPES[extension], len(body))
        self.wfile.write(body)

    def _not_found(self):
        body = b"Not found"
        self._headers(404, "text/plain; charset=utf-8", len(body))
        self.wfile.write(body)

    # ---------- HTTP methods ----------

    def do_OPTIONS(self):
        self._headers(204, "text/plain", 0)

    def do_GET(self):
        path = urlparse(self.path).path
        if path.startswith("/api/"):
            self._handle_api("GET", path)
        else:
            self._static(path)

    def do_POST(self):
        path = urlparse(self.path).path
        if path.startswith("/api/"):
            self._handle_api("POST", path)
        else:
            self._not_found()


# ----------------------------------------------------------------------
# TERMINAL DATABASE COMMANDS
# ----------------------------------------------------------------------

def print_table(headers, rows):
    def cell(value):
        text = "" if value is None else str(value).replace("\n", " ")
        return text if len(text) <= 40 else text[:37] + "..."

    data = [[cell(v) for v in row] for row in rows]
    widths = [len(h) for h in headers]
    for row in data:
        for i, value in enumerate(row):
            widths[i] = max(widths[i], len(value))

    def line(values):
        return " | ".join(v.ljust(widths[i]) for i, v in enumerate(values))

    print(line(headers))
    print("-+-".join("-" * w for w in widths))
    for row in data:
        print(line(row))
    print("(%d row%s)" % (len(data), "" if len(data) == 1 else "s"))


def run_query(query):
    """Run a read-only query and print the result as a table."""
    init_db()
    conn = connect(read_only=True)
    try:
        cur = conn.execute(query)
        if cur.description is None:
            print("Done.")
        else:
            print_table([d[0] for d in cur.description], [tuple(r) for r in cur.fetchall()])
    except sqlite3.Error as e:
        print("SQL error: %s" % e)
        if "readonly" in str(e).lower():
            print("(the terminal is read-only, use it to look at data, not change it)")
    finally:
        conn.close()


def show_tables(which="all"):
    which = which.strip().lower() or "all"
    if which not in ("all", "applications", "payments"):
        print("Use:  show   |   show applications   |   show payments")
        return
    if which in ("all", "applications"):
        print("\nAPPLICATIONS")
        run_query("SELECT id, app_code, service, applicant_name, national_id, address, status, created_at "
                  "FROM applications ORDER BY id")
    if which in ("all", "payments"):
        print("\nPAYMENTS")
        run_query("SELECT id, txn_code, payment_type, reference_no, amount, method, status, created_at "
                  "FROM payments ORDER BY id")
    print()


HELP = """
Commands:
  show                      show applications and payments
  show applications         show only applications
  show payments             show only payments
  sql <query>               run a read-only SQL query, for example:
                              sql SELECT * FROM payments WHERE amount > 1000
                              sql SELECT status, COUNT(*) FROM applications GROUP BY status
  tables                    show the table structure
  help                      show this list
  quit                      stop the server
"""


def prompt_loop(httpd):
    print("Type  help  for database commands.  Press Ctrl+C or type  quit  to stop.\n")
    while True:
        try:
            line = input("govshield> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return
        if not line:
            continue
        command, _, rest = line.partition(" ")
        command = command.lower()
        if command in ("quit", "exit", "stop"):
            return
        elif command == "help":
            print(HELP)
        elif command == "show":
            show_tables(rest)
        elif command == "sql":
            if rest.strip():
                run_query(rest)
            else:
                print("Usage:  sql SELECT * FROM payments")
        elif command == "tables":
            run_query("SELECT name AS table_name, sql AS structure FROM sqlite_master WHERE type = 'table' "
                      "AND name NOT LIKE 'sqlite_%'")
        else:
            print("Unknown command. Type  help  to see the list.")


def start_server(host, port):
    init_db()
    try:
        httpd = ThreadingHTTPServer((host, port), Handler)
    except OSError as e:
        print("Could not start on port %d: %s" % (port, e))
        print("Another program may be using it. Try:  python server.py --port %d" % (port + 1))
        sys.exit(1)

    print("=" * 60)
    print(" GovShield server is running")
    print("   Portal   : http://localhost:%d" % port)
    print("   Database : %s" % DB_PATH)
    print("=" * 60)

    if sys.stdin is not None and sys.stdin.isatty():
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        try:
            prompt_loop(httpd)
        finally:
            httpd.shutdown()
            httpd.server_close()
    else:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            httpd.server_close()
    print("Server stopped.")


def main():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")    # stops Windows consoles crashing on Bengali text
        except Exception:
            pass

    parser = argparse.ArgumentParser(description="GovShield portal server and database")
    parser.add_argument("command", nargs="?", default="run", choices=["run", "show", "sql", "reset"],
                        help="run (default) | show [applications|payments] | sql \"QUERY\" | reset")
    parser.add_argument("args", nargs="*", help="extra words for show / sql")
    parser.add_argument("--port", type=int, default=8000, help="port number (default 8000)")
    parser.add_argument("--host", default="127.0.0.1", help="address to listen on (default 127.0.0.1, this computer only)")
    options = parser.parse_args()

    if options.command == "run":
        start_server(options.host, options.port)
    elif options.command == "show":
        init_db()
        show_tables(" ".join(options.args))
    elif options.command == "sql":
        if not options.args:
            print('Usage:  python server.py sql "SELECT * FROM payments"')
            sys.exit(1)
        run_query(" ".join(options.args))
    elif options.command == "reset":
        answer = input("This deletes ALL applications and payments. Type YES to continue: ")
        if answer.strip() == "YES":
            reset_db()
            print("Database reset. Demo applications restored.")
        else:
            print("Cancelled. Nothing was deleted.")


if __name__ == "__main__":
    main()
